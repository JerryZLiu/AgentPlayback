import './styles.css'
import * as tween from './tween'
import { AgentScene } from './scene'
import { emptyDay, loadDay, loadDayIndex, MOCK_DAY, PAPER_MOCK_DONUT, threadDur, type DayData, type DayIndex, type Thread } from './data'
import {
  CENTER, CENTER_X, CENTER_Y, DONUT_FULL, NOTCH_DEG, STAGE_W, STAGE_H, DAY_WIN, polar,
  toPolar, laneRadius, getLaneLayout, grooveOuterR, resolveArcs, resolveDonut, setDayWindow,
  setGrooveSpacing, setLaneLayout,
} from './geometry'
import { SKINS, type SkinId } from './skins'
import { setProjectColorOrder, setProjectColorOverride, setProjectColorOverrides, skinFor, setLook, waveHorizonFor, type Look, type ProjectColorOverrides } from './palette'
import { setVariant, variantId } from './vinylvariants'
import { buildOverlay, fmtClock, refreshOpenCalendar, type CalendarDaySummary } from './overlay'
import { setGitHubStarPromptEligible } from './star-prompt'
import { openShareDialog } from './share'

const stage = document.getElementById('stage')!
const canvas = document.getElementById('gl') as HTMLCanvasElement
const overlay = document.getElementById('overlay')!
const callouts = document.getElementById('callouts') as unknown as SVGSVGElement

let stageScale = 1
const CALENDAR_VISUAL_SCALE = 600 / 432
function fitStage() {
  stageScale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H)
  document.documentElement.style.setProperty('--stage-scale', String(stageScale))
  // Render the authored 432px calendar at a fixed 600px visual width,
  // independent of the surrounding stage fit.
  document.documentElement.style.setProperty(
    '--stage-inverse-scale',
    String(CALENDAR_VISUAL_SCALE / Math.min(stageScale, 1)),
  )
}
fitStage()
window.addEventListener('resize', () => {
  fitStage()
  scene.setViewScale(stageScale)
})

const params = new URLSearchParams(location.search)

// the redesign (v2) build is gone; clear the stale build pref
localStorage.removeItem('dayflow-rev')

let skinId = (params.get('skin') ?? localStorage.getItem('dayflow-skin') ?? '') as SkinId
if (!SKINS[skinId]) skinId = 'vinyl'
document.body.dataset.skin = skinId

// Pressing is the shipped Vinyl surface; URL and remembered selections can
// still pin another material while variants are being compared.
setVariant('vinyl', params.get('vinyl') ?? localStorage.getItem('dayflow-vinyl-v2') ?? 'pressing')
setVariant('electric', 'classic')

// groove controls: pack (crowded days share grooves per project) and the
// spacing cap between groove centers. URL params override, localStorage
// persists across reloads.
// intro sequence choice (header Intro button cycles; ?intro=name pins)
const INTROS = ['sweep', 'flow', 'bloom', 'needle', 'burst', 'radar', 'trace', 'cascade'] as const
type IntroName = (typeof INTROS)[number]
const introPref = params.get('intro') ?? localStorage.getItem('dayflow-intro-v2') ?? 'bloom'
let introIdx = Math.max(INTROS.indexOf(introPref as IntroName), 0)

// Look defaults to classic, the balance the Figma frame is drawn at.
// ?look= pins, localStorage persists. (The key keeps its historical name so
// saved preferences survive.)
const LOOK_KEY = 'dayflow-look-v2'
const WRAPPED_GLOW_SESSION_KEY = 'agentplayback-wrapped-glow-shown'
const lookPref = params.get('look') ?? localStorage.getItem(LOOK_KEY) ?? 'classic'
let look: Look = lookPref === 'classic' ? 'classic' : 'bold'
setLook(look)

let packOn = (params.get('pack') ?? localStorage.getItem('dayflow-pack-v2') ?? '1') !== '0'
// minimum arc length (minutes) that gets to render — 0 shows everything.
// ?minlen= overrides, the Min length slider persists it.
const savedMinLenRaw = params.get('minlen') ?? localStorage.getItem('dayflow-minlen-v2')
const savedMinLen = Number(savedMinLenRaw)
let minLenMin = savedMinLenRaw !== null && Number.isFinite(savedMinLen) && savedMinLen >= 0
  ? Math.min(30, savedMinLen) : 5
const filterDay = (raw: DayData): DayData =>
  raw === MOCK_DAY || minLenMin <= 0
    ? raw
    : { ...raw, threads: raw.threads.filter((t) => threadDur(t) * 60 >= minLenMin) }

// gap between the disc edge (or outer ring) and the hour-label clearance
// circle — the Label gap slider adjusts it, ?labelgap= pins it
const savedLabelGapRaw = params.get('labelgap') ?? localStorage.getItem('dayflow-labelgap-v2')
const savedLabelGap = Number(savedLabelGapRaw)
let labelGap = savedLabelGapRaw !== null && Number.isFinite(savedLabelGap) && savedLabelGap >= 0
  ? Math.min(60, savedLabelGap) : 8

const savedSpacing = Number(params.get('spacing') ?? localStorage.getItem('dayflow-spacing-v2'))
let spacing = Number.isFinite(savedSpacing) && savedSpacing > 0
  ? Math.max(8, Math.min(30, savedSpacing)) : 20
setGrooveSpacing(spacing)

// packed = the scanner's shared-groove lanes (baked into day.json); unpacked
// = every thread on its own groove (threads arrive sorted by start, so the
// array index is exactly the one-groove-per-agent lane)
function applyLanes(day: DayData) {
  day.threads.forEach((t, i) => {
    t.packedLane ??= t.lane
    t.lane = packOn ? t.packedLane : i
  })
}

