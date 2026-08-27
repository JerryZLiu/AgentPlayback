// Codex provider: scans the rollout JSONL files Codex writes under
// ~/.codex/sessions (and ~/.codex/archived_sessions) into normalized sessions,
// and owns OpenAI's pricing quirks (long-context tier, priority service tier).
// See README.md for the provider contract.
//
// Token accounting mirrors ccusage v20's Rust codex adapter, which Jerry
// treats as ground truth:
//  - per-event usage from token_count's last_token_usage (cumulative-delta
//    fallback), duplicate-cumulative suppression
//  - forked rollouts replay their parent's whole usage history re-stamped at
//    fork time: the child's leading events are matched against the parent
//    file's usage prefix (parent_thread_id, cross-file) and dropped; when the
//    parent log is unavailable, a ≤1s-gap rewritten-burst heuristic stands in
//  - events deduped globally on (timestamp, model, token counts)
//  - codex-auto-review resolves to the real model by session date
//
// Scanning is two-phase for speed: record() reads one rollout into a compact,
// window-independent record (cached by mtime via fastscan), and replay/finish
// feed that record through the trackers under the current day window. Rollout
// lines carry their event type in the first ~200 bytes, so record() decodes
// only a prefix of each line and pays full UTF-8 decode just for the small
// event lines it actually parses — tool-output monsters cost a timestamp read.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { localT, planRecords, loadNeeded } from '../lib/fastscan.mjs'
import { jsonStr } from '../lib/scan-core.mjs'
import { codexHomes, splitPath } from '../lib/roots.mjs'

// anchored so embedded timestamps inside message/tool content never match:
// Codex rollout lines begin with `{"timestamp":"…"`.
const TS_RE = /^\{"timestamp":"([^"]+)"/

// OpenAI long-context tier: requests with >272K input tokens (GPT-5's max
// short-context input) bill the whole request at two-stage rates that LiteLLM
// doesn't publish. Rates from https://platform.openai.com/docs/pricing
// (Standard tier), mirrored from ccusage's built-in table. Per-token USD.
const LONG_CTX_THRESHOLD = 272_000
const LONG_CTX_TAG = ' long'
const LONG_CTX_RATES = {
  'gpt-5.6-sol': { i: 10e-6, o: 45e-6, cw: 12.5e-6, cr: 1e-6 },
  'gpt-5.6-terra': { i: 5e-6, o: 22.5e-6, cw: 6.25e-6, cr: 0.5e-6 },
  'gpt-5.6-luna': { i: 2e-6, o: 9e-6, cw: 2.5e-6, cr: 0.2e-6 },
  'gpt-5.5': { i: 10e-6, o: 45e-6, cw: 10e-6, cr: 1e-6 },
  'gpt-5.4': { i: 5e-6, o: 22.5e-6, cw: 5e-6, cr: 0.5e-6 },
}
// Codex priority ("fast") service tier bills at a per-model multiple of
// standard rates — values mirrored from ccusage's fast-multiplier table
const FAST_TAG = ' fast'
const FAST_MULT = {
  'gpt-5.6-sol': 2.0, 'gpt-5.6-terra': 2.0, 'gpt-5.6-luna': 2.0,
  'gpt-5.5': 2.5, 'gpt-5.4': 2.0, 'gpt-5.3-codex': 2.0,
}

// codex-auto-review logs its model as a literal alias; ccusage resolves it to
// the real model that backed auto-review on the session's date (their
// codex-auto-review-fallbacks.json, newest first)
const AUTO_REVIEW_FALLBACKS = [
  ['2026-04-23', 'gpt-5.5'],
  ['2026-03-05', 'gpt-5.4'],
  ['2026-02-05', 'gpt-5.3-codex'],
  ['2025-12-11', 'gpt-5.2-codex'],
  ['2025-11-13', 'gpt-5.1-codex'],
  ['2025-09-15', 'gpt-5-codex'],
  ['2025-08-07', 'gpt-5'],
]
const DATE_RE = /^\d{4}-\d{2}-\d{2}/
function resolveAlias(model, ts) {
  if (model !== 'codex-auto-review') return model
  const date = DATE_RE.test(ts) ? ts.slice(0, 10) : null
  if (!date) return 'gpt-5'
  for (const [released, m] of AUTO_REVIEW_FALLBACKS) if (date >= released) return m
  return 'gpt-5'
}

