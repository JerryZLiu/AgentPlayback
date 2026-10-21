// Kimi Work provider: scans the wire.jsonl session logs the Kimi Work desktop
// app (kimi-code kernel) writes under its daimon data dir.
// See README.md for the provider contract.
//
// Layout (macOS; the same relative layout under the daimon root on every OS):
//   <daimon>/agents/main/sessions/hosted-logical/conversations.sqlite  — registry
//   <daimon>/runtime/kimi-code/home/sessions/<wd>/conv-<id>/            — one dir per conversation
//     state.json                                                        — title, createdAt, agents
//     agents/<agent>/wire.jsonl                                         — the transcript itself
//   <agent> is "main" for the owner's conversation and "agent-N" for
//   subagents — subagent transcripts spend real tokens but draw no arc.
//
// wire.jsonl is a flat event stream; every line carries a top-level "time"
// (ms epoch). The lines we care about:
//   turn.prompt                    — a real user prompt (origin.kind "user"
//                                    on main; subagent task prompts have no origin)
//   context.append_loop_event      — wraps one kernel loop event:
//     content.part / step.begin / step.end / tool.call / tool.result
//   tool.call name=Edit|MultiEdit  — args carry old_string/new_string (edits)
//                  name=Write      — args carry content (fresh file)
//   tool.result                    — matches a tool.call by toolCallId; a
//                                    result with isError undoes its pending edit
//   usage.record                   — one per user turn (usageScope "turn"):
//     { usage: { inputOther, output, inputCacheRead, inputCacheCreation } }
//     usageScope "session" records are whole-session rollups — skipping them
//     is the dedup: taking both scopes would double-count every turn.
//
// Corpus note: Kimi Work sessions are small (hundreds of lines, ~MBs total),
// so like Claude we full-decode every line; no prefix shortcut needed.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { localT, planRecords, loadNeeded } from '../lib/fastscan.mjs'
import { jsonStr } from '../lib/scan-core.mjs'

/** daimon roots where Kimi Work keeps its data, deduped, in priority order.
 *  Mirrors the repo's env-override convention (CLAUDE_CONFIG_DIR, CODEX_HOME):
 *  KIMI_WORK_DATA — comma-separated daimon roots (or their sessions/ dirs) */
export function kimiRoots(home) {
  const out = []
  const add = (dir) => { if (isDir(dir) && !out.includes(dir)) out.push(dir) }
  const env = (process.env.KIMI_WORK_DATA ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (env.length) {
    for (const p of env) add(basename(p) === 'sessions' ? dirname(p) : p)
    return out
  }
  if (process.platform === 'darwin') add(join(home, 'Library', 'Application Support', 'kimi-desktop', 'daimon-share', 'daimon'))
  else if (process.platform === 'win32') add(join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'kimi-desktop', 'daimon-share', 'daimon'))
  else add(join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'kimi-desktop', 'daimon-share', 'daimon'))
  return out
}
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

// user prompts arrive with a client-injected "<meta ... />" preamble — strip
// it so session titles/summaries read like what the owner actually typed
const stripMeta = (s) => typeof s === 'string' ? s.replace(/^\s*<meta\b[^>]*\/>/, '').trim() : null

/** line counts from an Edit (old/new strings) or Write (full content) call */
function editCounts(name, args) {
  if (!args) return null
  if (name === 'Write' && typeof args.content === 'string') {
    return [args.content === '' ? 0 : args.content.split('\n').length, 0]
  }
  if (name === 'Edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    const add = args.new_string === '' ? 0 : args.new_string.split('\n').length
    const del = args.old_string === '' ? 0 : args.old_string.split('\n').length
    return [add, del]
  }
  if (name === 'MultiEdit' && Array.isArray(args.edits)) {
    let add = 0
    let del = 0
    for (const e of args.edits) {
      if (typeof e?.new_string === 'string' && e.new_string !== '') add += e.new_string.split('\n').length
      if (typeof e?.old_string === 'string' && e.old_string !== '') del += e.old_string.split('\n').length
    }
    return [add, del]
  }
  return null
}

// bump when record()'s extraction logic changes — invalidates cached records
export const RECORD_V = 2

// seq event types
const EV_TS = 0 // any other timestamped line (activity for byDay only)
const EV_ASSIST = 1 // agent loop event (agent turn + wait progress)
const EV_USER = 2 // a real user prompt