// day navigation state: index of generated days (all history), newest = today.
// ?date=YYYY-MM-DD deep-links straight to a day
let dayIndex = await loadDayIndex()
setProjectColorOrder(dayIndex?.projectColorOrder ?? [])
const COLOR_OVERRIDES_KEY = 'dayflow-project-colors-v1'
let projectColorOverrides: ProjectColorOverrides = {}
try {
  const saved = JSON.parse(localStorage.getItem(COLOR_OVERRIDES_KEY) ?? '{}')
  projectColorOverrides = saved && typeof saved === 'object' ? saved : {}
}
catch { projectColorOverrides = {} }
setProjectColorOverrides(projectColorOverrides)
let dayCursor = dayIndex ? dayIndex.days.length - 1 : -1
const dateParam = params.get('date')
if (dayIndex && dateParam) {
  const i = dayIndex.days.indexOf(dateParam)
  if (i >= 0) dayCursor = i
}
let RAW_DAY: DayData = (await loadDay(
  dayIndex && dayCursor !== dayIndex.days.length - 1 ? dayIndex.days[dayCursor] : undefined,
)) ?? MOCK_DAY
let DAY: DayData = filterDay(RAW_DAY)
setGitHubStarPromptEligible(DAY !== MOCK_DAY && DAY.threads.length > 0)

const selectedDateKey = () => dayIndex?.days[dayCursor] ?? dayIndex?.today ?? ''
// calendar stats come from the index when the scanner wrote them; older
// indexes fall back to reading every day file
async function buildCalendar(index: DayIndex | null): Promise<CalendarDaySummary[]> {
  if (!index) return []
  const loading = new Set(index.loading ?? [])
  const dates = new Set(index.days)
  // The quick first pass only knows today. Reserve recent calendar dates as
  // loading immediately so the popover communicates the backward backfill
  // before the full scanner has even finished discovering its exact day set.
  if (index.partial) {
    const cursor = new Date(`${index.today}T12:00:00`)
    for (let i = 0; i < 42; i++) {
      const date = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
      dates.add(date)
      if (!index.summary?.[date]) loading.add(date)
      cursor.setDate(cursor.getDate() - 1)
    }
  }
  return Promise.all([...dates].sort().map(async (date) => {
    if (loading.has(date)) return { date, agents: 0, cost: 0, loading: true }
    const s = index.summary?.[date]
    if (s) return { date, agents: s.agents, cost: s.cost }
    const source = date === selectedDateKey() ? RAW_DAY : await loadDay(date)
    const agents = source?.threads.filter((t) => !t.dotted).length ?? 0
    const cost = source?.tokens?.cost
    return { date, agents, cost: cost ? cost.openai + cost.claude : 0 }
  }))
}
let calendarDays: CalendarDaySummary[] = await buildCalendar(dayIndex)
let calendarProgressGeneration = 0

function updateCalendarProgressively(target: CalendarDaySummary[]) {
  const generation = ++calendarProgressGeneration
  const previous = new Map(calendarDays.map((d) => [d.date, d]))
  const targetDates = new Set(target.map((d) => d.date))
  const newlyLoaded = target
    .filter((d) => previous.get(d.date)?.loading && !d.loading)
    .sort((a, b) => b.date.localeCompare(a.date))

  if (!newlyLoaded.length) {
    calendarDays.splice(0, calendarDays.length, ...target)
    refreshOpenCalendar()
    return
  }

  const revealDates = new Set(newlyLoaded.map((d) => d.date))
  const interim = target.map((d) => revealDates.has(d.date) ? previous.get(d.date)! : d)
  // Keep provisional empty-date placeholders until the real days have filled,
  // then remove them together when the backfill is genuinely complete.
  interim.push(...calendarDays.filter((d) => d.loading && !targetDates.has(d.date)))
  calendarDays.splice(0, calendarDays.length, ...interim)
  refreshOpenCalendar()

  newlyLoaded.forEach((day, i) => {
    setTimeout(() => {
      if (generation !== calendarProgressGeneration) return
      const at = calendarDays.findIndex((d) => d.date === day.date)
      if (at >= 0) calendarDays[at] = day
      if (i === newlyLoaded.length - 1) {
        calendarDays.splice(0, calendarDays.length, ...target)
      }
      refreshOpenCalendar()
    }, (i + 1) * 90)
  })
}

const scene = new AgentScene(canvas)
scene.setViewScale(stageScale)

// Center hover treatments are temporarily disabled. Use the shader's off
// sentinel directly so an old persisted audition choice cannot re-enable it.
const HOVER_FX_OFF = 4
scene.setCenterHoverFx(HOVER_FX_OFF)

// ---- response-delay control: Hairline is the fixed treatment. The toggle
// owns visibility as well as emphasis, so off restores every arc unchanged.
scene.setHatchStyle(0)
let highlightDelays = localStorage.getItem('dayflow-hidelays') !== '0'
scene.setHatchVisible(highlightDelays)
// hover state + the dim computation live up here, ahead of the first
// finalize() call — the intro's finish re-asserts the delay highlight
let hovered: Hover | null = null

/** the one place arc dimming is computed — hover, the session list, and the
 *  Highlight delays toggle all funnel through it */
function applyDimTargets() {
  // Outline mode replaces hover-dimming: nothing dims, the associated arcs
  // get their self-colored rim (uHi) instead. Every other mode keeps the
  // dim-the-rest signal (the rim was axed there; it returns only for Outline).
  const outlineHover = false
  for (const h of scene.arcs) {
    // Delay highlighting only reveals the hatch overlay. At rest every arc
    // keeps its original color and opacity; hover may still focus its target.
    const lit = hovered === null || litFor(h.thread, hovered)
    tween.to(h.uniforms.uDim, {
      value: lit || outlineHover ? 1 : 0.12,
      duration: 0.25,
      onUpdate: () => scene.invalidate(),
    })
    tween.to(h.uniforms.uHi, { value: outlineHover && lit ? 1 : 0, duration: 0.25 })
  }
}