/** Codex keeps its generated session titles out of the rollouts, in
 *  ~/.codex/session_index.jsonl — {"id","thread_name","updated_at"} lines
 *  keyed by the uuid that ends the rollout filename (later lines win). */
async function titleIndex(homes, scanFile) {
  const titles = new Map()
  for (const home of homes) {
    const p = join(home, 'session_index.jsonl')
    if (!existsSync(p)) continue
    await scanFile(p, (line) => {
      try {
        const o = JSON.parse(line)
        if (o?.id && typeof o.thread_name === 'string' && o.thread_name.trim()) titles.set(o.id, o.thread_name.trim())
      } catch {}
    })
  }
  return titles
}

// Codex appends <oai-mem-citation> metadata to final agent messages, which
// makes them near-duplicates of the mirrored response_item — strip so the
// consecutive-duplicate check collapses them

// bump when record()'s extraction logic changes — invalidates cached records
export const RECORD_V = 4

// seq event types
const EV_AGENT = 0 // any other live timestamped line (agent working)
const EV_AGENT_MSG = 1 // live agent_message (a conversational turn)
const EV_USER = 2 // live user_message (dayIdx -1 when its timestamp is bad)

// events: flat 8-tuples [ms, input, cached, output, reasoning, total, modelIdx, tier]
const EW = 8
const TIER_NONE = 0
const TIER_STD = 1
const TIER_FAST = 2

// event type + payload type both sit in the first ~120 bytes of a rollout
// line, so this prefix classifies every line without decoding it
const PREFIX = 200

const str = (v) => (typeof v === 'string' && v.length ? v : null)
const usageOf = (u) => u ? {
  input: u.input_tokens ?? 0,
  cached: u.cached_input_tokens ?? 0,
  output: u.output_tokens ?? 0,
  reasoning: u.reasoning_output_tokens ?? 0,
  total: u.total_tokens ?? 0,
} : null
const eqUsage = (a, b) => a && b && a.input === b.input && a.cached === b.cached
  && a.output === b.output && a.reasoning === b.reasoning && a.total === b.total

/** Phase 1: one rollout file → compact window-independent record. Pure —
 *  no day-window dependence — so fastscan can cache and parallelize it. */
