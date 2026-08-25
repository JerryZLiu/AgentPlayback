// Minimal tween engine that stands in for the slice of GSAP main.ts used:
// to()/set()/fromTo() on plain-object numbers and on element rotation/scale/
// opacity, timelines with absolute positions, power eases, a rAF ticker.
//
// It deliberately mirrors GSAP 3.15's observable behaviour so the intro and
// hover animations are frame-identical (scripts/tween-parity.mjs diffs the two
// engines tick by tick):
//   - a tween's clock starts at the ticker's LAST tick time, not "now"
//   - start values are captured lazily on the tween's first render, so a
//     chain of to() tweens on one property hands off exactly where the
//     previous one left off
//   - finished tweens render their end state once and then go quiet
//   - fromTo() renders its from-state immediately unless immediateRender:false
//   - timeline onUpdate fires after every rendered tick, onComplete after the
//     final one; kill() fires neither
//   - element transforms are written as GSAP does: translate3d(...) while
//     mid-motion (compositor layer), "translate(0, 0)" at identity
//   - ticker: Date.now clock, 240fps gate, lagSmoothing(500, 33)
//   - the same quantisation: times to 1e-7 s, plain values to 1e-6, CSS
//     values to 1e-4

export type Ease = 'none' | 'power1.out' | 'power1.inOut' | 'power2.out' | 'power3.out'

const easeOut = (p: number) => (t: number) => 1 - Math.pow(1 - t, p)
const easeInOut = (p: number) => (t: number) => t < 0.5 ? Math.pow(t * 2, p) / 2 : 1 - Math.pow((1 - t) * 2, p) / 2
const EASES: Record<Ease, (t: number) => number> = {
  none: (t) => t,
  'power1.out': easeOut(2),
  'power1.inOut': easeInOut(2),
  'power2.out': easeOut(3),
  'power3.out': easeOut(4),
}

type Target = Record<string, any> | Element
const isEl = (t: Target): t is Element => typeof Element !== 'undefined' && t instanceof Element
interface Vars {
  duration?: number
  ease?: Ease
  onUpdate?: () => void
  immediateRender?: boolean
  [prop: string]: number | Ease | (() => void) | boolean | undefined
}
const RESERVED = new Set(['duration', 'ease', 'onUpdate', 'immediateRender'])

// ---- element adapter: rotation / scale / opacity / transformOrigin -------

interface XForm { rotation: number; scale: number }
const xforms = new WeakMap<Element, XForm>()
const xformOf = (el: Element): XForm => {
  let x = xforms.get(el)
  if (!x) { x = { rotation: 0, scale: 1 }; xforms.set(el, x) }
  return x
}
const roundPrecise = (v: number) => Math.round(v * 10000000) / 10000000 || 0
const roundPlain = (v: number) => Math.round(v * 1000000) / 1000000
const roundCss = (v: number) => Math.round(v * 10000) / 10000
const fmt = (v: number) => String(roundCss(v))

function writeTransform(el: Element, mid: boolean) {
  const { rotation, scale } = xformOf(el)
  let t = ''
  if (mid) t += 'translate3d(0px, 0px, 0px) '
  if (rotation !== 0) t += `rotate(${fmt(rotation)}deg) `
  if (scale !== 1) t += `scale(${fmt(scale)}, ${fmt(scale)}) `
  ;(el as HTMLElement).style.transform = t || 'translate(0, 0)'
}

function getProp(target: Target, prop: string): number {
  if (isEl(target)) {
    if (prop === 'opacity') {
      const inline = (target as HTMLElement).style.opacity
      return parseFloat(inline !== '' ? inline : getComputedStyle(target).opacity)
    }
    return xformOf(target)[prop as keyof XForm]
  }
  return target[prop]
}

function setProp(target: Target, prop: string, v: number, mid: boolean) {
  if (isEl(target)) {
    if (prop === 'opacity') (target as HTMLElement).style.opacity = fmt(v)
    else { xformOf(target)[prop as keyof XForm] = roundCss(v); writeTransform(target, mid) }
  } else target[prop] = roundPlain(v)
}

// ---- tween ---------------------------------------------------------------

interface Track { target: Target; prop: string; from: number | null; to: number; start: number; change: number }

class Tween {
  start = 0            // seconds, in parent time
  duration: number
  ease: (t: number) => number
  onUpdate?: () => void
  tracks: Track[] = []
  inited = false
  done = false
  killed = false
  seq: number

  constructor(targets: Target[], vars: Vars, from?: Record<string, number>, seq = 0) {
    this.duration = roundPrecise(vars.duration ?? 0.5)
    this.ease = EASES[vars.ease ?? 'power1.out']
    this.onUpdate = vars.onUpdate
    this.seq = seq
    for (const target of targets) {
      for (const prop of Object.keys(vars)) {
        if (RESERVED.has(prop)) continue
        this.tracks.push({ target, prop, from: from ? from[prop] : null, to: vars[prop] as number, start: 0, change: 0 })
      }
    }
  }

  private init() {
    for (const tr of this.tracks) {
      tr.start = tr.from ?? getProp(tr.target, tr.prop)
      tr.change = tr.to - tr.start
    }
    this.inited = true
  }

