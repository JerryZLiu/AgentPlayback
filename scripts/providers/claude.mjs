// Claude Code provider: scans the JSONL transcripts Claude Code writes under
// ~/.claude/projects into normalized sessions.
// See README.md for the provider contract.
//
// Scanning is two-phase (see fastscan.mjs): record() reads one transcript
// into a compact window-independent record — cached by mtime, parallelized
// across workers — and replay() feeds it through the trackers under the
// current day window. Claude lines put their timestamp near the END of the
// entry, so unlike Codex there's no prefix shortcut; the corpus is small
// enough (~1 GB) that full decode is fine.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { localT, planRecords, loadNeeded } from '../lib/fastscan.mjs'

// anchored so embedded timestamps inside message/tool content never match:
// Claude entries carry `"uuid":"…","timestamp":"…"` at the top level
const TS_RE = /"uuid":"[0-9a-f-]{36}","timestamp":"([^"]+)"/

/** lines +/− from a Claude Code tool result: Edit/Write-to-existing carry a
 *  structuredPatch whose hunk lines are prefixed +/−; a fresh Write is a
 *  `create` whose content is all additions */
function lineCounts(line) {
  try {
    const r = JSON.parse(line)?.toolUseResult
    let add = 0
    let del = 0
    if (Array.isArray(r?.structuredPatch) && r.structuredPatch.length) {
      for (const h of r.structuredPatch) {
        for (const l of h.lines ?? []) {
          if (l[0] === '+') add++
          else if (l[0] === '-') del++
        }
      }
    } else if (r?.type === 'create' && typeof r.content === 'string') {
      add = r.content.split('\n').length
    }
    return [add, del]
  } catch { return [0, 0] }
}

// bump when record()'s extraction logic changes — invalidates cached records
export const RECORD_V = 2

// seq event types
const EV_TS = 0 // any other timestamped line (activity for byDay only)
const EV_ASSIST = 1 // assistant entry (agent turn + wait progress)
const EV_USER = 2 // typed human message (dayIdx -1 when its timestamp is bad)

/** Phase 1: one transcript file → compact window-independent record. */
export function record(path) {
  const buf = readFileSync(path)
  const days = []
  const dayIdx = new Map()
  const di = (key) => dayIdx.get(key) ?? (dayIdx.set(key, days.push(key) - 1), days.length - 1)
  const modelNames = []
  const modelIdx = new Map()
  const mi = (m) => m == null ? -1 : modelIdx.get(m) ?? (modelIdx.set(m, modelNames.push(m) - 1), modelNames.length - 1)
  const seq = []
  const codes = []
  const models = []
  const modelSeen = new Set()
  let cwd = null
  let firstUser = null
  let title = null
  // streaming rewrites the same assistant message id (same requestId) with
  // growing usage — ccusage keys on (message.id, requestId) and keeps the
  // entry with the LARGEST token total, so buffer per key and flush at EOF
  const msgBest = new Map()
  let pos = 0
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos)
    if (nl === -1) nl = buf.length
    const line = buf.toString('utf8', pos, nl)
    pos = nl + 1
    const ts = TS_RE.exec(line)
    const t = ts ? localT(ts[1]) : null
    if (!cwd) { const c = /"cwd":"([^"]+)"/.exec(line); if (c) cwd = c[1] }
    // Claude Code writes its generated session title as an ai-title entry
    if (line.includes('"type":"ai-title"')) {
      const m = /"aiTitle":"((?:[^"\\]|\\.)*)"/.exec(line)
      if (m) { try { title = JSON.parse(`"${m[1]}"`) } catch {} }
    }
    let ev = t ? EV_TS : -1
    if (line.includes('"type":"user"') && !line.includes('tool_result')) {
      // a "user" line is only a human turn when it carries typed text —
      // tool results and <command> echoes are machine traffic
      try {
        const o = JSON.parse(line)
        const content = o?.message?.content
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.find((c) => c?.type === 'text')?.text : null
        if (typeof text === 'string' && text.trim() && !text.startsWith('<')) {
          if (!firstUser) firstUser = text.trim()
          ev = EV_USER
        }
      } catch {}
    } else if (line.includes('"type":"assistant"')) {
      if (t) ev = EV_ASSIST
      // the assistant entry carries the model id and the message's real
      // token usage (input + cache writes + cache reads + output)
      if (line.includes('"usage"')) {
        try {
          const o = JSON.parse(line)
          const m = o?.message
          if (m?.model && !modelSeen.has(m.model)) { modelSeen.add(m.model); models.push(m.model) }
          const u = m?.usage
          if (u && m?.id) {
            const cw = u.cache_creation_input_tokens ?? 0
            const b = {
              i: u.input_tokens ?? 0,
              cw,
              cr: u.cache_read_input_tokens ?? 0,
              o: u.output_tokens ?? 0,
              // 1-hour-TTL portion of the cache writes: bills at 2× input
              // instead of 1.25×, and most of Jerry's sessions run 1h cache —
              // pricing everything at the 5m rate undercounted ~$250/month
              c1: Math.min(u.cache_creation?.ephemeral_1h_input_tokens ?? 0, cw),
            }
            const key = `${m.id} ${o?.requestId ?? ''}`
            const prev = msgBest.get(key)
            const total = b.i + b.cw + b.cr + b.o
            if (!prev || total > prev.total) msgBest.set(key, { t, b, model: m.model, total })
          }
        } catch {}
      }
    }
    if (ev === EV_USER) seq.push(EV_USER, t ? di(t.key) : -1, t ? t.min : 0)
    else if (ev >= 0 && t) seq.push(ev, di(t.key), t.min)
    if (t && (line.includes('"structuredPatch":[{') || line.includes('"toolUseResult":{"type":"create"'))) {
      const [add, del] = lineCounts(line)
      if (add || del) codes.push(di(t.key), t.min, add, del)
    }
  }
  // flatten msgBest in insertion order: [dayIdx, min, i, cw, cr, o, c1, modelIdx]
  const toks = []
  for (const { t, b, model } of msgBest.values()) {
    toks.push(t ? di(t.key) : -1, t ? t.min : 0, b.i, b.cw, b.cr, b.o, b.c1, mi(model))
  }
  return { days, seq, toks, codes, models, modelNames, cwd, title, firstUser }
}