export function record(path) {
  const buf = readFileSync(path)
  const days = []
  const dayIdx = new Map()
  const di = (key) => dayIdx.get(key) ?? (dayIdx.set(key, days.push(key) - 1), days.length - 1)
  const modelNames = []
  const modelIdx = new Map()
  const mi = (m) => modelIdx.get(m) ?? (modelIdx.set(m, modelNames.push(m) - 1), modelNames.length - 1)
  const seq = []
  const events = [] // ccusage-style per-turn usage events (see EW layout)
  const codes = []
  const models = [] // turn_context model ids, first-seen order
  const modelSeen = new Set()
  let cwd = null
  let summary = null
  let fallbackTitle = null
  let parentId = null // subagent spawn parent — drives the `sub` flag
  let forkId = null // session this file forked from — anchors replay trimming
  let metaTs = null // first line's timestamp (the fork instant), ms
  let firstLine = true
  let curModel = null
  let curTier = TIER_NONE
  let prevTotals = null
  let fileSched = false
  let sched = false
  let pos = 0
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos)
    if (nl === -1) nl = buf.length
    const pre = buf.toString('utf8', pos, Math.min(nl, pos + PREFIX))
    let line = null
    const lineStart = pos
    const full = () => line ?? (line = buf.toString('utf8', lineStart, nl))
    pos = nl + 1

    const isUserMsg = pre.includes('"user_message"')
    const isAgentMsg = pre.includes('"agent_message"')
    const isMessage = pre.includes('"type":"message"')
    const isSessionMeta = pre.includes('"session_meta"')
    const isTaskComplete = pre.includes('"task_complete"')
    const isTurnCtx = pre.includes('"turn_context"')
    const isSettings = pre.includes('"thread_settings_applied"')

    if (isSessionMeta) {
      if (!fileSched && (full().includes('"originator":"codex_exec"') || full().includes('"thread_source":"automation"'))) fileSched = true
      // fork/subagent metadata counts only from the file's FIRST line, and the
      // fork instant is the line-level timestamp (mirrors ccusage's
      // read_session_metadata): forked_from_id marks a forked session,
      // source.subagent.thread_spawn.parent_thread_id a subagent rollout —
      // both replay the parent's history, only the latter hides from the dial
      if (firstLine) {
        try {
          const o = JSON.parse(full())
          const p = o?.payload
          if (p) {
            const ts = Date.parse(o.timestamp ?? '')
            if (!Number.isNaN(ts)) metaTs = ts
            const sub = str(p.source?.subagent?.thread_spawn?.parent_thread_id) ?? str(p.parent_thread_id)
            if (sub) parentId = sub
            forkId = str(p.forked_from_id) ?? sub
          }
        } catch {}
      }
    }
    firstLine = false
    // heartbeat markers ride every line type that can quote message content —
    // user/agent events, mirrored response_item messages, task_complete,
    // settings/turn_context (which restate the pending prompt), compaction
    // summaries, and the odd tool output echoing it. Only the bulk line types
    // (function_call, function_call_output, reasoning) are skipped; they never
    // carry the markers in practice, and decoding them is the whole cost.
    let hb = false
    if (isUserMsg || isAgentMsg || isMessage || isTaskComplete || isTurnCtx || isSettings
      || pre.includes('"compacted"') || pre.includes('"custom_tool_call_output"')) {
      hb = full().includes('<heartbeat>') && full().includes('<automation_id>')
    }
    if (hb) sched = true
    else if (isUserMsg) sched = false
    const live = !sched && !fileSched

    const ts = TS_RE.exec(pre)
    const t = ts ? localT(ts[1]) : null
    if (!cwd) { const c = /"cwd":"([^"]+)"/.exec(full()); if (c) cwd = jsonStr(c[1]) }
    // Codex marks human turns with user_message events; everything else
    // timestamped in a rollout is the agent working
    if (isUserMsg) {
      if (live) {
        seq.push(EV_USER, t ? di(t.key) : -1, t ? t.min : 0)
        // untitled sessions: first user prompt stands in
        if (fallbackTitle === null) {
          try {
            const msg = JSON.parse(full())?.payload?.message
            if (typeof msg === 'string' && msg.trim()) fallbackTitle = msg.trim().split('\n')[0]
          } catch {}
        }
      }
    } else if (live && t) {
      seq.push(isAgentMsg ? EV_AGENT_MSG : EV_AGENT, di(t.key), t.min)
    }
    if (live && isTaskComplete) {
      const m = /"last_agent_message":"((?:[^"\\]|\\.)*)"/.exec(full())
      if (m) { try { summary = JSON.parse(`"${m[1]}"`) } catch {} }
    }
    // Codex edits arrive as apply_patch payloads inside exec tool calls;
    // in the raw JSONL the patch body is one escaped string, so added and
    // removed lines are the \n+ / \n− sequences between the patch fences
    if (t && live && pre.includes('"custom_tool_call"') && full().includes('*** Begin Patch')) {
      const i0 = full().indexOf('*** Begin Patch')
      const i1 = full().indexOf('*** End Patch')
      const seg = full().slice(i0, i1 > i0 ? i1 : undefined)
      const add = (seg.match(/\\n\+/g) ?? []).length
      const del = (seg.match(/\\n-/g) ?? []).length
      if (add || del) codes.push(di(t.key), t.min, add, del)
    }
    // token_count → one usage event, ccusage semantics: last_token_usage when
    // the cumulative total advanced (suppresses verbatim repeats), else the
    // delta of the cumulative totals; zero events dropped
    if (ts && pre.includes('"token_count"')) {
      const ms = Date.parse(ts[1])
      if (!Number.isNaN(ms)) {
        try {
          const p = JSON.parse(full())?.payload
          const info = p?.info
          const total = usageOf(info?.total_token_usage)
          const last = usageOf(info?.last_token_usage)
          const advanced = !total || !prevTotals || !eqUsage(total, prevTotals)
          let raw = advanced && last ? last : null
          if (!raw && total) {
            const pv = prevTotals
            raw = {
              input: Math.max(total.input - (pv?.input ?? 0), 0),
              cached: Math.max(total.cached - (pv?.cached ?? 0), 0),
              output: Math.max(total.output - (pv?.output ?? 0), 0),
              reasoning: Math.max(total.reasoning - (pv?.reasoning ?? 0), 0),
              total: Math.max(total.total - (pv?.total ?? 0), 0),
            }
          }
          if (total) prevTotals = total
          if (raw && (raw.input || raw.cached || raw.output || raw.reasoning)) {
            const parsed = str(p.model) ?? str(p.model_name) ?? str(p.metadata?.model)
              ?? str(info?.model) ?? str(info?.model_name) ?? str(info?.metadata?.model)
            if (parsed) curModel = parsed
            const model = resolveAlias(parsed ?? curModel ?? 'gpt-5', ts[1])
            events.push(ms, raw.input, Math.min(raw.cached, raw.input), raw.output, raw.reasoning, raw.total, mi(model), curTier)
            // register the event's day so incremental scans know this file
            // touches it — scheduled-only rollouts have no timeline entries,
            // and their spend must still dirty the day it lands on
            if (t) di(t.key)
          }
        } catch {}
      }
    }
    // the model id rides the turn_context events
    if (isTurnCtx) {
      const m = /"model":"([^"]+)"/.exec(full())
      if (m) {
        if (!modelSeen.has(m[1])) { modelSeen.add(m[1]); models.push(m[1]) }
        curModel = m[1]
      }
    }
    // service tier (standard vs priority) rides thread_settings_applied — an
    // event with no service_tier field says nothing (keep the previous tier);
    // an unrecognized value means the tier changed to something unknown
    if (isSettings) {
      const m = /"service_tier":"([^"]+)"/.exec(full())
      if (m) curTier = m[1] === 'default' || m[1] === 'standard' ? TIER_STD
        : m[1] === 'fast' || m[1] === 'priority' ? TIER_FAST : TIER_NONE
    }
  }
  return { days, seq, events, codes, models, modelNames, cwd, fallbackTitle, summary, parentId, forkId, metaTs }
}

