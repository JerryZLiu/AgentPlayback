// Pure geometry core: resolves the day's data into positioned shapes.
// No rendering tech in here — the Three scene and the HTML overlay both consume this.

import type { Thread } from './data'

export const STAGE_W = 1842
export const STAGE_H = 1197
// Pinned to the Figma master frame, whose disc ellipse is centered on
// (924, 610.5) — measured off the file, not eyeballed.
export const CENTER_X = 924
export const CENTER_Y = 610.5

/** Angular gap (degrees) of the notch at 12 o'clock between day end and start. */
export const NOTCH_DEG = 2

export interface ResolvedArc {
  thread: Thread
  radius: number
  /** radians, clockwise from 12 o'clock, screen space */
  a0: number
  a1: number
  width: number
  /** faint bridge across an idle gap between two stretches of one session —
   * not agent time, not a hover target */
  connector?: boolean
  /** blocked-wait spans as fractions of THIS arc (segmented threads remap the
   * thread-level fractions per stretch) */
  blocked?: [number, number][]
  /** square off the [start, end] cap: a pill cap means a true start/end, a
   * flat face means the stretch continues across a connector gap — ] [ */
  sqCaps?: [boolean, boolean]
}

export interface TickSpec {
  angle: number
  rInner: number
  rOuter: number
  major: boolean
}

export interface LabelSpec {
  text: string
  x: number
  y: number
}

const DEG = Math.PI / 180

/**
 * The dial normalizes to the day's actual span: Start = first agent activity
 * (day boundary at 4 AM), End = last activity or 4 AM next-day. One
 * revolution covers [DAY_WIN.start, DAY_WIN.end]; the mock uses 0..24.
 */
export const DAY_WIN = { start: 0, end: 24, notch: 0 }

export function setDayWindow(start: number, end: number, notch = 0) {
  DAY_WIN.start = start
  DAY_WIN.end = Math.max(end, start + 1)
  DAY_WIN.notch = notch
}

/** hours → radians clockwise from 12 o'clock across the day window. With a
    notch (real days), the day maps onto [notch°, 360−notch°] so arcs start ON
    the Start hand and die ON the End hand instead of meeting mid-notch. */
export function hourToAngle(h: number): number {
  const frac = (h - DAY_WIN.start) / (DAY_WIN.end - DAY_WIN.start)
  const n = DAY_WIN.notch * DEG
  return n + Math.max(0, Math.min(1, frac)) * (360 * DEG - 2 * n)
}

/** pick a pleasant hour-label step for the current window (~8–12 labels) */
export function labelStep(): number {
  const span = DAY_WIN.end - DAY_WIN.start
  const candidates = [0.5, 1, 2, 3, 4, 6]
  const ideal = span / 10
  return candidates.reduce((best, c) => (Math.abs(c - ideal) < Math.abs(best - ideal) ? c : best), candidates[0])
}

/** polar (clockwise-from-top angle) → stage x/y */
export function polar(angle: number, radius: number): [number, number] {
  return [CENTER_X + Math.sin(angle) * radius, CENTER_Y - Math.cos(angle) * radius]
}

/** stage x/y → { angle (0..2π cw from top), radius } */
export function toPolar(x: number, y: number): { angle: number; radius: number } {
  const dx = x - CENTER_X
  const dy = y - CENTER_Y
  const radius = Math.hypot(dx, dy)
  let angle = Math.atan2(dx, -dy)
  if (angle < 0) angle += Math.PI * 2
  return { angle, radius }
}

// Lane radii. Real days: one groove per agent thread (lane 0 = outermost,
// grooves shrink their step to fit); the design mock keeps its legacy 18px
// grid where lane numbers are offsets from LANE_R0.
// The frame stacks the mock's lanes from 300 outward at an 18px pitch, with
// the outermost lane pushed out to 454 — a 27px gap rather than 18 — so the
// last thread reads as the day's spine.
export const LANE_R0 = 300
export const LANE_STEP = 18
/** the frame's outermost mock lane sits clear of the uniform grid */
const LANE_TOP = { lane: 7, r: 454 }

// groove band for real days: outermost groove center / innermost allowed.
// GROOVE_TOP is the knob for the gap between the first arc and the rim —
// vinyl's bezel starts at r≈468, so 458 leaves the arc's half-width of air
export const GROOVE_TOP = 458
export const GROOVE_MIN = 310
export const MIN_GROOVES = 5

export interface LaneLayout {
  count: number
  step: number
}

let laneLayout: LaneLayout | null = null

