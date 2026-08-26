#!/usr/bin/env node
// Scan coding-agent logs into days of threads for the UI.
// Generates ui/public/day-YYYY-MM-DD.json for today and the past week,
// plus day.json (= today) and days.json (index of available dates).
//
// Providers (Claude Code, Codex, …) live in scripts/providers/ — one module
// per CLI, discovered automatically. This file orchestrates: it hands each
// provider a scan context, collects normalized sessions, and shapes them
// into per-day JSON. See scripts/providers/README.md to add a provider.

import { writeFileSync, readFileSync, mkdirSync, statSync, readdirSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { makeDayWindow, scanFile, waitTracker, turnTracker, codeTracker, tokenTracker, CWD_RE } from './lib/scan-core.mjs'
import { CACHE_ROOT } from './lib/fastscan.mjs'
import { PROVIDERS, providerById } from './providers/index.mjs'

const HOME = homedir()
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = process.env.DAYFLOW_OUT ?? join(ROOT, 'ui', 'public')
const now = new Date()
const dateArg = process.argv.indexOf('--date')
const TARGET_DATE = dateArg >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[dateArg + 1] ?? '')
  ? process.argv[dateArg + 1]
  : null
// --today: a quick partial pass — only files touched since today began, only
// today's JSON written, cache left intact — so the dashboard can open on
// today while a full pass backfills history in the background
const TODAY_ONLY = process.argv.includes('--today')
// All history by default (Claude Code prunes its own transcripts after ~30
// days; Codex keeps everything). DAYFLOW_DAYS_BACK caps it.
const DAYS_BACK = TODAY_ONLY || TARGET_DATE ? 0 : Number(process.env.DAYFLOW_DAYS_BACK ?? 3650)

const GAP_MIN = 30 // split a session into activity segments at idle gaps this long
const MIN_BLOCK_MIN = 5
// segments of the SAME session separated by less than this stay one thread —
// drawn as solid stretches joined by a faint connector. Beyond it (a morning
// session resumed at night) the session splits into separate threads.
const JOIN_SESSION_MIN = 120
const ACTIVE_WINDOW_MIN = 15
const SLOTS = ['research', 'seo', 'agent-tooling', 'swift', 'personal', 'pixel-art']

const windowNow = TARGET_DATE ? new Date(`${TARGET_DATE}T12:00:00`) : now
const { dayKeys, daySet, todayKey, localTime } = makeDayWindow(windowNow, DAYS_BACK)
const actualTodayKey = makeDayWindow(now, 0).todayKey

// everything a provider's scan() needs: the day window and the shared
// trackers — so a provider module is just discovery + parsing
const scanCtx = { HOME, dayKeys, daySet, todayKey, localTime, scanFile, waitTracker, turnTracker, codeTracker, tokenTracker, CWD_RE, prune: !TODAY_ONLY }

// days.json is polled while a backfill is running. Atomic replacement keeps a
// reader from ever catching a half-written index, and the monotonically
// increasing revision lets the UI notice summary-only progress updates.
let indexRevision = Date.now() * 1000
function writeDayIndex(index) {
  const path = join(OUT_DIR, 'days.json')
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...index, revision: ++indexRevision }, null, 2))
  renameSync(tmp, path)
}

// what the calendar popover shows per day: agent count and priced spend
function daySummary(day) {
  const cost = day.tokens?.cost
  return {
    agents: day.threads.filter((t) => !t.dotted).length,
    cost: cost ? +((cost.openai ?? 0) + (cost.claude ?? 0)).toFixed(2) : 0,
  }
}

// ---- pricing ----------------------------------------------------------------
// LiteLLM's community price table, keyed by the exact model ids the logs carry,
// with per-token rates for every bucket. Fetched fresh each scan; the last
// good copy is cached (DAYFLOW_PRICE_CACHE, else beside this script) so
// offline scans still price. The copy beside this script also ships in the
// npm package as a seed for first runs with no network.
const PRICE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const PRICE_SEED = join(SCRIPTS_DIR, 'model-prices-cache.json')
const PRICE_CACHE = process.env.DAYFLOW_PRICE_CACHE ?? PRICE_SEED
// refetching the table on every scan puts a network round-trip on the warm
// path for a file that changes a few times a week — trust a recent cache
// (DAYFLOW_PRICE_TTL_H=0 forces a fetch)
const PRICE_TTL_H = Number(process.env.DAYFLOW_PRICE_TTL_H ?? 6)
const sha1 = (s) => createHash('sha1').update(s).digest('hex')
async function loadPrices() {
  try {
    if (PRICE_TTL_H > 0 && Date.now() - statSync(PRICE_CACHE).mtimeMs < PRICE_TTL_H * 3600e3) {
      const txt = readFileSync(PRICE_CACHE, 'utf8')
      return { table: JSON.parse(txt), hash: sha1(txt) }
    }
  } catch {}
  try {
    const res = await fetch(PRICE_URL, { signal: AbortSignal.timeout(15000) })
    if (res.ok) {
      const txt = await res.text()
      const table = JSON.parse(txt) // parse before caching a bad body
      writeFileSync(PRICE_CACHE, txt)
      return { table, hash: sha1(txt) }
    }
  } catch {}
  for (const f of [PRICE_CACHE, PRICE_SEED]) {
    try {
      const txt = readFileSync(f, 'utf8')
      return { table: JSON.parse(txt), hash: sha1(txt) }
    } catch {}
  }
  console.warn('warning: no price table (fetch failed, no cache) — costs will be omitted')
  return { table: {}, hash: 'none' }
}