/** Phase 2: record → session under the current day window. */
function replay(rec, ctx) {
  const { daySet, waitTracker, turnTracker, codeTracker, tokenTracker } = ctx
  const tOf = (d, min) => {
    if (d < 0) return null
    const key = rec.days[d]
    return daySet.has(key) ? { key, min } : null
  }
  const byDay = new Map()
  const waits = waitTracker()
  const turns = turnTracker()
  const code = codeTracker()
  const tok = tokenTracker()
  for (const m of rec.models) tok.models.add(m)
  const seq = rec.seq
  for (let i = 0; i < seq.length; i += 3) {
    const t = tOf(seq[i + 1], seq[i + 2])
    if (t) (byDay.get(t.key) ?? byDay.set(t.key, []).get(t.key)).push(t.min)
    if (seq[i] === EV_USER) {
      waits.user(t)
      turns.user(t)
    } else if (seq[i] === EV_ASSIST && t) {
      waits.agent(t)
      turns.agent(t)
    }
  }
  waits.close()
  const toks = rec.toks
  for (let i = 0; i < toks.length; i += 8) {
    tok.push(tOf(toks[i], toks[i + 1]),
      { i: toks[i + 2], cw: toks[i + 3], cr: toks[i + 4], o: toks[i + 5], c1: toks[i + 6] },
      toks[i + 7] >= 0 ? rec.modelNames[toks[i + 7]] : undefined)
  }
  const codes = rec.codes
  for (let i = 0; i < codes.length; i += 4) {
    code.push(tOf(codes[i], codes[i + 1]), codes[i + 2], codes[i + 3])
  }
  return { byDay, waits, turns, code, tok }
}

export default {
  id: 'claude',
  name: 'Claude Code',

  // Phase A: enumerate transcripts, resolve the mtime cache, extract changed
  // files, and report which days those changes touch (see fastscan.mjs)
  async plan(ctx) {
    const { HOME, dayKeys } = ctx
    const root = join(HOME, '.claude', 'projects')
    const files = []
    if (existsSync(root)) {
      const windowStart = new Date(`${dayKeys[0]}T00:00:00`)
      for (const dir of readdirSync(root)) {
        const dirPath = join(root, dir)
        let names
        // recursive: subagent/workflow transcripts live in nested
        // <session>/subagents/*.jsonl dirs and spend real tokens (ccusage counts
        // them, so must we)
        try { names = readdirSync(dirPath, { recursive: true }).filter((f) => f.endsWith('.jsonl')) } catch { continue }
        for (const f of names) {
          const p = join(dirPath, f)
          const st = statSync(p)
          if (st.mtime < windowStart) continue
          files.push({ path: p, rel: String(f), dir, mtimeMs: st.mtimeMs, size: st.size })
        }
      }
    }
    return planRecords('claude', RECORD_V, files, record, import.meta.url, { prune: ctx.prune !== false })
  },

  // Phase B: replay the records that touch the days being recomputed
  // (needed = null means all) into normalized sessions
  finish(plan, ctx, needed) {
    const files = plan.files
    const recs = loadNeeded(plan, needed)
    const sessions = []
    for (let i = 0; i < files.length; i++) {
      const rec = recs[i]
      if (rec === undefined) continue // touches no recomputed day — skip whole session
      const { byDay, waits, turns, code, tok } = replay(rec, ctx)
      const f = files[i]
      // nested subagent transcripts: real cost and real code output, but not
      // conversations the owner had — counted in totals, hidden from the dial
      const sub = f.rel.includes('subagents')
      const id = basename(f.rel).replace(/\.jsonl$/, '')
      const parentId = sub ? f.rel.split('/')[0] : null
      if (byDay.size) sessions.push({ sub, id, parentId, cwd: rec.cwd ?? f.dir.replace(/-/g, '/'), byDay, waitsByDay: waits.byDay, codeByDay: code.byDay, tokByDay: tok.byDay, turnsByDay: turns.byDay, models: [...tok.models], title: rec.title, summary: rec.firstUser, file: f.path })
    }
    return sessions
  },

  async scan(ctx) {
    return this.finish(await this.plan(ctx), ctx, null)
  },
}