function setHighlightDelays(on: boolean) {
  highlightDelays = on
  localStorage.setItem('dayflow-hidelays', on ? '1' : '0')
  scene.setHatchVisible(on)
  applyDimTargets()
}
// packed days share grooves, so the layout sizes from groove count, not threads
const grooveCount = (day: DayData) =>
  day.threads.length ? Math.max(...day.threads.map((t) => t.lane)) + 1 : 0

setDayWindow(DAY.meta.dayStart ?? 0, DAY.meta.dayEnd ?? 24, DAY === MOCK_DAY ? 0 : NOTCH_DEG)
if (DAY !== MOCK_DAY) applyLanes(DAY)
setLaneLayout(DAY === MOCK_DAY ? null : grooveCount(DAY))
let arcs = resolveArcs(DAY.threads)
scene.buildDisc(skinFor(skinId, DAY))
scene.buildArcs(arcs, skinFor(skinId, DAY))
// accurate provider split: the gray openai wedge is centered on 12 o'clock
// and spans its real share of agent-hours; claude gets the rest at the bottom.
// The mock keeps its authored Figma art angles.
function providerSplitDeg(day: DayData): [number, number] {
  if (day === MOCK_DAY) return [329, 94]
  const dur = (p: string) => day.threads.filter((t) => t.provider === p).reduce((a, t) => a + threadDur(t), 0)
  const o = dur('openai')
  const c = dur('claude')
  // Out-of-range sentinels tell the center shader to paint one provider's
  // field solid, with no fake sliver or boundary at 0%/100%.
  if (o > 0 && c === 0) return [-1, -1]
  if (c > 0 && o === 0) return [361, 361]
  const half = (o + c > 0 ? o / (o + c) : 0.5) * 180
  return [360 - half, half]
}
let splitDeg = providerSplitDeg(DAY)
// every skin shows the real provider share on real days — paper/glass split
// the pie by wedge angle, vinyl/electric flood the wave from the bottom by
// disc area, and the bold ring re-shapes into a split gauge on all of them;
// Paper's selected Figma frame is already the full project ring even on the
// authored mock; the other mock skins retain their split gauge artwork.
const ringGauge = () => DAY !== MOCK_DAY || skinId === 'paper'

let waveHorizon = waveHorizonFor(DAY, skinFor(skinId, DAY))

// seismograph tuning (the Ticks panel): bar every `spacing` px of arc, rising
// from `offset` px outside the outermost groove ring, lengths min..max
const tickNum = (key: string, fallback: number) => {
  const s = localStorage.getItem(key)
  if (s === null) return fallback
  const v = Number(s)
  return Number.isFinite(v) && v >= 0 ? v : fallback
}
const tickCfg = {
  spacing: tickNum('dayflow-tick-spacing', 10),
  offset: tickNum('dayflow-tick-offset', 20),
  min: tickNum('dayflow-tick-min', 3),
  max: tickNum('dayflow-tick-max', 55),
}
function seismoBase(): number {
  return grooveOuterR() + tickCfg.offset
}

function applySeismo(k = 1) {
  scene.setSeismo(tickCfg.spacing, seismoBase(),
    tickCfg.min * k, Math.max(tickCfg.max, tickCfg.min + 1) * k)
}

let tickRebuild: ReturnType<typeof setTimeout> | undefined
function setTick(key: 'spacing' | 'offset' | 'min' | 'max', v: number) {
  tickCfg[key] = v
  localStorage.setItem(`dayflow-tick-${key}`, String(v))
  applySeismo()
  // taller bars move the hour-label clearance; re-lay the labels once the
  // slider settles (immediately would rebuild the slider out from under the
  // drag)
  if (key === 'max' || key === 'offset') {
    clearTimeout(tickRebuild)
    tickRebuild = setTimeout(rebuildOverlay, 350)
  }
}

// concurrency histogram driving the seismo bar lengths (10-min buckets across
// the day window); null keeps the mock's hand-ruled jitter
const CONC_BUCKETS = 144
function concurrency(day: DayData): number[] | null {
  // only the mock keeps the hand-ruled jitter; a real day with no threads
  // gets a flat all-zero histogram (minimum-length rim), not authored noise
  if (day === MOCK_DAY || skinId === 'electric') return null
  const s = day.meta.dayStart ?? 0
  const span = Math.max((day.meta.dayEnd ?? 24) - s, 0.1)
  const raw = Array.from({ length: CONC_BUCKETS }, (_, i) => {
    const h = s + ((i + 0.5) / CONC_BUCKETS) * span
    return day.threads.reduce((n, t) => n + (t.start <= h && t.end >= h ? 1 : 0), 0)
  })
  // natural rise/fall: every peak throws an exponential skirt (~20 min decay)
  // over its neighbors, so a fleet kicking off ramps the bars up and down
  // instead of cliffing — peak heights stay exact
  const tau = (0.35 / span) * CONC_BUCKETS
  return raw.map((v, i) =>
    raw.reduce((m, w, j) => Math.max(m, w * Math.exp(-Math.abs(i - j) / tau)), v))
}

