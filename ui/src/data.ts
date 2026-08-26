// Data model + the mock day used to match the Figma frames.

export type Category =
  | 'research'
  | 'seo'
  | 'agent-tooling'
  | 'swift'
  | 'personal'
  | 'pixel-art'

export type Provider = 'claude' | 'openai'

export type ThreadState = 'done' | 'active' | 'unfinished' | 'blocked'

export interface Thread {
  id: string
  category: Category
  provider: Provider
  /** hours since midnight */
  start: number
  end: number
  /** one session returned to across pauses: solid stretches (hours) joined by
   * a faint connector on the dial. Present only when there's more than one;
   * durations sum these instead of end - start. */
  segments?: [number, number][]
  lane: number
  /** the scanner's shared-groove lane, stashed so the UI's pack toggle can
   * swap `lane` between it and the thread's own row (index in start order) */
  packedLane?: number
  state: ThreadState
  /** whole thread renders as a dotted line instead of a solid arc */
  dotted?: boolean
  /** short display title (Claude's generated ai-title / Codex first prompt) */
  title?: string
  /** sub-ranges (fractions of the thread's span) rendered as blocked
   * hatching — each is a stretch where the agent was grinding on a
   * follow-up for 5min..1hr while the user waited */
  blockedRanges?: [number, number][]
  /** unfinished threads: fraction where the coral tail begins (default 0.75) */
  tailFrom?: number
  summary?: string
  /** the thread's real USD cost (its token buckets priced per model);
   * absent when nothing priced */
  usd?: number
}

export const CATEGORY_LABELS: Record<Category, string> = {
  research: 'Research',
  seo: 'SEO',
  'agent-tooling': 'Agent tooling',
  swift: 'Swift',
  personal: 'Personal',
  'pixel-art': '3D Pixel Art',
}

// Mock day mirroring the arc layout of the Figma frames (node 517:659 et al).
// 24h dial: one revolution = the whole day, so the mock's three clusters land
// early morning (right), midday (bottom), and evening (upper left).
export const MOCK_THREADS: Thread[] = [
  // right cluster (~2:00–8:30 AM on the dial)
  { id: 't07', category: 'research',     provider: 'openai', start: 2.8, end: 6.4, lane: 7, state: 'active',
    summary: 'Looked into top verticals for Japanese market and produced report' },
  // subagents run under t07 and are drawn as a beaded rail hugging it, in the
  // parent's own colour — not as a thread of their own on a spare lane
  { id: 't12', category: 'research',     provider: 'claude', start: 2.9, end: 6.4, lane: 7, state: 'done', dotted: true },
  { id: 't08', category: 'seo',          provider: 'openai', start: 2.4, end: 6.1, lane: 5, state: 'done' },
  { id: 't11', category: 'swift',        provider: 'claude', start: 4.6, end: 7.0, lane: 4, state: 'done' },
  { id: 't10', category: 'agent-tooling', provider: 'claude', start: 4.0, end: 7.6, lane: 3, state: 'done' },
  { id: 't09', category: 'pixel-art',    provider: 'claude', start: 1.8, end: 8.4, lane: 2, state: 'done' },

  // bottom cluster (~9:00 AM–4:30 PM)
  { id: 't13', category: 'research',     provider: 'claude', start: 9.0, end: 16.4, lane: 7, state: 'active',
    summary: 'Refactoring session sweep' },
  { id: 't14', category: 'pixel-art',    provider: 'claude', start: 10.0, end: 14.8, lane: 6, state: 'done' },
  { id: 't15', category: 'seo',          provider: 'claude', start: 10.6, end: 14.0, lane: 5, state: 'done' },
  { id: 't06', category: 'personal',     provider: 'claude', start: 10.4, end: 13.8, lane: 4, state: 'blocked', blockedRanges: [[0.68, 0.81]] },
  { id: 't16', category: 'agent-tooling', provider: 'claude', start: 11.2, end: 13.2, lane: 3, state: 'done' },
  { id: 't17', category: 'research',     provider: 'claude', start: 11.0, end: 15.0, lane: 2, state: 'done' },

  // evening cluster (~5:45–11:00 PM)
  { id: 't01', category: 'seo',          provider: 'claude', start: 17.7, end: 22.5, lane: 7, state: 'unfinished' },
  { id: 't02', category: 'pixel-art',    provider: 'claude', start: 18.4, end: 23.1, lane: 6, state: 'unfinished' },
  { id: 't03', category: 'agent-tooling', provider: 'claude', start: 18.9, end: 22.0, lane: 5, state: 'done' },
  { id: 't04', category: 'research',     provider: 'claude', start: 19.4, end: 21.3, lane: 4, state: 'done' },
  { id: 't05', category: 'pixel-art',    provider: 'claude', start: 19.7, end: 21.0, lane: 3, state: 'done' },
]