/** Phase 1: one wire.jsonl → compact window-independent record. */
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
  const toks = []
  const models = []
  const modelSeen = new Set()
  let cwd = null
  let firstUser = null
  // pending edit per toolCallId — a tool.result with isError removes it, and
  // whatever survives to EOF was an edit the kernel actually applied
  const pendingEdits = new Map()
  let pos = 0
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos)
    if (nl === -1) nl = buf.length
    const line = buf.toString('utf8', pos, nl)
    pos = nl + 1
    let d
    try { d = JSON.parse(line) } catch { continue }
    const t = d.time != null ? localT(d.time) : null // ms epoch; new Date(ms) localizes
    const type = d.type
    if (type === 'turn.prompt') {
      // a genuine user prompt — machine traffic (tool results, system
      // reminders) never appears as a turn.prompt
      if (!firstUser) {
        const part = Array.isArray(d.input) ? d.input.find((c) => c?.type === 'text') : null
        firstUser = stripMeta(part?.text)
      }
      seq.push(EV_USER, t ? di(t.key) : -1, t ? t.min : 0)
      continue
    }
    if (type !== 'context.append_loop_event') {
      if (type === 'usage.record') {
        // one record per user turn; "session" scope is a rollup of the same
        // spend — taking it too would double-count (checked against the
        // conversations registry's own totals)
        if (d.usageScope === 'turn' && d.usage) {
          const u = d.usage
          toks.push(t ? di(t.key) : -1, t ? t.min : 0,
            u.inputOther ?? 0, u.inputCacheCreation ?? 0, u.inputCacheRead ?? 0, u.output ?? 0,
            mi(d.model))
          if (d.model && !modelSeen.has(d.model)) { modelSeen.add(d.model); models.push(d.model) }
        }
        if (t) seq.push(EV_TS, di(t.key), t.min)
      } else if (t) {
        // context.append_message and friends — activity only
        seq.push(EV_TS, di(t.key), t.min)
      }
      continue
    }
    const e = d.event ?? {}
    const et = e.type
    if (t) seq.push(et === 'tool.call' || et === 'content.part' || et === 'step.begin' || et === 'step.end' ? EV_ASSIST : EV_TS, di(t.key), t.min)
    if (et === 'tool.call') {
      if (!cwd) cwd = e.display?.cwd ?? null
      const counts = editCounts(e.name, e.args)
      if (counts && (counts[0] || counts[1]) && e.toolCallId) {
        pendingEdits.set(e.toolCallId, t ? [di(t.key), t.min, counts[0], counts[1]] : null)
      }
    } else if (et === 'tool.result' && e.toolCallId && pendingEdits.has(e.toolCallId)) {
      if (e.result?.isError || e.result?.is_error) pendingEdits.delete(e.toolCallId)
      else {
        const c = pendingEdits.get(e.toolCallId)
        if (c) codes.push(...c)
        pendingEdits.delete(e.toolCallId)
      }
    }
  }
  for (const c of pendingEdits.values()) if (c) codes.push(...c) // edit whose result never landed in-file
  // title + workDir + createdAt live one level up in the conversation's state.json
  let title = null
  let workDir = null
  try {
    const st = JSON.parse(readFileSync(join(dirname(path), '..', '..', 'state.json'), 'utf8'))
    title = stripMeta(st.title)
    workDir = typeof st.workDir === 'string' ? st.workDir : null
  } catch {}
  return { days, seq, toks, codes, models, modelNames, cwd, workDir, title, firstUser }
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
  for (let i = 0; i < toks.length; i += 7) {
    tok.push(tOf(toks[i], toks[i + 1]),
      { i: toks[i + 2], cw: toks[i + 3], cr: toks[i + 4], o: toks[i + 5] },
      toks[i + 6] >= 0 ? rec.modelNames[toks[i + 6]] : undefined)
  }
  const codes = rec.codes
  for (let i = 0; i < codes.length; i += 4) {
    code.push(tOf(codes[i], codes[i + 1]), codes[i + 2], codes[i + 3])
  }
  return { byDay, waits, turns, code, tok }
}

/** wd_<slug>_<hash> session dirs name the workspace they ran in — recover a
 *  human-readable project name when no tool-call cwd was seen in the wire */
const projectFromDir = (wd) => wd.replace(/^wd_/, '').replace(/_[0-9a-f]{8,}$/i, '')

export default {
  id: 'kimi',
  name: 'Kimi Work',

  // Phase A: enumerate wire.jsonl transcripts, resolve the mtime cache,
  // extract changed files, report which days those changes touch
  async plan(ctx) {
    const { HOME, dayKeys } = ctx
    const files = []
    const windowStart = new Date(`${dayKeys[0]}T00:00:00`)
    for (const root of kimiRoots(HOME)) {
      const sessionsDir = join(root, 'runtime', 'kimi-code', 'home', 'sessions')
      let names
      try { names = readdirSync(sessionsDir, { recursive: true }).filter((f) => f.endsWith('wire.jsonl')) } catch { continue }
      for (const f of names) {
        // ctitle-* dirs are the kernel's internal title-generation runs — a
        // real conversation spawns one to name itself; machine traffic, not
        // something the owner did (the Claude equivalent is an ai-title event
        // inside the same transcript), so they don't even count toward totals
        if (f.split(/[\\/]/)[1]?.startsWith('ctitle-')) continue
        const p = join(sessionsDir, f)
        // a wire file can vanish mid-scan (live session, cleanup) — skip it
        let st
        try { st = statSync(p) } catch { continue }
        if (st.mtime < windowStart) continue
        files.push({ path: p, rel: String(f), dir: String(f).split(/[\\/]/)[0], mtimeMs: st.mtimeMs, size: st.size })
      }
    }
    return planRecords('kimi', RECORD_V, files, record, import.meta.url, { prune: ctx.prune !== false })
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
      // rel is <wd>/<conv-id>/agents/<agent>/wire.jsonl (depth varies with the
      // OS separator, so anchor on the literal "agents" segment)
      const parts = f.rel.split(/[\\/]/)
      const ai = parts.indexOf('agents')
      const agent = ai >= 0 ? parts[ai + 1] : 'main'
      const conv = ai >= 1 ? parts[ai - 1] : basename(f.rel, '.jsonl')
      // subagent wires: real cost and real code output, but not conversations
      // the owner had — counted in totals, hidden from the dial
      const sub = agent !== 'main'
      const id = `${conv}:${agent}`
      const cwd = rec.cwd ?? rec.workDir ?? projectFromDir(f.dir)
      if (byDay.size) sessions.push({ sub, id, parentId: sub ? conv : null, cwd, byDay, waitsByDay: waits.byDay, codeByDay: code.byDay, tokByDay: tok.byDay, turnsByDay: turns.byDay, models: [...tok.models], title: rec.title, summary: rec.firstUser, file: f.path })
    }
    return sessions
  },

  async scan(ctx) {
    return this.finish(await this.plan(ctx), ctx, null)
  },
}