/** Price one { model → buckets } aggregate. A provider whose logs carry
 *  tier-tagged model keys (e.g. Codex's ' long' / ' fast' suffixes) prices
 *  them via its own modelCost hook; everything else uses the LiteLLM table.
 *  Cache reads bill at a tenth of fresh input, which is most of the spend on
 *  long agent sessions. */
function costOf(byModel, providerId) {
  let usd = 0
  let unpricedTok = 0 // tokens whose model the table doesn't know
  const override = providerById.get(providerId)?.modelCost
  for (const [m, b] of Object.entries(byModel ?? {})) {
    const own = override?.(m, b, PRICES)
    if (own) {
      usd += own.usd ?? 0
      unpricedTok += own.unpriced ?? 0
      continue
    }
    const p = PRICES[m]
    if (!p) {
      unpricedTok += b.i + b.cw + b.cr + b.o
      continue
    }
    const cw5m = p.cache_creation_input_token_cost ?? p.input_cost_per_token ?? 0
    // b.cw is the TOTAL cache write; b.c1 is the 1-hour-TTL portion inside it,
    // billed at the above-1hr rate (2× input) instead of the 5m rate (1.25×)
    const c1 = Math.min(b.c1 ?? 0, b.cw)
    usd += b.i * (p.input_cost_per_token ?? 0)
      + b.cw * cw5m
      + c1 * ((p.cache_creation_input_token_cost_above_1hr ?? cw5m) - cw5m)
      + b.cr * (p.cache_read_input_token_cost ?? p.input_cost_per_token ?? 0)
      + b.o * (p.output_cost_per_token ?? 0)
  }
  return { usd, unpricedTok }
}

// ---- shape one day ---------------------------------------------------------
// cwds that aren't a real project: home/root/temp — headless `claude -p`
// runs from scripts, LaunchAgents, cron etc. usually land here
const JUNK_CWDS = new Set([HOME, '/', '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp',
  // bare home folders are a launch location, not a project
  ...['Documents', 'Desktop', 'Downloads'].map((d) => join(HOME, d))])
const TEMP_RE = /^(\/private)?\/var\/folders\//

/** honest folder name: the cwd's last path segment; junk cwds → Other */
// segments that aren't a real project name: session UUIDs and URL slugs
// (the cwd fallback derives from the .claude dir name, which can be either)
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}/
const URLISH_RE = /^(https?|www)|-com\b|\.com/
function projectName(cwd) {
  if (JUNK_CWDS.has(cwd) || TEMP_RE.test(cwd)) return 'Other'
  const parts = cwd.split('/').filter(Boolean)
  let seg = parts[parts.length - 1] || 'Other'
  // Codex scratch dirs (~/Documents/Codex/<date>/<prompt-stub>): the leaf is
  // the first words of the prompt ("do", "loo", "can-u"), not a project
  if (parts[parts.length - 2]?.match(/^\d{4}-\d{2}-\d{2}$/) || parts.includes('Codex')) return 'Other'
  if (UUID_RE.test(seg) || URLISH_RE.test(seg)) return 'Other'
  // prompt-slug folders (scheduled-task cwds, dated chat exports): 4+ dashes
  // is a sentence, not a project
  if ((seg.match(/-/g) ?? []).length >= 4) return 'Other'
  if (seg.length > 18) seg = seg.slice(0, 17).trimEnd() + '…'
  return seg
}