// The frames draw this day inside roughly 4:00–19:50, which is what leaves the
// clean empty wedge across the top of the dial; the hours above were authored
// against a fuller day and closed that gap. Squeeze the whole set onto the
// frame's window rather than restating seventeen pairs of numbers.
const FRAME_START = 4.1
const FRAME_END = 19.8
{
  const lo = Math.min(...MOCK_THREADS.map((t) => t.start))
  const hi = Math.max(...MOCK_THREADS.map((t) => t.end))
  const k = (FRAME_END - FRAME_START) / (hi - lo)
  for (const t of MOCK_THREADS) {
    t.start = FRAME_START + (t.start - lo) * k
    t.end = FRAME_START + (t.end - lo) * k
  }
}

export interface DonutSegment {
  category: Category
  hours: number
}

// Category totals for the center donut (right-side callout stack in the mock).
// Proportions match the measured segment spans in the donut spec (481-76067).
export const MOCK_DONUT: DonutSegment[] = [
  { category: 'research', hours: 0.78 },
  { category: 'seo', hours: 1.58 },
  { category: 'agent-tooling', hours: 1.23 },
  { category: 'swift', hours: 1.22 },
  { category: 'personal', hours: 1.1 },
  { category: 'pixel-art', hours: 1.06 },
]

// Paper node 1120:7170 is a full project ring, clockwise from the 12 o'clock
// seam: Research, Agent tooling, Research, Swift, Front end, 3D Pixel Art.
// Keep this authored arrangement isolated from the other skins' mock slice.
export const PAPER_MOCK_DONUT: DonutSegment[] = [
  { category: 'research', hours: 1.42 },
  { category: 'agent-tooling', hours: 0.82 },
  { category: 'personal', hours: 1.02 },
  { category: 'swift', hours: 0.48 },
  { category: 'seo', hours: 0.63 },
  { category: 'pixel-art', hours: 1.55 },
]

export const MOCK_META = {
  dateLabel: 'Today, Sep 29',
  claudeTotal: '6 hr 25 min',
  openaiTotal: '6 hr 25 min',
  tooltipThread: 't07',
  tooltipTime: '1:52PM - 4:32 PM',
  dayStart: 0,
  dayEnd: 24,
  startLabel: '12:00 AM',
  endLabel: '11:59PM',
}

// ---- real day loading ------------------------------------------------------
// scripts/scan-day.mjs writes ui/public/day.json from the user's Claude Code
// transcripts and Codex session logs; categories arrive pre-mapped onto the
// six palette slots with display names in `labels`. `?mock` forces the mock.

/** lines +/− from the logs' own diffs, bucketed over the dial window */
export interface CodeSeries {
  start: number
  end: number
  add: number[]
  del: number[]
}

export interface CodeTotal {
  category: string
  add: number
  del: number
}