/** Timeline half of phase 2: seq/codes → activity, waits, turns under the
 *  current day window (tokens are handled cross-file in finish()). */
function replayTimeline(rec, ctx) {
  const { daySet, waitTracker, turnTracker, codeTracker } = ctx
  const tOf = (d, min) => {
    if (d < 0) return null
    const key = rec.days[d]
    return daySet.has(key) ? { key, min } : null
  }
  const byDay = new Map()
  const waits = waitTracker()
  const turns = turnTracker()
  const code = codeTracker()
  const seq = rec.seq
  for (let i = 0; i < seq.length; i += 3) {
    const t = tOf(seq[i + 1], seq[i + 2])
    if (t) (byDay.get(t.key) ?? byDay.set(t.key, []).get(t.key)).push(t.min)
    if (seq[i] === EV_USER) {
      waits.user(t)
      turns.user(t)
    } else if (t) {
      waits.agent(t)
      if (seq[i] === EV_AGENT_MSG) turns.agent(t)
    }
  }
  waits.close()
  const codes = rec.codes
  for (let i = 0; i < codes.length; i += 4) {
    code.push(tOf(codes[i], codes[i + 1]), codes[i + 2], codes[i + 3])
  }
  return { byDay, waits, turns, code }
}

/** Drop the usage a forked rollout replayed from its parent (ccusage's
 *  MatchingParent / SkippingRewrittenBurst state machine): returns the index
 *  of the first event that is the child's own. `prefix` is the parent's raw
 *  event list truncated at the fork instant, null when the file isn't a fork,
 *  empty when the parent log is unavailable. */
