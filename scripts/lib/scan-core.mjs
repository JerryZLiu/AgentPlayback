// Shared scanning machinery for provider modules: the day window (with its
// 4 AM boundary), line-by-line JSONL streaming, and the per-session trackers
// every provider feeds. Providers receive all of this via the `ctx` argument
// to scan() — see scripts/providers/README.md for the contract.

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export const CWD_RE = /"cwd":"([^"]+)"/

// a "blocked" wait: user sends a follow-up and the agent grinds on it while
// the user sits there. Under 5 min is ordinary chat cadence; over an hour
// means the session went idle and resumed, not one continuous wait.
export const WAIT_MIN_MIN = 5
export const WAIT_MAX_MIN = 60

/** The scan's day window: keys for the last `daysBack` days plus today, and a
 *  localTime() scoped to that window. The current day flips at 4 AM like
 *  every timestamp does — a 1 AM scan is still "yesterday's" dial, so its
 *  late-night tail lands on the visible day. */
export function makeDayWindow(now, daysBack) {
  const anchor = new Date(now)
  if (anchor.getHours() < 4) anchor.setDate(anchor.getDate() - 1)
  const dayKeys = []
  for (let i = daysBack; i >= 0; i--) {
    const d = new Date(anchor)
    d.setDate(d.getDate() - i)
    dayKeys.push(d.toLocaleDateString('sv'))
  }
  const daySet = new Set(dayKeys)
  const todayKey = dayKeys[dayKeys.length - 1]

  /**
   * ISO ts → { key, min } in local time; the day boundary is 4 AM, so
   * activity before 4 AM belongs to the previous day as hours 24..28.
   */
  function localTime(iso) {
    const d = new Date(iso)
    if (Number.isNaN(+d)) return null
    let key = d.toLocaleDateString('sv')
    let min = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
    if (min < 4 * 60) {
      const prev = new Date(d)
      prev.setDate(prev.getDate() - 1)
      key = prev.toLocaleDateString('sv')
      min += 24 * 60
    }
    if (!daySet.has(key)) return null
    return { key, min }
  }

  return { dayKeys, daySet, todayKey, localTime }
}

export async function scanFile(path, onLine) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) onLine(line)
}

/** Tracks user-turn waits inside one session: a real user message opens a
 *  turn, agent activity advances its end, the next user message (or EOF)
 *  closes it. Waits of WAIT_MIN..WAIT_MAX minutes land in byDay as minute
 *  pairs — anything shorter is chat cadence, anything longer a stale resume.
 *  A turn whose ends straddle the 4 AM day flip is dropped rather than split. */
export function waitTracker() {
  const byDay = new Map()
  let openU = null
  let lastA = null
  const close = () => {
    if (openU && lastA && openU.key === lastA.key) {
      const d = lastA.min - openU.min
      if (d >= WAIT_MIN_MIN && d <= WAIT_MAX_MIN) {
        ;(byDay.get(openU.key) ?? byDay.set(openU.key, []).get(openU.key)).push([openU.min, lastA.min])
      }
    }
    openU = null
    lastA = null
  }
  return {
    byDay,
    user(t) { close(); openU = t },
    agent(t) { if (openU && t) lastA = t },
    close,
  }
}

/** Per-session conversational-turn tracker: a turn is a maximal run of
 *  consecutive messages by the same side, so it counts speaker SWITCHES —
 *  five agent messages in a row are one agent turn, two back-to-back user
 *  messages are one user turn. Robust to streaming rewrites and machine
 *  chatter, since same-speaker runs collapse. */
export function turnTracker() {
  const byDay = new Map()
  let last = null
  const mark = (role, t) => {
    if (!t || role === last) return
    last = role
    ;(byDay.get(t.key) ?? byDay.set(t.key, []).get(t.key)).push(t.min)
  }
  return { byDay, user: (t) => mark('u', t), agent: (t) => mark('a', t) }
}

/** Per-session code-change tracker: minute-stamped (added, removed) line
 *  counts, straight from the logs' own diffs. */
export function codeTracker() {
  const byDay = new Map()
  return {
    byDay,
    push(t, add, del) {
      if (!t || (!add && !del)) return
      ;(byDay.get(t.key) ?? byDay.set(t.key, []).get(t.key)).push([t.min, add, del])
    },
  }
}

/** Per-session token tracker: minute-stamped bucket counts from the logs' own
 *  usage records — {i: uncached input, cw: cache writes, cr: cache reads,
 *  o: output} — tagged with the model id that produced them, so each bucket
 *  can be priced at its own rate. */
export function tokenTracker() {
  const byDay = new Map()
  const models = new Set()
  return {
    byDay,
    models,
    push(t, b, model) {
      if (!t || !(b.i + b.cw + b.cr + b.o)) return
      ;(byDay.get(t.key) ?? byDay.set(t.key, []).get(t.key)).push([t.min, b, model ?? 'unknown'])
    },
  }
}