const donutData = (day: DayData) => day === MOCK_DAY && skinId === 'paper' ? PAPER_MOCK_DONUT : day.donut
const donutRange = (day: DayData) => {
  if (donutData(day).length === 1) return [0, Math.PI * 2, 0] as const
  return day === MOCK_DAY && skinId !== 'paper' ? [] : DONUT_FULL
}
let donutSegs = resolveDonut(donutData(DAY), ...donutRange(DAY)).map((s) => ({ a0: s.a0, a1: s.a1, category: s.category }))
scene.buildCenter(skinFor(skinId, DAY), donutSegs)
scene.setProviderSplit(...splitDeg, ringGauge(), waveHorizon)
scene.setConcurrency(concurrency(DAY))
applySeismo()

async function gotoDay(delta: number) {
  if (!dayIndex) return
  const next = Math.max(0, Math.min(dayIndex.days.length - 1, dayCursor + delta))
  if (next === dayCursor) return
  dayCursor = next
  const key = dayIndex.days[dayCursor]
  const pretty = new Date(`${key}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  applyDay((await loadDay(key)) ?? emptyDay(pretty))
}

async function gotoDate(key: string) {
  if (!dayIndex) return
  const next = dayIndex.days.indexOf(key)
  if (next < 0) return
  dayCursor = next
  const pretty = new Date(`${key}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  applyDay((await loadDay(key)) ?? emptyDay(pretty))
}

function applyDay(raw: DayData) {
  RAW_DAY = raw
  const day = filterDay(raw)
  DAY = day
  setGitHubStarPromptEligible(day !== MOCK_DAY && day.threads.length > 0)
  setDayWindow(day.meta.dayStart ?? 0, day.meta.dayEnd ?? 24, day === MOCK_DAY ? 0 : NOTCH_DEG)
  if (day !== MOCK_DAY) applyLanes(day)
  setLaneLayout(day === MOCK_DAY ? null : grooveCount(day))
  const skin = skinFor(skinId, day)
  scene.applySkinToDisc(skin) // re-derive spokes/ticks for the window
  arcs = resolveArcs(day.threads)
  scene.clearArcs()
  scene.buildArcs(arcs, skin)
  donutSegs = resolveDonut(donutData(day), ...donutRange(day)).map((s) => ({ a0: s.a0, a1: s.a1, category: s.category }))
  scene.setDonut(donutSegs, skin)
  splitDeg = providerSplitDeg(day)
  waveHorizon = waveHorizonFor(day, skin)
  scene.setProviderSplit(...splitDeg, ringGauge(), waveHorizon)
  scene.setConcurrency(concurrency(day))
  applySeismo()
  buildMarkers()
  rebuildOverlay()
  playIntro()
}

/** hex mixed toward white — `amount` is how much of the colour survives */
function tintToWhite(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (shift: number) => {
    const c = (n >> shift) & 255
    return Math.round(255 - (255 - c) * amount)
  }
  return `#${[ch(16), ch(8), ch(0)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

function buildMarkers() {
  scene.clearMarkers()
  const skin = skinFor(skinId, DAY)
  const glass = skinId === 'glass'
  for (const a of arcs) {
    const t = a.thread
    const color = skin.arcPalette[t.category]
    const [ex, ey] = polar(a.a1, a.radius)
    if (glass) {
      // glossy 3D ball endpoints
      const fill = t.state === 'unfinished' || t.state === 'blocked' ? '#f0a9a0' : color
      scene.addMarker(ex, ey, { rad: 6, fill, fillA: 1, stroke: fill, border: 0, gloss: 0.85, showAt: t.end })
    } else if (t.state === 'unfinished') {
      scene.addMarker(ex, ey, { rad: 6, fill: '#eeddd7', fillA: 1, stroke: '#ff6c52', border: 1, dashed: true, showAt: t.end })
    } else if (t.state === 'active') {
      // no ring — the provider badge from the overlay is the endpoint indicator
    }
    // The frame badges the start of every thread with its provider mark, but
    // seventeen of them crowd the grooves and pull the eye off the threads
    // themselves, so starts stay bare. Only an unfinished
    // thread is still called out, by the coral burst on its end.
  }
  scene.invalidate()
}
buildMarkers()

function setSkin(next: SkinId) {
  skinId = next
  localStorage.setItem('dayflow-skin', next)
  document.body.dataset.skin = next
  const skin = skinFor(next, DAY)
  scene.applySkinToDisc(skin)
  scene.applySkinToArcs(skin)
  scene.applySkinToCenter(skin)
  // Mock Paper and the technical mock skins use different center geometry;
  // switching skins must update the angles as well as repainting the colors.
  donutSegs = resolveDonut(donutData(DAY), ...donutRange(DAY)).map((s) => ({ a0: s.a0, a1: s.a1, category: s.category }))
  scene.setDonut(donutSegs, skin)
  waveHorizon = waveHorizonFor(DAY, skin)
  scene.setProviderSplit(...splitDeg, ringGauge(), waveHorizon)
  applySeismo() // the whisker baseline is the skin's own tick radius
  buildMarkers()
  rebuildOverlay()
}

function setLookMode(next: Look) {
  look = next
  localStorage.setItem(LOOK_KEY, next)
  setLook(next)
  const skin = skinFor(skinId, DAY)
  scene.applySkinToDisc(skin)
  scene.applySkinToArcs(skin)
  scene.applySkinToCenter(skin)
  waveHorizon = waveHorizonFor(DAY, skin)
  scene.setProviderSplit(...splitDeg, ringGauge(), waveHorizon)
  buildMarkers()
  rebuildOverlay()
}

// glass finish is liquid; ?fx=0|1 still overrides for experiments
let glassMode = Number(params.get('fx') ?? 2)
if (![0, 1, 2].includes(glassMode)) glassMode = 2
scene.setGlassMode(glassMode)

// re-lay the grooves in place (pack toggle / spacing slider) — no sweep replay
function rebuildGrooves() {
  if (DAY === MOCK_DAY) return
  applyLanes(DAY)
  setLaneLayout(grooveCount(DAY))
  const skin = skinFor(skinId, DAY)
  scene.applySkinToDisc(skin)
  arcs = resolveArcs(DAY.threads)
  scene.clearArcs()
  scene.buildArcs(arcs, skin)
  buildMarkers()
  applySeismo() // the seismo baseline rides the outermost groove
  applySweep()
  if (highlightDelays) applyDimTargets()
}

function setPack(on: boolean) {
  packOn = on
  localStorage.setItem('dayflow-pack-v2', on ? '1' : '0')
  rebuildGrooves()
}

function setSpacing(px: number) {
  spacing = px
  localStorage.setItem('dayflow-spacing-v2', String(px))
  setGrooveSpacing(px)
  rebuildGrooves()
}

function rebuildOverlay() {
  const wrappedDate = selectedDateKey()
  const wrappedReady = Boolean(
    dayIndex
    && !dayIndex.partial
    && !dayIndex.loading?.includes(wrappedDate)
    && DAY.threads.some((thread) => !thread.dotted),
  )
  const wrappedSeenKey = `agentplayback-wrapped-seen:${wrappedDate}`
  const wrappedSeen = localStorage.getItem(wrappedSeenKey) === '1'
  const wrappedShouldGlow = wrappedReady
    && !wrappedSeen
    && sessionStorage.getItem(WRAPPED_GLOW_SESSION_KEY) !== '1'
  if (wrappedShouldGlow) sessionStorage.setItem(WRAPPED_GLOW_SESSION_KEY, '1')
  buildOverlay(overlay, callouts, arcs, DAY, skinId, {
    onSkin: setSkin,
    skinVariant: variantId(skinId),
    onSkinVariant: (id) => {
      setVariant('vinyl', id)
      localStorage.setItem('dayflow-vinyl-v2', variantId('vinyl'))
      setSkin(skinId)
    },
    onNav: gotoDay,
    nextDayDisabled: selectedDateKey() === dayIndex?.today,
    onShare: () => {
      localStorage.setItem(wrappedSeenKey, '1')
      void openShareDialog({
        day: DAY,
        dayIndex,
        selectedDate: selectedDateKey(),
      })
    },
    shareReady: wrappedReady,
    shareSeen: wrappedSeen || !wrappedShouldGlow,
    calendar: dayIndex ? {
      selectedDate: selectedDateKey(),
      days: calendarDays,
      onSelect: (date) => { void gotoDate(date) },
    } : undefined,
    // the seismograph is gone: on real days the hour labels clear only the
    // disc itself (or an outer ring standing past it). The mock keeps its
    // authored whisker art, so its labels still clear the old fringe.
    labelClear: skinId === 'electric'
      ? skinFor(skinId, DAY).labelRadius
      : DAY === MOCK_DAY
      ? seismoBase() + Math.max(tickCfg.max, tickCfg.min + 1) + 10
      : (() => {
          const s = skinFor(skinId, DAY)
          // Paper's authored disc is transparent. Anchor its clock to the
          // visible groove annulus, not that invisible 500px boundary, so the
          // labels hug the ring the same way Vinyl's hug its visible platter.
          const visibleEdge = skinId === 'paper'
            ? Math.max(...s.ringFields.map((f) => f.r1), s.outerRing?.r ?? 0)
            : Math.max(s.discR, s.outerRing?.r ?? 0)
          return visibleEdge + labelGap
        })(),
    delays: {
      on: highlightDelays,
      onToggle: setHighlightDelays,
    },
    colors: {
      onChange: (project, color) => {
        setProjectColorOverride(skinId, project, color)
        projectColorOverrides = { ...projectColorOverrides, [skinId]: { ...(projectColorOverrides[skinId] ?? {}), [project]: color } }
        localStorage.setItem(COLOR_OVERRIDES_KEY, JSON.stringify(projectColorOverrides))
        const skin = skinFor(skinId, DAY)
        scene.applySkinToArcs(skin)
        scene.applySkinToCenter(skin)
      },
      onReset: (project) => {
        setProjectColorOverride(skinId, project, null)
        const next = { ...(projectColorOverrides[skinId] ?? {}) }
        delete next[project]
        projectColorOverrides = { ...projectColorOverrides, [skinId]: next }
        localStorage.setItem(COLOR_OVERRIDES_KEY, JSON.stringify(projectColorOverrides))
        const skin = skinFor(skinId, DAY)
        scene.applySkinToArcs(skin)
        scene.applySkinToCenter(skin)
      },
    },
    grooves: DAY === MOCK_DAY || skinId === 'electric' ? undefined
      : { pack: packOn, spacing, minLen: minLenMin, labelGap, tick: tickCfg, intro: INTROS[introIdx], look,
          onPack: setPack, onSpacing: setSpacing, onTick: setTick, onIntro: cycleIntro, onLook: setLookMode,
          onMinLen: (m: number) => {
            minLenMin = m
            localStorage.setItem('dayflow-minlen-v2', String(m))
            applyDay(RAW_DAY)
          },
          onLabelGap: (px: number) => {
            labelGap = px
            localStorage.setItem('dayflow-labelgap-v2', String(px))
            // re-lay the labels once the slider settles — an immediate rebuild
            // would recreate the slider out from under the drag
            clearTimeout(tickRebuild)
            tickRebuild = setTimeout(rebuildOverlay, 350)
          } },
  })
}
rebuildOverlay()

if (params.get('share') === '1') {
  requestAnimationFrame(() => {
    overlay.querySelector<HTMLButtonElement>('.share-trigger')?.click()
  })
}

// ---- intro sequences -------------------------------------------------------
// Six ways the dial can animate in, cycled by the header Intro button or
// pinned with ?intro=name. Every sequence ends in the same final state.

const sweep = { h: 24 }
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

let introTl: tween.Timeline | null = null
const INTRO_SESSION_KEY = 'dayflow-intro-played'

function finalize() {
  sweep.h = DAY_WIN.end
  applySweep()
  for (const h of scene.arcs) {
    h.uniforms.uProgress.value = 1
    h.uniforms.uDim.value = 1
    h.uniforms.uHi.value = 0
    h.uniforms.uR.value = laneRadius(h.thread.lane)
  }
  tween.set(canvas, { rotation: 0, scale: 1, opacity: 1 })
  tween.set([overlay, callouts], { opacity: 1 })
  applySeismo()
  // rebuilt arcs come up fully lit; re-assert the delay highlight if it's on
  if (highlightDelays) applyDimTargets()
  scene.invalidate()
}

function playIntro(force = false) {
  introTl?.kill()
  introTl = null
  if (!force && sessionStorage.getItem(INTRO_SESSION_KEY) === '1') {
    finalize()
    return
  }
  if (reduced || params.has('still') || DAY.threads.length === 0) {
    finalize()
    return
  }
  sessionStorage.setItem(INTRO_SESSION_KEY, '1')
  const name = INTROS[introIdx]
  const inv = () => scene.invalidate()
  const tl = tween.timeline({ onUpdate: inv, onComplete: finalize })
  introTl = tl

  if (name === 'flow') {
    // sweep that follows the day's rhythm: the hand spends its time where
    // the work is and rushes across dead air, so an empty afternoon no
    // longer plays as the animation stalling
    const spans: [number, number][] = []
    for (const t of [...DAY.threads].sort((a, b) => a.start - b.start)) {
      const last = spans[spans.length - 1]
      if (last && t.start <= last[1] + 0.2) last[1] = Math.max(last[1], t.end)
      else spans.push([t.start, t.end])
    }
    sweep.h = Math.max(DAY_WIN.start, spans[0][0] - 0.3)
    applySweep()
    const busy = spans.reduce((a, [s, e]) => a + (e - s), 0)
    let at = 0
    spans.forEach(([s, e], i) => {
      if (sweep.h < s && i > 0) {
        tl.to(sweep, { h: s, duration: 0.15, ease: 'power1.inOut', onUpdate: applySweep }, at)
        at += 0.15
      }
      const d = Math.max(((e - s) / busy) * 1.9, 0.15)
      const lastSpan = i === spans.length - 1
      tl.to(sweep, { h: e + 0.01, duration: d, ease: lastSpan ? 'power1.out' : 'none', onUpdate: applySweep }, at)
      at += d
    })
    return
  }

  if (name === 'sweep' || name === 'radar') {
    // a clock hand runs the day window; arcs draw as it passes. Radar adds a
    // rim flash that trails the hand and decays behind it.
    sweep.h = Math.max(DAY_WIN.start, Math.min(...DAY.threads.map((t) => t.start)) - 0.4)
    applySweep()
    const rim = name === 'radar'
    tl.to(sweep, {
      h: DAY_WIN.end, duration: rim ? 2.4 : 2.0, ease: 'power1.out',
      onUpdate: () => {
        applySweep()
        if (!rim) return
        for (const h of scene.arcs) {
          const on = sweep.h >= h.thread.start && sweep.h < h.thread.end
          h.uniforms.uHi.value = on ? 1 : Math.max(0, h.uniforms.uHi.value - 0.05)
        }
      },
    }, 0)
    return
  }

  // the rest start with the day fully swept (markers/labels gated open) and
  // animate the arcs themselves
  sweep.h = DAY_WIN.end
  applySweep()
  const n = Math.max(scene.arcs.length - 1, 1)

  if (name === 'bloom') {
    // no hand at all: threads grow out of their own start points in
    // chronological order, spaced by rank rather than clock time, so gaps
    // in the day cost nothing and every arc gets its own settle
    scene.arcs.forEach((h) => { h.uniforms.uProgress.value = 0 })
    const order = [...scene.arcs].sort((a, b) => a.thread.start - b.thread.start)
    const maxSpan = Math.max(...DAY.threads.map((t) => t.end - t.start), 0.1)
    order.forEach((h, i) => {
      const t0 = 0.1 + (i / Math.max(order.length - 1, 1)) * 1.0
      const dur = 0.5 + ((h.thread.end - h.thread.start) / maxSpan) * 0.7
      tl.to(h.uniforms.uProgress, { value: 1, duration: dur, ease: 'power3.out' }, t0)
    })
    tl.fromTo([overlay, callouts], { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'none' }, 0.8)
  } else if (name === 'needle') {
    // the platter drops in with a decelerating spin while arcs draw on
    tween.set(canvas, { transformOrigin: `${CENTER_X}px ${CENTER_Y}px` })
    tween.set(canvas, { rotation: -34, scale: 0.955, opacity: 0 })
    scene.arcs.forEach((h) => { h.uniforms.uProgress.value = 0 })
    tl.to(canvas, { rotation: 0, scale: 1, opacity: 1, duration: 1.5, ease: 'power3.out' }, 0)
    scene.arcs.forEach((h, i) => {
      tl.to(h.uniforms.uProgress, { value: 1, duration: 0.9, ease: 'power2.out' }, 0.3 + (i / n) * 0.7)
    })
    tl.fromTo([overlay, callouts], { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'none' }, 0.9)
  } else if (name === 'burst') {
    // everything erupts from the center: arcs fly out to their grooves
    // (inner lanes first), then the seismograph rises
    const radii = scene.arcs.map((h) => laneRadius(h.thread.lane))
    const rMin = Math.min(...radii)
    const rMax = Math.max(...radii)
    applySeismo(0)
    scene.arcs.forEach((h) => {
      h.uniforms.uR.value = 170
      h.uniforms.uProgress.value = 0
      h.uniforms.uDim.value = 0
    })
    scene.arcs.forEach((h, i) => {
      const t0 = 0.1 + ((radii[i] - rMin) / Math.max(rMax - rMin, 1)) * 0.45
      tl.to(h.uniforms.uR, { value: radii[i], duration: 0.9, ease: 'power3.out' }, t0)
      tl.to(h.uniforms.uDim, { value: 1, duration: 0.35, ease: 'none' }, t0)
      tl.to(h.uniforms.uProgress, { value: 1, duration: 0.7, ease: 'power2.out' }, t0 + 0.12)
    })
    const seis = { k: 0 }
    tl.to(seis, { k: 1, duration: 0.8, ease: 'power2.out', onUpdate: () => applySeismo(seis.k) }, 0.85)
    tl.fromTo([overlay, callouts], { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'none' }, 1.0)
  } else if (name === 'trace') {
    // styluses: every arc traces from its start at the same angular speed,
    // so short sessions finish early while marathons keep cutting
    const maxSpan = Math.max(...DAY.threads.map((t) => t.end - t.start), 0.1)
    scene.arcs.forEach((h) => { h.uniforms.uProgress.value = 0 })
    tween.set(canvas, { opacity: 0 })
    tl.to(canvas, { opacity: 1, duration: 0.35, ease: 'none' }, 0)
    scene.arcs.forEach((h) => {
      const dur = ((h.thread.end - h.thread.start) / maxSpan) * 1.8
      tl.to(h.uniforms.uProgress, { value: 1, duration: Math.max(dur, 0.12), ease: 'none' }, 0.25)
    })
    tl.fromTo([overlay, callouts], { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'none' }, 1.2)
  } else {
    // cascade: threads power on in chronological order, each with a rim
    // flash, while the seismograph rises underneath
    applySeismo(0)
    scene.arcs.forEach((h) => { h.uniforms.uDim.value = 0 })
    const order = [...scene.arcs].sort((a, b) => a.thread.start - b.thread.start)
    order.forEach((h, i) => {
      const t0 = 0.15 + (i / Math.max(order.length - 1, 1)) * 1.4
      tl.to(h.uniforms.uDim, { value: 1, duration: 0.3, ease: 'power2.out' }, t0)
      tl.fromTo(h.uniforms.uHi, { value: 1 }, { value: 0, duration: 0.55, ease: 'power2.out', immediateRender: false }, t0 + 0.12)
    })
    const seis = { k: 0 }
    tl.to(seis, { k: 1, duration: 1.5, ease: 'power1.inOut', onUpdate: () => applySeismo(seis.k) }, 0.2)
    tl.fromTo([overlay, callouts], { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'none' }, 1.1)
  }
}

function cycleIntro(): string {
  introIdx = (introIdx + 1) % INTROS.length
  localStorage.setItem('dayflow-intro-v2', INTROS[introIdx])
  // The explicit Intro control is an intentional preview and may replay;
  // automatic loads and data changes remain once-per-session.
  playIntro(true)
  return INTROS[introIdx]
}

function applySweep() {
  for (const h of scene.arcs) {
    const t = h.thread
    const p = Math.max(0, Math.min(1, (sweep.h - t.start) / (t.end - t.start)))
    // smoothstep, not the raw ramp: slaved linearly to the hand, every arc
    // was a wipe at identical angular speed that popped on and stopped dead.
    // Shaping per arc lets each one ease out of its birth and settle into
    // its endpoint while the hand keeps moving.
    h.uniforms.uProgress.value = p * p * (3 - 2 * p)
  }
  scene.applyClock(sweep.h)
  for (const el of overlay.querySelectorAll<HTMLElement>('[data-show-at]')) {
    el.style.visibility = sweep.h >= Number(el.dataset.showAt) ? 'visible' : 'hidden'
  }
}

playIntro()

// ---- hover: polar hit-test, dim others, show the thread card ----

function hoverTip(): HTMLElement {
  let el = overlay.querySelector<HTMLElement>('#hover-tip')
  if (!el) {
    el = document.createElement('div')
    el.id = 'hover-tip'
    el.className = 'tooltip-card hover-tip'
    el.style.visibility = 'hidden'
    overlay.appendChild(el)
  }
  return el
}

// Three hover tiers: a dial arc highlights that one thread; a donut category
// chip highlights every thread of that project; the center provider wedges
// highlight everything a provider ran.
type Hover =
  | { kind: 'thread'; id: string }
  | { kind: 'category'; cat: string }
  | { kind: 'provider'; provider: string }

const hoverKey = (h: Hover | null) =>
  h === null ? '' : h.kind === 'thread' ? `t:${h.id}` : h.kind === 'category' ? `c:${h.cat}` : `p:${h.provider}`

const litFor = (t: Thread, h: Hover) =>
  (h.kind === 'thread' && t.id === h.id) ||
  (h.kind === 'category' && t.category === h.cat) ||
  (h.kind === 'provider' && t.provider === h.provider)

const HOVER_DEG = Math.PI / 180

function hitTest(x: number, y: number): Hover | null {
  const { angle, radius } = toPolar(x, y)
  const layout = getLaneLayout()
  const tol = layout ? Math.min(8, layout.step / 2) : 8
  // hit-test the arc as drawn, not as timed: short sessions are widened to the
  // minimum readable span, and testing thread.start/end would leave those
  // grown pixels dead to the pointer
  for (const a of scene.arcs) {
    if (a.connector) continue // gap bridges aren't work — no tooltip on them
    if (Math.abs(radius - (a.uniforms.uR.value as number)) > tol) continue
    if (angle >= (a.uniforms.uA0.value as number) && angle <= (a.uniforms.uA1.value as number)) {
      return { kind: 'thread', id: a.thread.id }
    }
  }
  const skin = skinFor(skinId, DAY)
  const ringR = skin.center?.ringR ?? CENTER.gaugeR
  const ringW = skin.center?.ringW ?? CENTER.gaugeW
  if (Math.abs(radius - ringR) <= ringW / 2 + 2) {
    for (const s of donutSegs) {
      if (angle >= s.a0 && angle <= s.a1) return { kind: 'category', cat: s.category }
    }
    return null
  }
  if (radius > CENTER.spindleR + 4 && radius < ringR - ringW / 2 - 4) {
    // pie skins split by wedge angle, wave skins at the horizon chord — both
    // follow whatever boundary is actually painted
    if (skin.innerMode === 'wave') {
      return { kind: 'provider', provider: CENTER_Y - y > waveHorizon ? 'openai' : 'claude' }
    }
    const openai = angle >= splitDeg[0] * HOVER_DEG || angle < splitDeg[1] * HOVER_DEG
    return { kind: 'provider', provider: openai ? 'openai' : 'claude' }
  }
  return null
}

function setHover(hit: Hover | null, tipAt?: { x: number; y: number }) {
  // current hover target, readable from the console / driven browsers
  ;(window as unknown as { __hover?: string }).__hover = hoverKey(hit)
  if (hoverKey(hit) === hoverKey(hovered)) return
  hovered = hit
  applyDimTargets()
  // center hover: retarget instantly, ease the intensity — the target keeps
  // its last value while fading out so the effect doesn't jump elements
  let centerAmt = 0
  if (hit?.kind === 'category') {
    const idx = donutSegs.findIndex((s) => s.category === hit.cat)
    if (idx >= 0) { scene.setCenterHoverTarget(1, idx, 0); centerAmt = 1 }
  } else if (hit?.kind === 'provider') {
    scene.setCenterHoverTarget(2, -1, hit.provider === 'openai' ? 0 : 1)
    centerAmt = 1
  }
  // (hovering a single arc deliberately does NOT light up its project's chip —
  // the association only runs from the center outward)
  centerAmt = 0
  const amt = scene.centerUniforms.uHovAmt
  if (amt) tween.to(amt, { value: centerAmt, duration: 0.22, ease: 'power2.out', onUpdate: () => scene.invalidate() })
  canvas.style.cursor = hit ? 'pointer' : 'default'
  const tip = hoverTip()
  const t = hit?.kind === 'thread' ? DAY.threads.find((th) => th.id === hit.id) : undefined
  // the list already shows the title, so a card chasing the cursor over it is
  // noise — the dial keeps the tooltip, the column doesn't
  if (t && tipAt) {
    const label = DAY.labels[t.category as keyof typeof DAY.labels] ?? t.category
    tip.innerHTML = `
      <div class="tooltip-head">
        <img src="/assets/${t.provider === 'openai' ? 'openai-mark.svg' : 'claude-spark.png'}" width="14" height="14" alt="" />
        <span class="tooltip-chip">${label}</span>
      </div>
      <div>${t.title ?? t.summary ?? label}</div>
      <div class="tooltip-time">${fmtClock(t.start)} - ${fmtClock(t.end)}${
        t.usd ? `<span class="tooltip-cost">${t.usd >= 0.01 ? `$${t.usd.toFixed(2)}` : '<$0.01'}</span>` : ''
      }</div>`
    tip.style.visibility = 'visible'
  } else {
    tip.style.visibility = 'hidden'
  }
}

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * STAGE_W
  const y = ((e.clientY - rect.top) / rect.height) * STAGE_H
  setHover(hitTest(x, y), { x, y })
  if (hovered?.kind === 'thread') {
    const tip = hoverTip()
    tip.style.left = `${Math.min(x + 18, STAGE_W - 230)}px`
    tip.style.top = `${Math.min(y + 18, STAGE_H - 140)}px`
  }
})
canvas.addEventListener('pointerleave', () => setHover(null))

// kick a background rescan of the logs so the data self-refreshes; the page
// renders the cached JSON now and shows fresh data on the next reload
fetch('/api/scan', { method: 'POST' }).catch(() => {})

// The CLI opens the page on a quick today-only scan while a full pass
// backfills history; the index carries partial:true until that lands. Poll
// it, then swap in the full day list (and the day's final colors) in place.
async function refreshDayIndex() {
  const next = await loadDayIndex()
  if (!next) return
  const previous = dayIndex
  const same = previous && next.revision != null && next.revision === previous.revision
  const selected = selectedDateKey()
  dayIndex = next
  if (same) return
  const at = next.days.indexOf(selected)
  dayCursor = at >= 0 ? at : next.days.length - 1
  const updatedCalendar = await buildCalendar(next)
  updateCalendarProgressively(updatedCalendar)
  // The calendar progresses cell-by-cell. Refresh the selected dial only once
  // when the backfill finishes, which also applies the final project colors.
  if (previous?.partial && !next.partial) {
    setProjectColorOrder(next.projectColorOrder ?? [])
    const key = next.days[dayCursor]
    applyDay((await loadDay(key === next.today ? undefined : key)) ?? RAW_DAY)
  }
}
if (dayIndex?.partial) {
  const timer = setInterval(async () => {
    await refreshDayIndex()
    if (!dayIndex?.partial) clearInterval(timer)
  }, 500)
}

// ---- render on demand via the tween ticker ----

tween.ticker.add(() => scene.renderIfNeeded())
scene.invalidate()