function ownEventsFrom(ev, prefix) {
  if (prefix === null) return 0
  let i = 0
  let pi = 0
  // match the child's leading events against the parent's history
  for (; i * EW < ev.length; i++, pi++) {
    const o = i * EW
    const p = prefix[pi]
    if (!(p && ev[o + 1] === p[0] && ev[o + 2] === p[1] && ev[o + 3] === p[2] && ev[o + 4] === p[3] && ev[o + 5] === p[4])) break
  }
  if (i > 0) return i
  // nothing matched: parent unavailable or Codex rewrote the copied history —
  // fall back to the rewritten burst (first two events ≤1s apart, then skip
  // while consecutive events stay ≤1s apart)
  if (ev.length >= 2 * EW && ev[EW] - ev[0] >= 0 && ev[EW] - ev[0] <= 1000) {
    let k = 1
    while ((k + 1) * EW <= ev.length - EW) {
      const gap = ev[(k + 1) * EW] - ev[k * EW]
      if (gap < 0 || gap > 1000) break
      k++
    }
    return k + 1
  }
  return 0
}

/** Parent usage prefix for a fork: the parent's raw tuples up to the first
 *  event after the fork instant. */
function prefixOf(parentRec, forkTs) {
  const ev = parentRec.events
  const out = []
  for (let o = 0; o < ev.length; o += EW) {
    if (forkTs != null && ev[o] > forkTs) break
    out.push([ev[o + 1], ev[o + 2], ev[o + 3], ev[o + 4], ev[o + 5]])
  }
  return out
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/
const mergeTier = (a, b) => (a === TIER_STD || b === TIER_STD) ? TIER_STD
  : (a === TIER_FAST || b === TIER_FAST) ? TIER_FAST : TIER_NONE

export default {
  // 'openai' rather than 'codex' for historical reasons: existing day JSONs
  // and the UI key threads on it. Changing it is a data migration.
  id: 'openai',
  name: 'Codex',

  // Phase A: enumerate rollouts, resolve the mtime cache, extract changed
  // files, and report which days those changes touch (see fastscan.mjs)
  async plan(ctx) {
    const { HOME, dayKeys, scanFile } = ctx
    // CODEX_HOME (comma-separated) or ~/.codex, like ccusage
    const homes = codexHomes(HOME)
    const titles = await titleIndex(homes, scanFile)
    const windowStartMs = new Date(`${dayKeys[0]}T00:00:00`).getTime()
    const daySet = new Set(dayKeys)
    const files = []
    const seenUuid = new Set()
    const allByUuid = new Map() // every rollout on disk, for parent lookups
    const push = (path, name, st) => {
      const id = UUID_RE.exec(name)?.[1]
      if (id) {
        if (seenUuid.has(id)) return // same session reachable twice (e.g. archived copy)
        seenUuid.add(id)
      }
      files.push({ path, name, mtimeMs: st.mtimeMs, size: st.size })
    }
    // window day dirs first (keeps the established session order), then any
    // rollout elsewhere still being written inside the window: long-lived
    // sessions live in the day dir they STARTED in, which can predate the
    // window, and archived_sessions is outside the date tree entirely
    const extras = []
    const noteAll = (path, name, st) => {
      const id = UUID_RE.exec(name)?.[1]
      if (id && !allByUuid.has(id)) allByUuid.set(id, path)
      if (st.mtimeMs >= windowStartMs) extras.push({ path, name, st })
    }
    for (const home of homes) {
    const sessRoot = join(home, 'sessions')
    for (const key of dayKeys) {
      const [y, mo, d] = key.split('-')
      const dir = join(sessRoot, y, mo, d)
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
        const path = join(dir, f)
        push(path, f, statSync(path))
      }
    }
    if (existsSync(sessRoot)) {
      for (const y of readdirSync(sessRoot)) {
        const yDir = join(sessRoot, y)
        let months
        try { months = readdirSync(yDir) } catch { continue }
        for (const mo of months) {
          const moDir = join(yDir, mo)
          let dds
          try { dds = readdirSync(moDir) } catch { continue }
          for (const d of dds) {
            if (daySet.has(`${y}-${mo}-${d}`)) {
              // already enumerated; still index for parent lookups
              try { for (const f of readdirSync(join(moDir, d))) { const id = UUID_RE.exec(f)?.[1]; if (id && !allByUuid.has(id)) allByUuid.set(id, join(moDir, d, f)) } } catch {}
              continue
            }
            let fs2
            try { fs2 = readdirSync(join(moDir, d)) } catch { continue }
            for (const f of fs2.filter((x) => x.endsWith('.jsonl'))) {
              const path = join(moDir, d, f)
              try { noteAll(path, f, statSync(path)) } catch {}
            }
          }
        }
      }
    }
    const archRoot = join(home, 'archived_sessions')
    if (existsSync(archRoot)) {
      for (const f of readdirSync(archRoot, { recursive: true })) {
        if (!String(f).endsWith('.jsonl')) continue
        const path = join(archRoot, String(f))
        try { noteAll(path, splitPath(f).pop(), statSync(path)) } catch {}
      }
    }
    } // homes
    extras.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    for (const e of extras) push(e.path, e.name, e.st)
    const p = await planRecords('codex', RECORD_V, files, record, import.meta.url, { prune: ctx.prune !== false })
    p.titles = titles
    p.allByUuid = allByUuid
    return p
  },

  // Phase B: replay the records that touch the days being recomputed
  // (needed = null means all) into normalized sessions
  finish(plan, ctx, needed) {
    const { titles, allByUuid } = plan
    const { daySet, tokenTracker } = ctx
    const files = plan.files
    const recs = loadNeeded(plan, needed)
    // parent lookup: shard by index when the parent is in the scan set,
    // one-off extraction when it only exists outside it
    const idxByUuid = new Map()
    for (let i = 0; i < files.length; i++) {
      const id = UUID_RE.exec(files[i].name)?.[1]
      if (id !== undefined && !idxByUuid.has(id)) idxByUuid.set(id, i)
    }
    const extraParents = new Map()
    const parentRecOf = (pid) => {
      const i = idxByUuid.get(pid)
      if (i !== undefined) {
        if (recs[i] === undefined) {
          try { recs[i] = JSON.parse(readFileSync(join(plan.dir, plan.shards[i]), 'utf8')).r } catch {}
        }
        return recs[i] ?? null
      }
      if (extraParents.has(pid)) return extraParents.get(pid)
      const path = allByUuid?.get(pid)
      let rec = null
      if (path) { try { rec = record(path) } catch {} }
      extraParents.set(pid, rec)
      return rec
    }
    // pass 1: strip replayed prefixes, then dedupe events globally on
    // (timestamp, model, token counts) — first occurrence wins, service tiers
    // merge conservatively (standard beats fast beats unknown)
    const fileEvents = new Array(files.length)
    const dedup = new Map()
    for (let i = 0; i < files.length; i++) {
      const rec = recs[i]
      if (rec === undefined) continue
      const ev = rec.events
      let prefix = null
      if (rec.forkId) {
        const parent = parentRecOf(rec.forkId)
        prefix = parent && parent !== rec ? prefixOf(parent, rec.metaTs) : []
      }
      const from = ownEventsFrom(ev, prefix)
      const list = []
      for (let o = from * EW; o < ev.length; o += EW) {
        const e = { ms: ev[o], input: ev[o + 1], cached: ev[o + 2], output: ev[o + 3], reasoning: ev[o + 4], total: ev[o + 5], model: rec.modelNames[ev[o + 6]], tier: ev[o + 7] }
        const key = `${e.ms}|${e.model}|${e.input}|${e.cached}|${e.output}|${e.reasoning}|${e.total}`
        const first = dedup.get(key)
        if (first) { first.tier = mergeTier(first.tier, e.tier); continue }
        dedup.set(key, e)
        list.push(e)
      }
      fileEvents[i] = list
    }
    // pass 2: aggregate each file's surviving events into its session
    const sessions = []
    for (let i = 0; i < files.length; i++) {
      const rec = recs[i]
      if (rec === undefined) continue
      const { byDay, waits, turns, code } = replayTimeline(rec, ctx)
      const tok = tokenTracker()
      for (const m of rec.models) tok.models.add(m)
      for (const e of fileEvents[i]) {
        const t = localT(new Date(e.ms).toISOString())
        if (!t || !daySet.has(t.key)) continue
        // OpenAI picks the pricing tier per request: input above the model's
        // long-context threshold bills the whole event at long-context rates
        const long = e.model.startsWith('gpt-5') && e.input > LONG_CTX_THRESHOLD
        const key = `${e.model}${long ? LONG_CTX_TAG : ''}${e.tier === TIER_FAST ? FAST_TAG : ''}`
        tok.push(t, { i: e.input - e.cached, cw: 0, cr: e.cached, o: e.output }, key)
      }
      const id = UUID_RE.exec(files[i].name)?.[1]
      const title = (id && titles.get(id)) || rec.fallbackTitle || null
      // scheduled-only rollouts have no live minutes but real spend — push
      // them anyway so the day's cost totals (aggregated from tokByDay,
      // not blocks) still include the automation's tokens
      if (byDay.size || tok.byDay.size) sessions.push({ sub: !!rec.parentId, id, parentId: rec.parentId, cwd: rec.cwd ?? 'Codex', byDay, waitsByDay: waits.byDay, codeByDay: code.byDay, tokByDay: tok.byDay, turnsByDay: turns.byDay, models: [...tok.models], title, summary: rec.summary, file: files[i].path })
    }
    return sessions
  },

  async scan(ctx) {
    return this.finish(await this.plan(ctx), ctx, null)
  },

  // ---- pricing hook: this provider tags model keys with tier suffixes
  // (' long', ' fast') that the LiteLLM table doesn't know. Returns
  // { usd } or { unpriced: tokens } for keys it owns, null for the rest
  // (which then price on the generic LiteLLM path).
  modelCost(key, b, prices) {
    const [base, ...tags] = key.split(' ')
    if (!tags.length) return null
    const mult = tags.includes('fast') ? (FAST_MULT[base] ?? 1) : 1
    const lr = tags.includes('long') ? LONG_CTX_RATES[base] : null
    if (lr) return { usd: (b.i * lr.i + b.cw * lr.cw + b.cr * lr.cr + b.o * lr.o) * mult }
    const p = prices[base]
    if (!p) return { unpriced: b.i + b.cw + b.cr + b.o }
    return {
      usd: (b.i * (p.input_cost_per_token ?? 0)
        + b.cw * (p.cache_creation_input_token_cost ?? p.input_cost_per_token ?? 0)
        + b.cr * (p.cache_read_input_token_cost ?? p.input_cost_per_token ?? 0)
        + b.o * (p.output_cost_per_token ?? 0)) * mult,
    }
  },
}