function fmtDuration(hours) {
  const mins = Math.round(hours * 60)
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} hr ${mins % 60} min`
}
function fmtClock(h) {
  const mins = Math.round(h * 60)
  let hh = Math.floor(mins / 60) % 24
  const mm = mins % 60
  const ap = hh < 12 ? 'AM' : 'PM'
  hh = hh % 12 || 12
  return `${hh}:${String(mm).padStart(2, '0')} ${ap}`
}

function shapeDay(key, sessions) {
  const isToday = key === actualTodayKey
  const providerIds = PROVIDERS.map((p) => p.id)
  // subagent count per parent session, for the parent's tooltip
  const subsOf = new Map()
  for (const s of sessions) {
    if (s.sub && s.parentId && s.byDay.get(key)?.length)
      subsOf.set(s.parentId, (subsOf.get(s.parentId) ?? 0) + 1)
  }
  const blocks = []
  for (const s of sessions) {
    if (s.sub) continue // subagents: no arc, no waits, no turns — totals only
    const ts = [...(s.byDay.get(key) ?? [])].sort((a, b) => a - b)
    if (!ts.length) continue
    // activity segments: contiguous minute clusters split at GAP_MIN silences,
    // sub-minimum clusters dropped (their tokens still land in day totals)
    const segs = []
    let start = ts[0]
    let prev = ts[0]
    const flushSeg = (end) => {
      if (end - start >= MIN_BLOCK_MIN) segs.push([start, Math.max(end, start + MIN_BLOCK_MIN)])
    }
    for (const t of ts.slice(1)) {
      if (t - prev > GAP_MIN) { flushSeg(prev); start = t }
      prev = t
    }
    flushSeg(prev)
    // one thread per run of segments whose gaps stay under JOIN_SESSION_MIN —
    // its duration is the SUM of segments, never the wall-clock span, so a
    // session poked at 2pm and 5pm doesn't book three hours of agent time
    let group = []
    const flushGroup = () => {
      if (!group.length) return
      const g0 = group[0][0]
      const g1 = group[group.length - 1][1]
      // waits (user follow-up → answer done) that fall inside this thread,
      // converted from minutes to hours like everything downstream
      const waits = (s.waitsByDay?.get(key) ?? [])
        .filter(([u, a]) => u >= g0 - 1 && a <= g1 + 1)
        .map(([u, a]) => [u / 60, a / 60])
      const code = (s.codeByDay?.get(key) ?? [])
        .filter(([m]) => m >= g0 - 1 && m <= g1 + 1)
        .map(([m, a, d]) => [m / 60, a, d])
      // token buckets aggregated per model, so cost math keeps each
      // bucket at its own rate; `tok` stays the grand total
      const tokByModel = {}
      let tok = 0
      for (const [, b2, model] of (s.tokByDay?.get(key) ?? [])
        .filter(([m]) => m >= g0 - 1 && m <= g1 + 1)) {
        const agg = tokByModel[model] ?? (tokByModel[model] = { i: 0, cw: 0, cr: 0, o: 0, c1: 0 })
        agg.i += b2.i; agg.cw += b2.cw; agg.cr += b2.cr; agg.o += b2.o; agg.c1 += b2.c1 ?? 0
        tok += b2.i + b2.cw + b2.cr + b2.o
      }
      const turnCount = (s.turnsByDay?.get(key) ?? [])
        .filter((m) => m >= g0 - 1 && m <= g1 + 1).length
      blocks.push({ start: g0 / 60, end: g1 / 60,
        segments: group.map(([a, b]) => [a / 60, b / 60]),
        dur: group.reduce((acc, [a, b]) => acc + (b - a), 0) / 60,
        waits, code, tok, tokByModel, turns: turnCount, subs: subsOf.get(s.id) ?? 0,
        sids: [s.id],
        models: s.models ?? [],
        provider: s.provider, project: projectName(s.cwd), title: s.title, summary: s.summary,
        files: s.file ? [s.file] : [] })
      group = []
    }
    for (const seg of segs) {
      if (group.length && seg[0] - group[group.length - 1][1] > JOIN_SESSION_MIN) flushGroup()
      group.push(seg)
    }
    flushGroup()
  }

  // totals are agent-hours (parallel sessions add up); dur counts only the
  // active segments, not the joined-over gaps
  const totals = new Map()
  for (const b of blocks) totals.set(b.project, (totals.get(b.project) ?? 0) + b.dur)

  // merging is OFF (-Infinity): every session's block draws its own arc, and
  // the UI's min-length filter hides short arcs instead of fusing distinct
  // threads into anonymous bands. Restore a positive value (hours) to merge
  // same-project+provider arcs that close together again.
  const JOIN_H = -Infinity
  const grouped = new Map()
  for (const b of blocks) {
    const k = `${b.project}\u0000${b.provider}`
    ;(grouped.get(k) ?? grouped.set(k, []).get(k)).push(b)
  }
  blocks.length = 0
  for (const list of grouped.values()) {
    list.sort((a, b) => a.start - b.start)
    let cur = { ...list[0], sessions: 1 }
    for (const b of list.slice(1)) {
      if (b.start <= cur.end + JOIN_H) {
        cur.end = Math.max(cur.end, b.end)
        cur.segments = [...cur.segments, ...b.segments]
        cur.dur += b.dur
        cur.sessions += 1
        cur.waits = [...cur.waits, ...b.waits]
        cur.code = [...cur.code, ...b.code]
        cur.tok += b.tok
        cur.turns += b.turns
        cur.tokByModel = { ...cur.tokByModel }
        for (const [m, v] of Object.entries(b.tokByModel)) {
          const agg = cur.tokByModel[m] ?? (cur.tokByModel[m] = { i: 0, cw: 0, cr: 0, o: 0, c1: 0 })
          agg.i += v.i; agg.cw += v.cw; agg.cr += v.cr; agg.o += v.o; agg.c1 += v.c1 ?? 0
        }
        cur.models = [...new Set([...cur.models, ...b.models])]
        cur.sids = [...new Set([...cur.sids, ...b.sids])]
        // a merged band only keeps a title if every session agrees — one
        // session's title speaking for 99 parallel runs reads as a bug
        if (b.title !== cur.title) cur.title = null
        if (b.summary !== cur.summary) cur.summary = null
        cur.files = [...new Set([...cur.files, ...b.files])]
      } else {
        blocks.push(cur)
        cur = { ...b, sessions: 1 }
      }
    }
    blocks.push(cur)
  }
  // rank real projects into the first five slots; junk-cwd sessions and any
  // overflow projects share the pinned Other slot (never a top slot)
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1])
  const real = ranked.filter(([n]) => n !== 'Other')
  const slotOf = new Map()
  const labels = {}
  const othersNeeded = totals.has('Other') || real.length > 6
  real.forEach(([name], i) => {
    if (i < 5 || (i === 5 && !othersNeeded)) {
      const slot = SLOTS[i]
      slotOf.set(name, slot)
      labels[slot] = name
    } else {
      slotOf.set(name, SLOTS[5])
      labels[SLOTS[5]] = 'Other'
    }
  })
  if (totals.has('Other')) {
    slotOf.set('Other', SLOTS[5])
    labels[SLOTS[5]] = 'Other'
  }

  blocks.sort((a, b) => a.start - b.start)
  let nowH = now.getHours() + now.getMinutes() / 60
  if (nowH < 4) nowH += 24 // pre-4AM "now" lives on yesterday's dial
  // One groove per agent (lane 0 = outermost, earliest start). Above six
  // threads, non-overlapping agents from the same project may reuse a groove.
  // Above twelve, project identity no longer constrains reuse. Every reuse
  // still requires a strictly greater than ten-minute visible gap.
  const PACK_THRESHOLD = 6
  const CROSS_PROJECT_PACK_THRESHOLD = 12
  const LANE_GAP_H = 10 / 60
  let lanes
  if (blocks.length > PACK_THRESHOLD) {
    const grooves = [] // per-groove: project + last occupied end hour
    const crossProject = blocks.length > CROSS_PROJECT_PACK_THRESHOLD
    lanes = blocks.map((b) => {
      const g = grooves.findIndex((v) =>
        (crossProject || v.project === b.project) && v.end + LANE_GAP_H < b.start)
      if (g >= 0) {
        grooves[g] = { project: b.project, end: b.end }
        return g
      }
      grooves.push({ project: b.project, end: b.end })
      return grooves.length - 1
    })
  } else {
    lanes = blocks.map((_, i) => i)
  }
  const threads = blocks.map((b, i) => {
    const lane = lanes[i]
    const active = isToday && b.end >= nowH - ACTIVE_WINDOW_MIN / 60
    const title = b.title ?? b.summary
    const bits = []
    if (b.sessions > 1) bits.push(`${b.sessions} agents`)
    if (b.segments.length > 1) bits.push(`${b.segments.length} stretches`)
    if (b.turns > 1) bits.push(`${b.turns} turns`)
    if (b.subs) bits.push(`${b.subs} subagent${b.subs > 1 ? 's' : ''}`)
    const merged = bits.length ? ` (${bits.join(' · ')})` : ''
    // waits become fractions of the thread's own span, clamped to it
    const span = b.end - b.start
    const blockedRanges = b.waits
      .map(([u, a]) => [Math.max(0, +((u - b.start) / span).toFixed(4)), Math.min(1, +((a - b.start) / span).toFixed(4))])
      .filter(([f0, f1]) => f1 > f0)
    return {
      id: `s${i}`, category: slotOf.get(b.project), provider: b.provider,
      start: +b.start.toFixed(3), end: +b.end.toFixed(3), lane,
      // multi-stretch sessions: solid arcs joined by a faint connector; the
      // UI sums these for durations instead of end - start
      ...(b.segments.length > 1 ? { segments: b.segments.map(([a2, b2]) => [+a2.toFixed(3), +b2.toFixed(3)]) } : {}),
      state: active ? 'active' : 'done',
      ...(blockedRanges.length ? { blockedRanges } : {}),
      title: title ? title.slice(0, 90) + merged
        : b.sessions > 1 ? `${b.sessions} parallel agents · ${b.turns} turns` : undefined,
      summary: b.summary ? b.summary.slice(0, 140) : undefined,
    }
  })

  const donut = SLOTS.filter((s) => labels[s]).map((slot) => ({
    category: slot,
    hours: +[...totals.entries()].filter(([n]) => slotOf.get(n) === slot)
      .reduce((acc, [, h]) => acc + h, 0).toFixed(3),
  }))

  const hoursBy = (p) => blocks.filter((b) => b.provider === p).reduce((a, b) => a + b.dur, 0)
  const tooltipThread = threads.filter((t) => t.summary && t.state === 'active').at(-1)
    ?? threads.filter((t) => t.summary).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
  const dateObj = new Date(`${key}T12:00:00`)
  const pretty = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const weekday = dateObj.toLocaleDateString('en-US', { weekday: 'short' })

  // dial window: actual activity span, rounded outward to the half hour,
  // never earlier than 4 AM and never later than 4 AM the next day
  let dayStart = 8
  let dayEnd = 20
  if (threads.length) {
    // pad 15 min before rounding so the window edge never sits flush on the
    // first/last arc — an arc ending at 2:10 gets an End notch at 2:30, not
    // one it collides with at 2:00 or grazes at 2:30 exactly
    dayStart = Math.max(4, Math.floor((Math.min(...threads.map((t) => t.start)) - 0.25) * 2) / 2)
    dayEnd = Math.min(28, Math.ceil((Math.max(...threads.map((t) => t.end)) + 0.25) * 2) / 2)
    if (dayEnd - dayStart < 2) dayEnd = dayStart + 2
  }

  // lines +/− straight from the logs' diffs: per-project totals for the
  // panel's list, and a 10-minute-bucket series over the dial window for
  // the bar chart
  // aggregate from raw sessions, not rendered blocks: subagent transcripts
  // and sub-minimum blocks draw nothing but their code output is real
  const codeByProject = new Map()
  for (const s of sessions) {
    const agg = codeByProject.get(projectName(s.cwd)) ?? { add: 0, del: 0 }
    for (const [, a, d] of s.codeByDay?.get(key) ?? []) { agg.add += a; agg.del += d }
    codeByProject.set(projectName(s.cwd), agg)
  }
  const codeTotals = SLOTS.filter((sl) => labels[sl]).map((slot) => {
    let add = 0
    let del = 0
    for (const [name, v] of codeByProject) {
      if (slotOf.get(name) === slot) { add += v.add; del += v.del }
    }
    return { category: slot, add, del }
  })
  // real token usage from the logs, split by provider and by project slot,
  // plus the model ids that actually ran. Cost is each bucket priced at its
  // model's own rate — see costOf.
  // Subagent rollouts bill to the thread that spawned them: fold each sub's
  // token buckets into the parent's block (matched by minute, nearest block
  // as fallback) so the per-thread cost covers the whole fleet. Day totals
  // are untouched — they already sum subs from the raw sessions.
  const blocksOfParent = new Map()
  for (const b of blocks) {
    for (const sid of b.sids) {
      const list = blocksOfParent.get(sid) ?? blocksOfParent.set(sid, []).get(sid)
      list.push(b)
    }
  }
  for (const s of sessions) {
    if (!s.sub || !s.parentId) continue
    const cands = blocksOfParent.get(s.parentId)
    if (!cands?.length) continue
    for (const [m, b2, model] of s.tokByDay?.get(key) ?? []) {
      const near = (c) => Math.min(Math.abs(c.start * 60 - m), Math.abs(c.end * 60 - m))
      const b = cands.find((c) => m >= c.start * 60 - 1 && m <= c.end * 60 + 1)
        ?? cands.reduce((best, c) => (near(c) < near(best) ? c : best))
      const agg = b.tokByModel[model] ?? (b.tokByModel[model] = { i: 0, cw: 0, cr: 0, o: 0 })
      agg.i += b2.i; agg.cw += b2.cw; agg.cr += b2.cr; agg.o += b2.o
      b.tok += b2.i + b2.cw + b2.cr + b2.o
    }
  }
  for (const b of blocks) {
    const c = costOf(b.tokByModel, b.provider)
    b.usd = c.usd
    b.unpricedTok = c.unpricedTok
  }
  // per-thread cost for the hover tooltip; threads are index-aligned with
  // blocks (threads = blocks.map above)
  threads.forEach((t, i) => {
    if (blocks[i].usd > 0) t.usd = +blocks[i].usd.toFixed(4)
  })
  // day totals come from the RAW per-session events, not the blocks: blocks
  // drop sessions shorter than MIN_BLOCK_MIN and clip events outside their
  // window, which silently loses short headless runs and subagent bursts
  // (that gap was ~4x on heavy days when reconciled against ccusage)
  const addBucket = (bm, model, b2) => {
    const agg = bm[model] ?? (bm[model] = { i: 0, cw: 0, cr: 0, o: 0, c1: 0 })
    agg.i += b2.i; agg.cw += b2.cw; agg.cr += b2.cr; agg.o += b2.o; agg.c1 += b2.c1 ?? 0
  }
  const dayAgg = {} // provider → model → buckets
  for (const p of providerIds) dayAgg[p] = {}
  const tokByProject = new Map()
  for (const s of sessions) {
    const prov = s.provider
    const proj = projectName(s.cwd)
    for (const [, b2, model] of s.tokByDay?.get(key) ?? []) {
      addBucket(dayAgg[prov] ?? (dayAgg[prov] = {}), model, b2)
      const pa = tokByProject.get(proj) ?? tokByProject.set(proj, {}).get(proj)
      addBucket(pa[prov] ?? (pa[prov] = {}), model, b2)
    }
  }
  const sumTok = (bm) => Object.values(bm ?? {}).reduce((a, b) => a + b.i + b.cw + b.cr + b.o, 0)
  const tokBy = (p) => sumTok(dayAgg[p])
  const usdBy = (p) => costOf(dayAgg[p], p).usd
  const tokenTotals = SLOTS.filter((sl) => labels[sl]).map((slot) => {
    const byProv = {}
    for (const [name, v] of tokByProject) {
      // sessions with no rendered block have no slot — they belong to Other
      if ((slotOf.get(name) ?? SLOTS[5]) === slot) {
        for (const [prov, bm] of Object.entries(v)) {
          const agg = byProv[prov] ?? (byProv[prov] = { tok: 0, cost: 0 })
          agg.tok += sumTok(bm)
          agg.cost += costOf(bm, prov).usd
        }
      }
    }
    return {
      category: slot,
      // legacy two-provider fields the current UI reads
      openai: byProv.openai?.tok ?? 0,
      claude: byProv.claude?.tok ?? 0,
      openaiCost: +(byProv.openai?.cost ?? 0).toFixed(4),
      claudeCost: +(byProv.claude?.cost ?? 0).toFixed(4),
      byProvider: Object.fromEntries(Object.entries(byProv).map(([p2, v2]) => [p2, { tok: v2.tok, cost: +v2.cost.toFixed(4) }])),
    }
  })
  // '<synthetic>' is Claude Code's internal placeholder, not a model that ran;
  // model keys may carry space-separated tier tags — strip to the base id
  const modelsFor = (p) => [...new Set(Object.keys(dayAgg[p] ?? {}).map((m) => m.split(' ')[0]))]
    .filter((m) => !m.startsWith('<') && m !== 'unknown')

  const NB = Math.max(Math.round((dayEnd - dayStart) * 6), 12)
  const codeAdd = Array(NB).fill(0)
  const codeDel = Array(NB).fill(0)
  for (const s of sessions) {
    for (const [m, a, d] of s.codeByDay?.get(key) ?? []) {
      const h = m / 60
      const i = Math.min(NB - 1, Math.max(0, Math.floor(((h - dayStart) / (dayEnd - dayStart)) * NB)))
      codeAdd[i] += a
      codeDel[i] += d
    }
  }

  const allTok = providerIds.reduce((a, p) => a + tokBy(p), 0)
  const allUnpriced = providerIds.reduce((a, p) => a + costOf(dayAgg[p], p).unpricedTok, 0)

  return {
    generatedAt: now.toISOString(),
    date: key,
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name })),
    grooves: threads.length ? Math.max(...threads.map((t) => t.lane)) + 1 : 0,
    threads,
    donut,
    labels,
    codeTotals,
    code: { start: dayStart, end: dayEnd, add: codeAdd, del: codeDel },
    tokens: {
      // legacy two-provider fields the current UI reads (kept in sync with
      // byProvider below until the UI goes registry-driven)
      openai: tokBy('openai'),
      claude: tokBy('claude'),
      // `priced` is a coverage test, not all-or-nothing: internal aliases like
      // codex-auto-review aren't in the table, and hiding a day's dollars
      // over a sliver would be worse than a ≤1% undercount
      cost: {
        openai: +usdBy('openai').toFixed(4),
        claude: +usdBy('claude').toFixed(4),
        priced: Object.keys(PRICES).length > 0 && allUnpriced <= 0.01 * Math.max(allTok, 1),
      },
      models: { openai: modelsFor('openai'), claude: modelsFor('claude') },
      byProvider: Object.fromEntries(providerIds.map((p) => [p, {
        tok: tokBy(p),
        cost: +usdBy(p).toFixed(4),
        models: modelsFor(p),
      }])),
      byCategory: tokenTotals,
    },
    meta: {
      dateLabel: isToday ? `Today, ${pretty}` : `${weekday}, ${pretty}`,
      claudeTotal: fmtDuration(hoursBy('claude')),
      openaiTotal: fmtDuration(hoursBy('openai')),
      providerTotals: Object.fromEntries(providerIds.map((p) => [p, fmtDuration(hoursBy(p))])),
      tooltipThread: tooltipThread?.id ?? '',
      tooltipTime: tooltipThread ? `${fmtClock(tooltipThread.start)} - ${fmtClock(tooltipThread.end)}` : '',
      dayStart,
      dayEnd,
      startLabel: fmtClock(dayStart),
      endLabel: fmtClock(dayEnd),
    },
  }
}

// ---- run -------------------------------------------------------------------
// kick the price-table fetch off first so any network round-trip overlaps the
// log scan instead of serializing in front of it
const pricesPromise = loadPrices()

// Incremental days: a day JSON only changes when a log file touching that day
// changed, so recompute just those (plus today, whose "active" flags and
// dateLabel depend on now). Anything that could invalidate the shortcut —
// the window moved, the price table changed, the scanner code itself changed,
// a provider can't report dirt, or the previous run died mid-write — falls
// back to a full pass over all days.
const STATE_PATH = join(CACHE_ROOT, 'state.json')
const scriptsSig = [SCRIPTS_DIR, join(SCRIPTS_DIR, 'lib'), join(SCRIPTS_DIR, 'providers')]
  .flatMap((d) => readdirSync(d).filter((x) => x.endsWith('.mjs')).sort()
    .map((f) => { const st = statSync(join(d, f)); return `${f}:${st.mtimeMs}:${st.size}` }))
  .join('|')
let state = null
try { state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch {}

// phase A per provider: cache resolution + extraction + dirty-day report
const plans = []
for (const p of PROVIDERS) plans.push(p.plan ? await p.plan(scanCtx) : null)
const { table: PRICES, hash: priceHash } = await pricesPromise

// the days that actually have activity (from the per-file record index) plus
// today — the window is only a discovery bound, the output is data-driven
const activeSet = new Set([todayKey])
for (const pl of plans) if (pl) for (const e of Object.values(pl.index)) for (const d of e.d ?? []) if (daySet.has(d)) activeSet.add(d)
const activeDays = [...activeSet].sort()

if (TARGET_DATE) {
  mkdirSync(OUT_DIR, { recursive: true })
  const sessions = []
  for (let i = 0; i < PROVIDERS.length; i++) {
    const got = plans[i]
      ? PROVIDERS[i].finish(plans[i], scanCtx, new Set([TARGET_DATE]))
      : await PROVIDERS[i].scan(scanCtx)
    for (const s of got) sessions.push({ ...s, provider: PROVIDERS[i].id })
  }
  const day = shapeDay(TARGET_DATE, sessions)
  writeFileSync(join(OUT_DIR, `day-${TARGET_DATE}.json`), JSON.stringify(day, null, 2))
  if (TARGET_DATE === actualTodayKey) writeFileSync(join(OUT_DIR, 'day.json'), JSON.stringify(day, null, 2))

  let prev = null
  try { prev = JSON.parse(readFileSync(join(OUT_DIR, 'days.json'), 'utf8')) } catch {}
  const days = [...new Set([...(prev?.days ?? []), TARGET_DATE])].sort()
  const loading = (prev?.loading ?? []).filter((d) => d !== TARGET_DATE)
  writeDayIndex({
    days,
    today: actualTodayKey,
    partial: true,
    loading,
    projectColorOrder: prev?.projectColorOrder ?? [],
    summary: { ...(prev?.summary ?? {}), [TARGET_DATE]: daySummary(day) },
  })
  console.log(`${TARGET_DATE}: ${day.threads.length} threads on ${day.grooves} grooves · ${PROVIDERS.map((p) => `${p.name.toLowerCase()} ${day.meta.providerTotals[p.id]}`).join(' · ')} (single day)`)
  process.exit(0)
}

if (TODAY_ONLY) {
  mkdirSync(OUT_DIR, { recursive: true })
  const sessions = []
  for (let i = 0; i < PROVIDERS.length; i++) {
    const got = PROVIDERS[i].finish(plans[i], scanCtx, new Set([todayKey]))
    for (const s of got) sessions.push({ ...s, provider: PROVIDERS[i].id })
  }
  const day = shapeDay(todayKey, sessions)
  writeFileSync(join(OUT_DIR, `day-${todayKey}.json`), JSON.stringify(day, null, 2))
  writeFileSync(join(OUT_DIR, 'day.json'), JSON.stringify(day, null, 2))
  console.log(`${todayKey}: ${day.threads.length} threads on ${day.grooves} grooves · ${PROVIDERS.map((p) => `${p.name.toLowerCase()} ${day.meta.providerTotals[p.id]}`).join(' · ')} (today only)`)
  // keep whatever history the last full pass indexed; flag the index partial
  // so the UI knows to poll for the backfill
  let prev = null
  try { prev = JSON.parse(readFileSync(join(OUT_DIR, 'days.json'), 'utf8')) } catch {}
  const days = [...new Set([...(prev?.days ?? []), todayKey])].sort()
  writeDayIndex({
    days, today: todayKey, partial: true,
    projectColorOrder: prev?.projectColorOrder ?? [],
    summary: { ...(prev?.summary ?? {}), [todayKey]: daySummary(day) },
  })
  process.exit(0)
}

const full = process.env.DAYFLOW_FULL === '1'
  || !state
  || state.priceHash !== priceHash
  || state.scriptsSig !== scriptsSig
  || plans.some((pl) => pl === null || pl.unknownOld)

mkdirSync(OUT_DIR, { recursive: true })
let needed = null // null = recompute every day
if (!full) {
  needed = new Set(state.pending ?? []) // journal from an interrupted run
  for (const pl of plans) for (const d of pl.dirtyDays) needed.add(d)
  needed.add(todayKey)
  const known = new Set(state.dayKeys ?? [])
  for (const key of activeDays) if (!known.has(key) || !existsSync(join(OUT_DIR, `day-${key}.json`))) needed.add(key)
  for (const d of [...needed]) if (!activeSet.has(d)) needed.delete(d)
}
// journal the days about to be rewritten BEFORE writing, so a crash mid-run
// re-dirties them next time instead of trusting half-written output
writeFileSync(STATE_PATH, JSON.stringify({ ...state, pending: full ? activeDays : [...needed] }))

// Publish the whole known queue before the expensive replay/shape phase. Days
// without an existing output become visible loading cells immediately; days
// with a previous result stay usable while they are refreshed in place.
let previousIndex = null
try { previousIndex = JSON.parse(readFileSync(join(OUT_DIR, 'days.json'), 'utf8')) } catch {}
const publishedSummary = {}
const loadingDays = new Set()
for (const key of activeDays) {
  const path = join(OUT_DIR, `day-${key}.json`)
  if (!existsSync(path)) {
    loadingDays.add(key)
    continue
  }
  try { publishedSummary[key] = daySummary(JSON.parse(readFileSync(path, 'utf8'))) } catch { loadingDays.add(key) }
}
writeDayIndex({
  days: activeDays,
  today: todayKey,
  partial: true,
  loading: [...loadingDays],
  projectColorOrder: previousIndex?.projectColorOrder ?? [],
  summary: publishedSummary,
})

// phase B: replay just the sessions that touch the days being recomputed
const sessions = []
for (let i = 0; i < PROVIDERS.length; i++) {
  const p = PROVIDERS[i]
  // the orchestrator stamps the provider id — a session's provenance is
  // which module scanned it, never something the module self-reports
  const got = plans[i] ? p.finish(plans[i], scanCtx, needed) : await p.scan(scanCtx)
  for (const s of got) sessions.push({ ...s, provider: p.id })
}
// Today first, then newest to oldest. Publish after every completed day so the
// calendar fills backward one cell at a time without a page refresh.
const writeOrder = [todayKey, ...activeDays.filter((k) => k !== todayKey).reverse()]
for (const key of writeOrder) {
  if (needed && !needed.has(key)) continue
  const day = shapeDay(key, sessions)
  writeFileSync(join(OUT_DIR, `day-${key}.json`), JSON.stringify(day, null, 2))
  if (key === todayKey) writeFileSync(join(OUT_DIR, 'day.json'), JSON.stringify(day, null, 2))
  publishedSummary[key] = daySummary(day)
  loadingDays.delete(key)
  writeDayIndex({
    days: activeDays,
    today: todayKey,
    partial: true,
    loading: [...loadingDays],
    projectColorOrder: previousIndex?.projectColorOrder ?? [],
    summary: publishedSummary,
  })
  console.log(`${key}: ${day.threads.length} threads on ${day.grooves} grooves · ${PROVIDERS.map((p) => `${p.name.toLowerCase()} ${day.meta.providerTotals[p.id]}`).join(' · ')}`)
}
if (needed) console.log(`(${activeDays.length - needed.size} unchanged days skipped)`)

// Stable project-color priority: rank projects by their total priced spend
// over the latest 30 calendar files. The UI consumes this one ordering for
// every viewed day, so a project does not change color as other projects enter
// or leave the selected day's six display slots.
const projectCosts30d = new Map()
const summary = {}
for (const key of activeDays) {
  let day
  try { day = JSON.parse(readFileSync(join(OUT_DIR, `day-${key}.json`), 'utf8')) } catch { continue }
  summary[key] = daySummary(day)
  if (activeDays.indexOf(key) < activeDays.length - 30) continue
  const rows = new Map((day.tokens?.byCategory ?? []).map((r) => [r.category, r]))
  for (const [slot, project] of Object.entries(day.labels ?? {})) {
    if (!project || project === 'Other') continue
    const row = rows.get(slot)
    const providerCosts = Object.values(row?.byProvider ?? {})
    const cost = providerCosts.length
      ? providerCosts.reduce((sum, p) => sum + (Number(p?.cost) || 0), 0)
      : (Number(row?.openaiCost) || 0) + (Number(row?.claudeCost) || 0)
    projectCosts30d.set(project, (projectCosts30d.get(project) ?? 0) + cost)
  }
}
const projectColorOrder = [...projectCosts30d]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([project]) => project)

writeDayIndex({
  days: activeDays,
  today: todayKey,
  projectColorOrder,
  // per-day calendar stats, so the UI doesn't fetch every day file at load
  summary,
})
writeFileSync(STATE_PATH, JSON.stringify({ dayKeys: activeDays, priceHash, scriptsSig, pending: [] }))