// spacing cap between adjacent groove centers — the header slider adjusts it;
// crowded days still compress below the cap to fit the groove band
let grooveSpacing = LANE_STEP

export function setGrooveSpacing(px: number) {
  grooveSpacing = Math.max(6, Math.min(34, px))
}

/** one groove per agent (min ${MIN_GROOVES} so the disc still reads as a record); null = mock grid */
export function setLaneLayout(threadCount: number | null) {
  if (threadCount === null) {
    laneLayout = null
    return
  }
  const count = Math.max(threadCount, MIN_GROOVES)
  laneLayout = { count, step: Math.min(grooveSpacing, (GROOVE_TOP - GROOVE_MIN) / Math.max(count - 1, 1)) }
}

export function getLaneLayout(): LaneLayout | null {
  return laneLayout
}

/** outer edge of the groove band — the seismograph baseline rides just past it */
export function grooveOuterR(): number {
  return GROOVE_TOP + (laneLayout ? laneLayout.step : LANE_STEP) / 2
}

export function laneRadius(lane: number): number {
  if (laneLayout) return GROOVE_TOP - lane * laneLayout.step
  if (lane === LANE_TOP.lane) return LANE_TOP.r
  return LANE_R0 + lane * LANE_STEP
}

// the frame's strokes cut 8–9px wide
export const ARC_WIDTH = 8.5

/** groove-aware stroke width, uncapped: proportional to the step so crowded
 *  days thin arcs to the groove lines they sit on, roomy days grow past the
 *  base width and let a skin's fatter authored stroke (paper 10.5, vinyl 10)
 *  come through at its full original size. Callers cap it themselves. */
export function arcWidthRaw(): number {
  if (!laneLayout) return Infinity // mock grid: authored widths untouched
  return Math.max(2, laneLayout.step * 0.6)
}

/** arc stroke width for skinless arcs — the groove-aware width under the base cap */
export function arcWidth(): number {
  return Math.min(ARC_WIDTH, arcWidthRaw())
}

// Track zone: separator grooves live between lanes across this radial band.
export const TRACK_R0 = 313
export const TRACK_R1 = 466

// Hairline bridges between separate stretches of one thread are intentionally
// disabled across every skin for now. Keep the switch here so restoring the
// treatment doesn't require touching renderer paint or day data.
const SHOW_THREAD_CONNECTORS = false

export function resolveArcs(threads: Thread[]): ResolvedArc[] {
  const width = arcWidth()
  const grow = (s: number, e: number): [number, number] => [hourToAngle(s), hourToAngle(e)]
  const out: ResolvedArc[] = []
  for (const thread of threads) {
    // a subagent rail shares its parent's lane and tucks just inside it
    const inset = thread.dotted ? 8 : 0
    const radius = laneRadius(thread.lane) - inset
    const segs = thread.segments
    if (!segs || segs.length < 2) {
      const [a0, a1] = grow(thread.start, thread.end)
      out.push({ thread, radius, a0, a1, width, blocked: thread.blockedRanges })
      continue
    }
    // One session returned to across pauses: render each working stretch as
    // its own solid arc. Hairline gap connectors are globally hidden.
    // blockedRanges arrive as fractions of the full span — clip each to its
    // stretch and re-express per arc.
    const span = thread.end - thread.start
    for (const [i, [s, e]] of segs.entries()) {
      const [a0, a1] = grow(s, e)
      const blocked = (thread.blockedRanges ?? [])
        .map(([f0, f1]): [number, number] => [thread.start + f0 * span, thread.start + f1 * span])
        .map(([h0, h1]): [number, number] => [Math.max(h0, s), Math.min(h1, e)])
        .filter(([h0, h1]) => h1 > h0)
        .map(([h0, h1]): [number, number] => [(h0 - s) / (e - s), (h1 - s) / (e - s)])
      out.push({ thread, radius, a0, a1, width, ...(blocked.length ? { blocked } : {}),
        ...(SHOW_THREAD_CONNECTORS ? {
          // ends that face a connector cut square: ] [ across the gap
          sqCaps: [i > 0, i < segs.length - 1] as [boolean, boolean],
        } : {}) })
      if (SHOW_THREAD_CONNECTORS && i < segs.length - 1) {
        const gapA0 = hourToAngle(e)
        const gapA1 = hourToAngle(segs[i + 1][0])
        if (gapA1 > gapA0) out.push({ thread, radius, a0: gapA0, a1: gapA1, width, connector: true })
      }
    }
  }
  return out
}

// ---- tick ring -------------------------------------------------------------