/** real token usage from the logs: provider totals (cache reads included),
 *  real USD cost (each bucket priced at its model's LiteLLM rate; `priced`
 *  is false when a model was missing from the table), the model ids that
 *  ran, and the per-project split */
export interface TokenStats {
  openai: number
  claude: number
  cost?: { openai: number; claude: number; priced: boolean }
  models: { openai: string[]; claude: string[] }
  byCategory: { category: string; openai: number; claude: number; openaiCost?: number; claudeCost?: number }[]
}

export interface DayData {
  threads: Thread[]
  donut: DonutSegment[]
  labels: Partial<Record<Category, string>>
  meta: typeof MOCK_META
  code?: CodeSeries
  codeTotals?: CodeTotal[]
  tokens?: TokenStats
}

export const MOCK_DAY: DayData = {
  threads: MOCK_THREADS,
  donut: MOCK_DONUT,
  labels: CATEGORY_LABELS,
  meta: MOCK_META,
}

/**
 * Per-project hours summed from the threads the dial actually draws.
 *
 * `day.donut` comes from the scanner's own per-project totals, taken before
 * sessions are merged into blocks, so it can disagree with the sum of thread
 * durations — invisible while the donut was only ever a proportion, but the
 * token panel prints both the project hours and the day total, and they have
 * to be the same arithmetic. Category order follows `day.donut` so colors and
 * ring segments stay put.
 */
/** a thread's worked hours: active stretches only, not the joined-over gaps */
export function threadDur(t: Thread): number {
  return t.segments ? t.segments.reduce((a, [s, e]) => a + (e - s), 0) : t.end - t.start
}

export function projectHours(day: DayData): DonutSegment[] {
  const by = new Map<string, number>()
  for (const t of day.threads) by.set(t.category, (by.get(t.category) ?? 0) + threadDur(t))
  return day.donut
    .map((d) => ({ category: d.category, hours: by.get(d.category) ?? 0 }))
    .filter((d) => d.hours > 0)
}

/** neutral real-day meta: what a missing field means on a day the scanner
 *  wrote (or skipped) — NOT the mock's authored Figma copy, which would
 *  surface "Today, Sep 29" as a real headline. The 8–20 window matches the
 *  scanner's own empty-day default. */
const EMPTY_META: typeof MOCK_META = {
  dateLabel: '',
  claudeTotal: '0 min',
  openaiTotal: '0 min',
  tooltipThread: '',
  tooltipTime: '',
  dayStart: 8,
  dayEnd: 20,
  startLabel: '8:00 AM',
  endLabel: '8:00 PM',
}

export function emptyDay(dateLabel: string): DayData {
  return {
    threads: [],
    donut: [],
    labels: {},
    meta: { ...EMPTY_META, dateLabel },
  }
}

export async function loadDay(date?: string): Promise<DayData | null> {
  if (new URLSearchParams(location.search).has('mock')) return MOCK_DAY
  try {
    const res = await fetch(date ? `/day-${date}.json` : '/day.json', { cache: 'no-store' })
    if (!res.ok) return null
    const d = await res.json()
    if (!Array.isArray(d?.threads)) return null
    return {
      threads: d.threads,
      donut: d.donut ?? [],
      labels: { ...d.labels },
      meta: { ...EMPTY_META, ...d.meta },
      code: d.code,
      codeTotals: d.codeTotals,
      tokens: d.tokens,
    }
  } catch {
    return null
  }
}

export interface DayIndex {
  days: string[]
  today: string
  /** changes whenever scan progress or a day summary is published */
  revision?: number
  projectColorOrder?: string[]
  /** true while a quick today-only scan is serving and history is still backfilling */
  partial?: boolean
  /** known dates whose generated day file does not exist yet */
  loading?: string[]
  /** per-day calendar stats written by the scanner */
  summary?: Record<string, { agents: number; cost: number }>
}

export async function loadDayIndex(): Promise<DayIndex | null> {
  try {
    const res = await fetch('/days.json', { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