  /** render at local time t (seconds); clamps to [0, duration] */
  render(t: number) {
    if (this.killed) return
    if (!this.inited) this.init()
    const dur = this.duration
    const local = t > dur - 1e-8 ? dur : t < 1e-8 ? 0 : t
    const ratio = dur > 0 ? local / dur : 1
    const e = this.ease(ratio)
    for (const tr of this.tracks) setProp(tr.target, tr.prop, tr.start + tr.change * e, ratio !== 0 && ratio !== 1)
    if (ratio >= 1) this.done = true
    this.onUpdate?.()
  }

  kill() { this.killed = true }
}

// ---- timeline --------------------------------------------------------------

export class Timeline {
  private children: Tween[] = []
  private startTime: number
  private seq = 0
  private killed = false
  private completed = false
  onUpdate?: () => void
  onComplete?: () => void

  constructor(vars: { onUpdate?: () => void; onComplete?: () => void } = {}) {
    this.onUpdate = vars.onUpdate
    this.onComplete = vars.onComplete
    this.startTime = ticker.time
    ticker.timelines.push(this)
  }

  private add(tw: Tween, position: number) {
    tw.start = roundPrecise(position)
    this.children.push(tw)
    // GSAP keeps children sorted by start; ties keep insertion order
    this.children.sort((a, b) => a.start - b.start || a.seq - b.seq)
    return this
  }

  to(target: Target | Target[], vars: Vars, position = 0) {
    return this.add(new Tween(Array.isArray(target) ? target : [target], vars, undefined, this.seq++), position)
  }

  fromTo(target: Target | Target[], from: Record<string, number>, vars: Vars, position = 0) {
    const tw = new Tween(Array.isArray(target) ? target : [target], vars, from, this.seq++)
    if (vars.immediateRender !== false) tw.render(0)
    return this.add(tw, position)
  }

  get duration() {
    return this.children.reduce((m, c) => Math.max(m, roundPrecise(c.start + c.duration)), 0)
  }

  /** @internal */ tick(now: number): boolean {
    if (this.killed || this.completed) return false
    const total = this.duration
    const t = Math.min(roundPrecise(now - this.startTime), total)
    for (const c of this.children) {
      if (c.start > t) break
      if (c.done && c.inited) continue
      c.render(t - c.start)
    }
    this.onUpdate?.()
    if (t >= total) {
      this.completed = true
      this.onComplete?.()
      return false
    }
    return true
  }

  kill() { this.killed = true }
}

// ---- standalone tweens + ticker ------------------------------------------

interface Live { tween: Tween; startTime: number }

class Ticker {
  time = 0
  timelines: Timeline[] = []
  private live: Live[] = []
  private listeners: Array<(time: number) => void> = []
  private lastUpdate = Date.now()
  private startTime = this.lastUpdate
  private nextTime = 0
  private running = false
  private readonly gap = 1000 / 240
  private readonly lagThreshold = 500
  private readonly adjustedLag = 33

  add(fn: (time: number) => void) {
    this.listeners.push(fn)
  }

  to(target: Target, vars: Vars) {
    // overwrite:false semantics — an older tween on the same property keeps
    // running underneath; the newer one renders after it each tick (and
    // captures its start value from the older one's render on that tick)
    this.live.push({ tween: new Tween([target], vars), startTime: this.time })
  }

  set(target: Target | Target[], vars: Record<string, number | string>) {
    for (const el of Array.isArray(target) ? target : [target]) {
      for (const [k, v] of Object.entries(vars)) {
        if (k === 'transformOrigin') { (el as HTMLElement).style.transformOrigin = String(v); continue }
        setProp(el, k, v as number, false)
      }
    }
  }

  constructor() {
    // like GSAP, the clock runs from module load so a timeline built before
    // the first frame starts at the last tick, not at "now"
    if (typeof requestAnimationFrame !== 'undefined') this.start()
  }

  private start() {
    if (this.running) return
    this.running = true
    requestAnimationFrame(this.frame)
  }

  private frame = () => {
    requestAnimationFrame(this.frame)
    const elapsed = Date.now() - this.lastUpdate
    if (elapsed > this.lagThreshold || elapsed < 0) this.startTime += elapsed - this.adjustedLag
    this.lastUpdate += elapsed
    const ms = this.lastUpdate - this.startTime
    const overlap = ms - this.nextTime
    if (overlap <= 0) return
    this.nextTime += overlap + (overlap >= this.gap ? 4 : this.gap - overlap)
    this.advance(ms / 1000)
  }

  /** advance the clock to an absolute time in seconds and render everything */
  advance(time: number) {
    time = roundPrecise(time)
    this.time = time
    this.live = this.live.filter((l) => {
      if (l.tween.killed) return false
      l.tween.render(time - l.startTime)
      return !l.tween.done
    })
    this.timelines = this.timelines.filter((tl) => tl.tick(time))
    for (const fn of this.listeners) fn(time)
  }
}

export const ticker = new Ticker()
export const to = (target: Target, vars: Vars) => ticker.to(target, vars)
export const set = (target: Target | Target[], vars: Record<string, number | string>) => ticker.set(target, vars)
export const timeline = (vars?: { onUpdate?: () => void; onComplete?: () => void }) => new Timeline(vars)