export interface TickRingSpec {
  rInner: number
  minorLen: number
  majorLen: number
  minorPerHour: number
  jitter: number
  seed: number
  /** how many minors between majors — default one major per hour */
  majorEvery?: number
  /** majors can stand off on their own radius: the frame draws a fine even
   *  comb at the rim and a second, sparser ring of long marks outside it */
  majorOffset?: number
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

export function resolveTicks(spec: TickRingSpec): TickSpec[] {
  const ticks: TickSpec[] = []
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < spec.minorPerHour; m++) {
      const frac = h + m / spec.minorPerHour
      const angle = hourToAngle(frac)
      const every = spec.majorEvery ?? spec.minorPerHour
      const major = m % every === 0
      const jit = (base: number) => base * (1 - spec.jitter / 2 + spec.jitter * hash(frac * 7.13 + spec.seed))
      // when the majors stand off on their own radius they are an extra ring
      // rather than a substitution, so the fine comb stays unbroken
      const standoff = spec.majorOffset ?? 0
      if (!major || standoff) {
        const len = jit(spec.minorLen)
        ticks.push({ angle, rInner: spec.rInner, rOuter: spec.rInner + len, major: false })
      }
      if (major) {
        const r0 = spec.rInner + standoff
        ticks.push({ angle, rInner: r0, rOuter: r0 + jit(spec.majorLen), major: true })
      }
    }
  }
  return ticks
}

// ---- hour labels -----------------------------------------------------------

export const LABEL_RADIUS = 556

export function hourLabelText(h: number): string {
  const hh24 = ((Math.floor(h) % 24) + 24) % 24
  const mm = Math.round((h - Math.floor(h)) * 60)
  const ap = hh24 < 12 ? 'AM' : 'PM'
  const hh = hh24 % 12 || 12
  return `${hh}:${String(mm).padStart(2, '0')} ${ap}`
}

/** the label-step hour marks inside the current window (edges stay clear) */
export function labelHours(): number[] {
  const step = labelStep()
  const margin = step * 0.45
  const out: number[] = []
  const first = Math.ceil((DAY_WIN.start + margin) / step) * step
  for (let h = first; h <= DAY_WIN.end - margin; h += step) out.push(h)
  return out
}

/** hour labels across the day window at a pleasant step */
/**
 * Hour labels sit OUTSIDE a clearance circle: the text box's radial
 * half-extent (|sin|·halfWidth + |cos|·halfHeight) is added per label, so a
 * wide label at 3 o'clock clears the ticks exactly like a short one at noon —
 * a fixed center radius let box corners poke into the whisker band.
 */
export function resolveHourLabels(clearRadius = LABEL_RADIUS, flat = false): LabelSpec[] {
  return labelHours().map((h) => {
    const text = hourLabelText(h)
    const a = hourToAngle(h)
    // the master frame sets every label on one center radius instead, so
    // callers pass `flat` to take the radius at face value
    const halfW = flat ? 0 : text.length * 4.2
    const halfH = flat ? 0 : 10
    const r = clearRadius + Math.abs(Math.sin(a)) * halfW + Math.abs(Math.cos(a)) * halfH
    const [x, y] = polar(a, r)
    return { text, x, y }
  })
}

// ---- center donut ----------------------------------------------------------

export const CENTER = {
  labelR: 140, // warm-gray record-label disc (vinyl)
  gaugeR: 127.5, // the one bold ring: white sweep + gauge + category segments
  gaugeW: 19,
  innerR: 77, // provider split disc
  spindleR: 19, // white hole (paper); vinyl overrides with a bigger spindle
}

export interface DonutSegmentResolved {
  category: string
  a0: number
  a1: number
}

/** real days: chips tile the FULL ring (pie = providers, ring = projects),
    with the seam gap straddling 12 o'clock; the mock keeps its authored
    42°..122° slice (defaults below) */
export const DONUT_FULL = [0.9 * DEG, 358.2 * DEG, 1.8 * DEG] as const

export function resolveDonut(
  segments: { category: string; hours: number }[],
  a0 = 42 * DEG,
  span = 79.8 * DEG,
  gap = 1.8 * DEG,
): DonutSegmentResolved[] {
  const total = segments.reduce((s, x) => s + x.hours, 0)
  const usable = span - gap * (segments.length - 1)
  let a = a0
  return segments.map((seg) => {
    const w = (seg.hours / total) * usable
    const out = { category: seg.category, a0: a, a1: a + w }
    a += w + gap
    return out
  })
}
