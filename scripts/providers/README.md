# Adding a provider

A provider is one `.mjs` file in this directory that knows where a coding-agent
CLI (Cursor, opencode, Amp, …) writes its session logs and how to parse them.
Drop the file in and the next `scan-day.mjs` run picks it up — there is no
registration step beyond the file existing.

```js
// scripts/providers/cursor.mjs
export default {
  id: 'cursor',        // stable id — lands in day JSON as thread.provider, never change it
  name: 'Cursor',      // display name

  async scan(ctx) { /* required — see below */ },

  modelCost(modelKey, bucket, prices) { /* optional */ },
}
```

## `scan(ctx)` — required

Find this CLI's session logs and return an array of **session objects** (shape
below). `ctx` hands you the day window and the shared trackers so a provider is
just discovery + parsing:

| ctx field | what it is |
| --- | --- |
| `HOME` | the user's home directory |
| `dayKeys` | `['YYYY-MM-DD', …]` — the scan window, oldest first |
| `daySet`, `todayKey` | the same window as a Set, and today's key |
| `localTime(iso)` | ISO timestamp → `{ key, min }` in local time, or `null` if outside the window. The day boundary is **4 AM**: pre-4AM activity belongs to the previous day as minutes 1440–1680. Always use this — never bucket by calendar date yourself. |
| `scanFile(path, onLine)` | streams a file line by line (transcripts can be hundreds of MB — never `readFileSync` them) |
| `waitTracker()` | feed `.user(t)` / `.agent(t)` per message; collects the "user waited on the agent" ranges shown as blocked segments |
| `turnTracker()` | feed `.user(t)` / `.agent(t)`; counts real conversational turns (speaker switches, so streaming rewrites collapse) |
| `codeTracker()` | `.push(t, linesAdded, linesRemoved)` per edit the log records |
| `tokenTracker()` | `.push(t, { i, cw, cr, o }, modelId)` per usage record — uncached input, cache writes, cache reads, output |
| `CWD_RE` | regex that pulls `"cwd":"…"` out of a raw JSONL line |

### Session shape

```js
{
  id: 'unique-session-id',
  cwd: '/path/the/agent/ran/in',   // becomes the project name (last segment)
  byDay: Map<dayKey, minute[]>,    // every activity timestamp, via localTime()
  waitsByDay:  waits.byDay,        // straight from the trackers
  codeByDay:   code.byDay,
  tokByDay:    tok.byDay,
  turnsByDay:  turns.byDay,
  models: [...tok.models],         // model ids that ran
  title: 'session title' | null,   // the CLI's own title if it stores one
  summary: 'first user prompt' | null,
  file: '/path/to/transcript.jsonl',
  sub: false,                      // true for subagent transcripts: their cost
  parentId: null,                  //   counts, but they draw no arc of their own
}
```

Do not set `provider` — the orchestrator stamps it from your `id`.

### Going fast (optional): the record/replay split

A provider that scans gigabytes should split its scan like `claude.mjs` and
`codex.mjs` do: a pure `record(path)` that reads one file into a compact,
**window-independent** record (absolute day keys — no `localTime()` filtering),
and a replay step that feeds the record through the ctx trackers under the
current window. `scripts/lib/fastscan.mjs` then gives you the mtime-keyed
per-file cache and the worker pool for free; export `record` and a `RECORD_V`
version (bump it whenever extraction logic changes) so cached records
invalidate.

Providers may also split `scan(ctx)` into two optional hooks the orchestrator
prefers when present: `plan(ctx)` (enumerate + resolve the cache via
`planRecords()`, returning a plan whose `dirtyDays` says which days changed)
and `finish(plan, ctx, needed)` (replay via `loadNeeded()` only the records
touching the days being recomputed; `needed === null` means all). This is what
lets a warm scan skip both unchanged files AND unchanged days — keep
`scan(ctx) { return this.finish(await this.plan(ctx), ctx, null) }` as the
compatibility form. If any provider lacks `plan`, every scan is a full pass.

**Counting tokens is the part to get right.** Logs love to repeat usage:
Claude Code rewrites the same message id with growing totals while streaming;
Codex replays the parent session's whole usage history when a session resumes.
Read `claude.mjs` and `codex.mjs` before writing your own dedup — our numbers
reconcile against ccusage, and a naive "sum every usage record" can overcount
by an order of magnitude.

## `modelCost(modelKey, bucket, prices)` — optional

Everything prices through LiteLLM's community table by default. Only implement
this if your provider's billing has quirks the table can't express (Codex tags
model keys with ` long` / ` fast` tier suffixes and prices those itself).
Return `{ usd }`, `{ unpriced: tokenCount }` for models you can't price, or
`null`/`undefined` to fall through to the table.

## Checklist

1. `node scripts/scan-day.mjs` — your sessions appear in the per-day counts
   and in `ui/public/day-*.json` with `"provider": "<your id>"`.
2. Spot-check a day's totals against the CLI's own usage reporting if it has
   any (we hold ourselves to ccusage parity for Claude/Codex).

Note: the dashboard UI currently renders a two-provider split (Claude/Codex)
and keys on the legacy ids `claude` and `openai`; new providers flow through
the data files (`tokens.byProvider`, `meta.providerTotals`, per-thread
`provider`) but don't get their own logo in the center disc yet.
