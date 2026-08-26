// HTML + SVG chrome: header, legend, toggle, hour labels, donut callouts,
// curved gauge text, tooltip. All positions come from the geometry core.

import {
  CENTER_X, CENTER_Y, CENTER, DONUT_FULL, NOTCH_DEG, polar, hourToAngle,
  resolveHourLabels, resolveDonut, type ResolvedArc,
} from './geometry'
import { MOCK_DAY, PAPER_MOCK_DONUT, threadDur, type DayData, type Thread } from './data'
import { SKINS, type SkinId } from './skins'
import { skinFor, waveHorizonFor } from './palette'
import { variantsFor } from './vinylvariants'
import { buildCodePanel, buildTokenPanel, panelShell } from './panels'

/** the delay-hatch treatments the arc shader knows (uHatchStyle index) —
 *  all static by decree */
export const HATCH_STYLES = [
  'Hairline', 'Candy', 'Beads', 'Dashes', 'Crosshatch',
  'Chevron', 'Solid', 'Rails', 'Break', 'Crossties',
  'Sparkle', 'Ember', 'Coil',
] as const

const SVG_NS = 'http://www.w3.org/2000/svg'
const SHOW_GROOVE_CONTROLS = false
const SHOW_SKIN_VARIANTS = false

export interface GrooveControls {
  pack: boolean
  spacing: number
  /** minimum arc length (minutes) that renders; 0 = show everything */
  minLen: number
  /** gap (px) between the disc/outer-ring edge and the hour-label clearance circle */
  labelGap: number
  tick: { spacing: number; offset: number; min: number; max: number }
  /** current intro sequence name; the button cycles + replays */
  intro: string
  /** classic = quiet authored balance; bold = data-first contrast */
  look: 'classic' | 'bold'
  onPack: (on: boolean) => void
  onSpacing: (px: number) => void
  onMinLen: (min: number) => void
  onLabelGap: (px: number) => void
  onTick: (key: 'spacing' | 'offset' | 'min' | 'max', v: number) => void
  onIntro: () => string
  onLook: (look: 'classic' | 'bold') => void
}

export interface OverlayHooks {
  onSkin: (s: SkinId) => void
  skinVariant?: string
  onSkinVariant?: (id: string) => void
  onNav?: (delta: number) => void
  grooves?: GrooveControls
  /** hour labels clear this radius — the seismograph's outer extent, so the
   *  clock ring can never collide with the whisker ticks */
  labelClear?: number
  /** the legend's response-delay visibility/highlight toggle */
  delays?: {
    on: boolean
    onToggle: (on: boolean) => void
  }
  colors?: {
    onChange: (project: string, color: string) => void
    onReset: (project: string) => void
  }
  calendar?: {
    selectedDate: string
    days: CalendarDaySummary[]
    onSelect: (date: string) => void
  }
}

export interface CalendarDaySummary {
  date: string
  agents: number
  cost: number
  loading?: boolean
}

// ---- formatting ------------------------------------------------------------

export function fmtClock(h: number): string {
  const mins = Math.round(h * 60)
  let hh = Math.floor(mins / 60) % 24
  const mm = mins % 60
  const ap = hh < 12 ? 'AM' : 'PM'
  hh = hh % 12 || 12
  return `${hh}:${String(mm).padStart(2, '0')} ${ap}`
}

/** "3 hr 12 min" / "42 min" / "< 1 min" */
export function fmtDur(hours: number): string {
  const mins = Math.round(hours * 60)
  if (mins < 1) return '< 1 min'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (!h) return `${m} min`
  return m ? `${h} hr ${m} min` : `${h} hr`
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const providerIcon = (p: string) =>
  p === 'openai' ? '/assets/openai-mark.svg' : '/assets/claude-spark.png'

function providerHours(day: DayData, p: string): number {
  return day.threads.filter((t) => t.provider === p).reduce((a, t) => a + threadDur(t), 0)
}

/** provider mark anchors inside the split disc, as [x, y] offsets from the
 *  disc center (screen coords, y down). The boundary between the two fields
 *  moves with the real provider share — wave skins flood by area, pie skins
 *  split by wedge — so each logo centers in its own region instead of
 *  sitting at the mock's fixed offsets (where a lopsided day would strand a
 *  logo inside the other provider's field). */
function splitMarkOffsets(
  day: DayData, skin: ReturnType<typeof skinFor>,
): { openai: [number, number]; claude: [number, number] } {
  const R = skin.center?.innerR ?? CENTER.innerR
  const clamp = (y: number) => Math.max(-(R - 16), Math.min(R - 16, y))
  if (skin.innerMode === 'wave') {
    const d = waveHorizonFor(day, skin) // horizon height, up-positive
    return {
      openai: [0, clamp(-(d + R) / 2)], // midpoint of the region above
      claude: [0, clamp((R - d) / 2)], // …and below the horizon
    }
  }
  // In the Paper frame the marks sit at the visual centers of the two fields,
  // about 53px above/below center inside the 78px disc.
  return { openai: [0, -R * 0.68], claude: [0, R * 0.68] }
}

// ---- shared pieces ---------------------------------------------------------

function skinToggleHTML(active: SkinId, skins: SkinId[], labels: Record<string, string>): string {
  return `<div class="skin-toggle">${skins
    .map((s) => `<button class="clickable${s === active ? ' active' : ''}" data-s="${s}">${labels[s]}</button>`)
    .join('')}</div>`
}

const COLOR_PRESETS: Record<Exclude<SkinId, 'glass'>, string[]> = {
  paper: ['#f0ad98', '#f4cd72', '#b9e97d', '#86d7bd', '#65bfdc', '#5765ff', '#a270e8', '#ec8ac7'],
  vinyl: ['#f0ad98', '#f4cd72', '#b9e97d', '#86d7bd', '#65bfdc', '#5765ff', '#a270e8', '#ec8ac7'],
  electric: ['#ffb561', '#ffe66d', '#81eebf', '#58d0c7', '#38bfe8', '#3370ff', '#ad70e8', '#ec8ac7'],
}

let colorPickerOpen = false
let selectedColorProject = ''

function hexToHsv(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [((h * 60 + 360) % 360), max === 0 ? 0 : d / max, max]
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return `#${[r, g, b].map((n) => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('')}`
}

// The Figma wheel places the familiar hue landmarks by eye rather than at
// mathematically equal HSV intervals. Keep hit-testing and handle placement
// on the same piecewise scale as the rendered conic-gradient stops.
const HUE_RING_STOPS = [
  [0, 60], [45, 30], [90, 0], [135, -30], [180, -90],
  [225, -120], [270, -180], [315, -240], [360, -300],
] as const

function ringAngleToHue(angle: number): number {
  const a = (angle + 360) % 360
  const i = Math.min(Math.floor(a / 45), HUE_RING_STOPS.length - 2)
  const [a0, h0] = HUE_RING_STOPS[i]
  const [a1, h1] = HUE_RING_STOPS[i + 1]
  return ((h0 + (h1 - h0) * ((a - a0) / (a1 - a0))) + 360) % 360
}

function hueToRingAngle(hue: number): number {
  const h = hue <= 60 ? hue : hue - 360
  for (let i = 0; i < HUE_RING_STOPS.length - 1; i++) {
    const [a0, h0] = HUE_RING_STOPS[i]
    const [a1, h1] = HUE_RING_STOPS[i + 1]
    if (h <= h0 && h >= h1) return a0 + (a1 - a0) * ((h0 - h) / (h0 - h1))
  }
  return 0
}

function colorEditorEl(day: DayData, activeSkin: SkinId, skin: ReturnType<typeof skinFor>, hooks: OverlayHooks): HTMLElement | null {
  if (activeSkin === 'glass' || !hooks.colors) return null
  const projects = Object.entries(day.labels) as [keyof typeof skin.donutPalette, string][]
  if (!projects.length) return null
  if (!projects.some(([, name]) => name === selectedColorProject)) selectedColorProject = projects[0][1]
  const selected = projects.find(([, name]) => name === selectedColorProject) ?? projects[0]
  let currentColor = skin.donutPalette[selected[0]] ?? '#5765ff'
  let [hue, saturation, value] = hexToHsv(currentColor)
  const editor = document.createElement('section')
  editor.className = `color-editor${colorPickerOpen ? ' open' : ''}`
  editor.innerHTML = `
    <button class="color-editor-header clickable" type="button" aria-expanded="${colorPickerOpen}" aria-label="${colorPickerOpen ? 'Close' : 'Open'} color editor">
      <span class="color-editor-title">${colorPickerOpen ? '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="m3.2 11.8 1-3.1 6.9-6.9 3.1 3.1-6.9 6.9-3.1 1zM10 2.9l3.1 3.1"/></svg>' : ''}Edit colors</span>
      <span class="color-editor-chevron" aria-hidden="true"></span>
    </button>
    ${colorPickerOpen ? `<div class="color-editor-body">
      <div class="color-projects">${projects.map(([category, name]) => {
        const color = skin.donutPalette[category] ?? '#cccccc'
        return `<button type="button" class="color-project clickable${name === selectedColorProject ? ' active' : ''}" data-project="${esc(name)}" data-category="${category}"><span style="background:${color}"></span>${esc(name)}</button>`
      }).join('')}</div>
      <div class="color-picker-surface">
        <div class="color-wheel clickable" role="slider" aria-label="Project color" tabindex="0">
          <div class="color-sv"><span class="color-sv-thumb"></span></div>
          <span class="color-hue-thumb"></span>
        </div>
        <div class="color-presets">${COLOR_PRESETS[activeSkin].map((color) => `<button type="button" class="color-preset clickable" data-color="${color}" style="background:${color}" aria-label="Use ${color}"></button>`).join('')}</div>
      </div>
    </div>` : ''}`

  editor.querySelector<HTMLButtonElement>('.color-editor-header')!.addEventListener('click', () => {
    colorPickerOpen = !colorPickerOpen
    editor.replaceWith(colorEditorEl(day, activeSkin, skinFor(activeSkin, day), hooks)!)
  })
  if (!colorPickerOpen) return editor

  const wheel = editor.querySelector<HTMLElement>('.color-wheel')!
  const sv = editor.querySelector<HTMLElement>('.color-sv')!
  const hueThumb = editor.querySelector<HTMLElement>('.color-hue-thumb')!
  const svThumb = editor.querySelector<HTMLElement>('.color-sv-thumb')!
  const paintControls = () => {
    currentColor = hsvToHex(hue, saturation, value)
    sv.style.backgroundColor = `hsl(${hue} 100% 50%)`
    svThumb.style.left = `${saturation * 100}%`
    svThumb.style.top = `${(1 - value) * 100}%`
    const angle = hueToRingAngle(hue) * Math.PI / 180
    hueThumb.style.left = `${105 + Math.sin(angle) * 96}px`
    hueThumb.style.top = `${105 - Math.cos(angle) * 96}px`
    hueThumb.style.background = `hsl(${hue} 100% 50%)`
  }
  const applyColor = (color: string) => {
    currentColor = color
    ;[hue, saturation, value] = hexToHsv(color)
    paintControls()
    editor.querySelector<HTMLButtonElement>('.color-project.active span')!.style.background = color
    hooks.colors!.onChange(selectedColorProject, color)
  }
  paintControls()
  editor.querySelectorAll<HTMLButtonElement>('.color-project').forEach((button) => {
    button.addEventListener('click', () => {
      selectedColorProject = button.dataset.project!
      editor.replaceWith(colorEditorEl(day, activeSkin, skinFor(activeSkin, day), hooks)!)
    })
  })
  editor.querySelectorAll<HTMLButtonElement>('.color-preset').forEach((button) => {
    button.addEventListener('click', () => applyColor(button.dataset.color!))
  })
  let dragMode: 'hue' | 'sv' = 'sv'
  const move = (event: PointerEvent) => {
    const rect = wheel.getBoundingClientRect()
    const x = event.clientX - rect.left - rect.width / 2
    const y = event.clientY - rect.top - rect.height / 2
    if (dragMode === 'hue') {
      const angleFromTop = (Math.atan2(y, x) * 180 / Math.PI + 450) % 360
      hue = ringAngleToHue(angleFromTop)
    }
    else {
      const box = sv.getBoundingClientRect()
      saturation = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
      value = 1 - Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))
    }
    applyColor(hsvToHex(hue, saturation, value))
  }
  wheel.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    const rect = wheel.getBoundingClientRect()
    const x = event.clientX - rect.left - rect.width / 2
    const y = event.clientY - rect.top - rect.height / 2
    // The whole authored stage is responsively scaled with CSS. Pointer
    // coordinates and getBoundingClientRect() are viewport pixels, so the
    // ring cutoff must scale with the rendered wheel as well; a fixed 87px
    // cutoff made the hue ring impossible to enter below 100% stage scale.
    dragMode = Math.hypot(x, y) > rect.width * (87 / 210) ? 'hue' : 'sv'
    wheel.setPointerCapture(event.pointerId)
    move(event)
  })
  wheel.addEventListener('pointermove', (event) => {
    if (!wheel.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    move(event)
  })
  return editor
}

const SKIN_LABEL: Record<SkinId, string> = {
  paper: 'Paper', vinyl: 'Vinyl', electric: 'Electric', glass: 'Glass',
}

function skinVariantHTML(skin: SkinId, hooks: OverlayHooks): string {
  if (!SHOW_SKIN_VARIANTS || skin !== 'vinyl' || !hooks.onSkinVariant) return ''
  const set = variantsFor(skin) ?? []
  return `<div class="vinyl-variants" aria-label="Vinyl material variations">${set.map((v) =>
    `<button class="clickable${v.id === hooks.skinVariant ? ' active' : ''}" data-v="${v.id}">${v.label}</button>`)
    .join('')}</div>`
}

/** the debug rail — groove packing, tick tuning, intro cycling, look */
function grooveControlsEl(grooves: GrooveControls): HTMLElement {
  const t = grooves.tick
  const gc = document.createElement('div')
  gc.className = 'groove-controls'
  gc.innerHTML = `
    <div class="gc-row">
      <button class="clickable pack-btn${grooves.pack ? ' active' : ''}">Shared grooves</button>
      <button class="clickable tick-btn">Ticks</button>
      <button class="clickable intro-btn" title="Cycle intro animation">▶ ${grooves.intro}</button>
    </div>
    <div class="gc-row">
      <button class="clickable look-btn${grooves.look === 'classic' ? ' active' : ''}" data-look="classic">Classic</button>
      <button class="clickable look-btn${grooves.look === 'bold' ? ' active' : ''}" data-look="bold">Bold</button>
    </div>
    <label class="spacing-row"><span class="gc-lbl">Spacing</span>
      <input class="clickable" type="range" min="8" max="30" step="1" value="${grooves.spacing}" />
      <span class="spacing-val">${grooves.spacing}px</span>
    </label>
    <label class="spacing-row" title="Hide arcs shorter than this"><span class="gc-lbl">Min length</span>
      <input class="clickable minlen-input" data-k="minlen" type="range" min="0" max="30" step="1" value="${grooves.minLen}" />
      <span class="spacing-val">${grooves.minLen ? `${grooves.minLen}m` : 'all'}</span>
    </label>
    <label class="spacing-row" title="Gap between the dial edge and the hour labels"><span class="gc-lbl">Label gap</span>
      <input class="clickable labelgap-input" data-k="labelgap" type="range" min="0" max="40" step="1" value="${grooves.labelGap}" />
      <span class="spacing-val">${grooves.labelGap}px</span>
    </label>
    <div class="tick-panel" hidden>
      <label class="spacing-row"><span class="gc-lbl">Every</span>
        <input class="clickable" data-k="spacing" type="range" min="4" max="24" step="1" value="${t.spacing}" />
        <span class="spacing-val">${t.spacing}px</span>
      </label>
      <label class="spacing-row"><span class="gc-lbl">Gap</span>
        <input class="clickable" data-k="offset" type="range" min="4" max="60" step="1" value="${t.offset}" />
        <span class="spacing-val">${t.offset}px</span>
      </label>
      <label class="spacing-row"><span class="gc-lbl">Min</span>
        <input class="clickable" data-k="min" type="range" min="0" max="20" step="1" value="${t.min}" />
        <span class="spacing-val">${t.min}px</span>
      </label>
      <label class="spacing-row"><span class="gc-lbl">Max</span>
        <input class="clickable" data-k="max" type="range" min="10" max="90" step="1" value="${t.max}" />
        <span class="spacing-val">${t.max}px</span>
      </label>
    </div>`
  const packBtn = gc.querySelector<HTMLButtonElement>('.pack-btn')!
  packBtn.addEventListener('click', () => grooves.onPack(packBtn.classList.toggle('active')))
  gc.querySelectorAll<HTMLButtonElement>('.look-btn').forEach((b) => {
    b.addEventListener('click', () => grooves.onLook(b.dataset.look as 'classic' | 'bold'))
  })
  const introBtn = gc.querySelector<HTMLButtonElement>('.intro-btn')!
  introBtn.addEventListener('click', () => { introBtn.textContent = `▶ ${grooves.onIntro()}` })
  const tickBtn = gc.querySelector<HTMLButtonElement>('.tick-btn')!
  const panel = gc.querySelector<HTMLElement>('.tick-panel')!
  tickBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    tickBtn.classList.toggle('active', !panel.hidden)
  })
  const slider = gc.querySelector<HTMLInputElement>('.spacing-row input:not([data-k])')!
  slider.addEventListener('input', () => {
    slider.nextElementSibling!.textContent = `${slider.value}px`
    grooves.onSpacing(Number(slider.value))
  })
  const minLenEl = gc.querySelector<HTMLInputElement>('.minlen-input')!
  minLenEl.addEventListener('input', () => {
    minLenEl.nextElementSibling!.textContent = Number(minLenEl.value) ? `${minLenEl.value}m` : 'all'
    grooves.onMinLen(Number(minLenEl.value))
  })
  const labelGapEl = gc.querySelector<HTMLInputElement>('.labelgap-input')!
  labelGapEl.addEventListener('input', () => {
    labelGapEl.nextElementSibling!.textContent = `${labelGapEl.value}px`
    grooves.onLabelGap(Number(labelGapEl.value))
  })
  panel.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) => {
    inp.addEventListener('input', () => {
      inp.nextElementSibling!.textContent = `${inp.value}px`
      grooves.onTick(inp.dataset.k as 'spacing' | 'offset' | 'min' | 'max', Number(inp.value))
    })
  })
  return gc
}

// ---- entry point -----------------------------------------------------------

/**
 * The master frame ships a two-tab picker — Vinyl and Electric — but Paper
 * (node 599:2350) earned its slot back by request. Glass still hides behind
 * ?skin=glass.
 */
const PICKER_SKINS: SkinId[] = ['paper', 'vinyl', 'electric']

function compactDuration(hours: number): string {
  const mins = Math.max(0, Math.round(hours * 60))
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}

function buildPlaybackBrand(): HTMLElement {
  const brand = document.createElement('a')
  brand.className = 'playback-brand'
  brand.href = 'https://dayflow.so/?utm_source=agentplayback&utm_medium=referral'
  brand.target = '_blank'
  brand.rel = 'noopener noreferrer'
  brand.textContent = 'AgentPlayback by Dayflow'
  return brand
}

function buildSummaryPanel(day: DayData): HTMLElement {
  const total = day.threads.reduce((sum, t) => sum + threadDur(t), 0)
  const tasks = day.threads.filter((t) => !t.dotted).length
  const projects = new Set(day.donut.filter((d) => d.hours > 0).map((d) => d.category)).size
  const waiting = day.threads.reduce((sum, t) => {
    const fraction = (t.blockedRanges ?? []).reduce((n, [a, b]) => n + Math.max(0, b - a), 0)
    return sum + threadDur(t) * fraction
  }, 0)
  const { el, body } = panelShell('summary', 'Summary', 'summary-panel')
  body.innerHTML = `
    <div class="summary-total"><span>Total hours worked by agents</span><strong>${compactDuration(total)}</strong></div>
    <div class="summary-rows">
      <div><span>Agents</span><b>${tasks}</b></div>
      <div><span>Projects</span><b>${projects}</b></div>
      <div><span>Waiting on your input</span><b>${compactDuration(waiting)}</b></div>
    </div>`
  return el
}

let calendarOpen = false
let calendarMonth = ''
let calendarOutsideHandler: ((event: PointerEvent) => void) | null = null
let rerenderOpenCalendar: (() => void) | null = null

/** Patch the open calendar from its live days array without rebuilding the
 * dial, header, or the rest of the overlay. */
export function refreshOpenCalendar() {
  rerenderOpenCalendar?.()
}

function calendarCard(calendar: NonNullable<OverlayHooks['calendar']>): HTMLElement {
  const card = document.createElement('div')
  card.className = 'calendar-popover'

  const render = () => {
    const byDate = new Map(calendar.days.map((d) => [d.date, d]))
    const selectedMonth = calendar.selectedDate.slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(calendarMonth)) calendarMonth = selectedMonth
    const [year, month] = calendarMonth.split('-').map(Number)
    const firstWeekday = new Date(year, month - 1, 1, 12).getDay()
    const daysInMonth = new Date(year, month, 0, 12).getDate()
    const weeks = Math.max(5, Math.ceil((firstWeekday + daysInMonth) / 7))
    const firstCell = 1 - firstWeekday
    const monthRows = calendar.days.filter((d) => d.date.startsWith(`${calendarMonth}-`) && !d.loading)
    const monthMax = Math.max(...monthRows.map((d) => d.cost), 0)
    const monthLabel = new Date(year, month - 1, 1, 12).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric',
    })
    const cells = Array.from({ length: weeks * 7 }, (_, i) => {
      const dt = new Date(year, month - 1, firstCell + i, 12)
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      const datum = byDate.get(key)
      const inMonth = dt.getMonth() === month - 1
      // Adjacent-month dates are calendar context only. Even when we have data
      // for them, keep the cell grey and defer its heat/value treatment until
      // that month is actually being viewed.
      const visibleDatum = inMonth ? datum : undefined
      const loadedDatum = visibleDatum && !visibleDatum.loading ? visibleDatum : undefined
      const ratio = loadedDatum && monthMax > 0 ? Math.min(1, loadedDatum.cost / monthMax) : 0
      const alpha = ratio > 0 ? 0.14 + ratio * 0.86 : 0
      // Electric's authored heat scale moves from its HUD blue toward teal as
      // the day approaches the month's highest cost. Other skins continue to
      // consume only --cost-alpha and keep their existing single-hue scale.
      const electricCostRgb = [
        Math.round(0 + (2 - 0) * ratio),
        Math.round(106 + (236 - 106) * ratio),
        Math.round(199 + (201 - 199) * ratio),
      ].join(',')
      const style = ratio > 0
        ? ` style="--cost-alpha:${alpha.toFixed(3)};--electric-cost-rgb:${electricCostRgb}"`
        : ''
      const loading = visibleDatum?.loading ? ' loading' : ''
      const selectable = loadedDatum ? ' clickable' : ''
      const selected = key === calendar.selectedDate ? ' selected' : ''
      const outside = inMonth ? '' : ' outside'
      const empty = visibleDatum ? '' : ' empty'
      const agents = visibleDatum?.loading
        ? 'Loading…'
        : loadedDatum ? `${loadedDatum.agents} ${loadedDatum.agents === 1 ? 'agent' : 'agents'}` : ''
      const cost = loadedDatum && loadedDatum.cost > 0
        ? loadedDatum.cost.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
        : ''
      return `<button class="calendar-day${selectable}${selected}${outside}${empty}${loading}" data-date="${key}"${loadedDatum ? '' : ' disabled'}${style}>
        <span class="calendar-date">${dt.getDate()}</span>
        <span class="calendar-agents">${agents}</span>
        <span class="calendar-cost">${cost}</span>
      </button>`
    }).join('')

    card.innerHTML = `
      <div class="calendar-head">
        <strong>${monthLabel}</strong>
        <div class="calendar-month-nav">
          <button class="calendar-prev clickable" aria-label="Previous month">‹</button>
          <button class="calendar-next clickable" aria-label="Next month">›</button>
        </div>
      </div>
      <div class="calendar-weekdays">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="calendar-grid">${cells}</div>`

    const shiftMonth = (delta: number) => {
      const next = new Date(year, month - 1 + delta, 1, 12)
      calendarMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`
      render()
    }
    card.querySelector<HTMLButtonElement>('.calendar-prev')!.addEventListener('click', () => shiftMonth(-1))
    card.querySelector<HTMLButtonElement>('.calendar-next')!.addEventListener('click', () => shiftMonth(1))
    card.querySelectorAll<HTMLButtonElement>('.calendar-day[data-date]:not(:disabled)').forEach((button) => {
      button.addEventListener('click', () => {
        calendarOpen = false
        calendar.onSelect(button.dataset.date!)
      })
    })
  }
  render()
  rerenderOpenCalendar = render
  return card
}

export function buildOverlay(
  overlay: HTMLElement,
  callouts: SVGSVGElement,
  arcs: ResolvedArc[],
  day: DayData,
  activeSkin: SkinId,
  hooks: OverlayHooks,
) {
  rerenderOpenCalendar = null
  overlay.innerHTML = ''
  callouts.innerHTML = ''
  callouts.setAttribute('viewBox', '0 0 1842 1197')
  const catLabel = (cat: string) => {
    if (day === MOCK_DAY && activeSkin === 'paper') {
      if (cat === 'seo') return 'Front end'
      if (cat === 'personal') return 'Research'
    }
    return day.labels[cat as keyof typeof day.labels] ?? cat
  }
  const skin = skinFor(activeSkin, day)
  // the seismograph's outer reach — both label rings stay above/outside it
  const clear = hooks.labelClear ?? 0
  // Authored labelRadius describes the fixed mock. On real Paper days the
  // visible annulus can shrink with a sparse groove stack, so its clock must
  // follow the live clearance radius rather than the invisible full disc.
  const clockRadius = day !== MOCK_DAY && activeSkin === 'paper'
    ? clear
    : Math.max(skin.labelRadius, clear)

  // Keep the key focused on the two states a user needs to distinguish while
  // reading the dial. Subagent/unfinished metadata remains in the data model,
  // but no longer competes for space in the primary legend.
  const legendRows: [string, string][] = [
    ['sw-active', 'Agent working'],
    ['sw-blocked', 'Agent waiting'],
  ]
  const hasDelays = activeSkin === 'electric' || day === MOCK_DAY || day.threads.some((t) => t.blockedRanges?.length)
  const delays = hasDelays ? hooks.delays : undefined
  const header = document.createElement('div')
  header.className = 'header-left'
  header.innerHTML = `
    <div class="date-row">
      <div class="date-nav">
        <button class="clickable" aria-label="Previous day">‹</button>
        <button class="clickable" aria-label="Next day">›</button>
      </div>
      <button class="date-display clickable" aria-label="Open calendar">
        <img class="calendar-icon" src="${activeSkin === 'electric' ? '/assets/calendar-icon-electric.svg' : '/assets/calendar-icon.svg'}" alt="" aria-hidden="true" />
        <span class="date-title">${day.meta.dateLabel}</span>
      </button>
    </div>
    <div class="header-controls">
      ${skinToggleHTML(activeSkin, PICKER_SKINS, SKIN_LABEL)}
      ${skinVariantHTML(activeSkin, hooks)}
      ${legendRows.length || delays ? `<div class="legend-card">
        ${legendRows.map(([sw, label]) =>
          `<div class="legend-row"><span class="legend-swatch ${sw}"></span>${label}</div>`).join('')}
        ${delays ? `<div class="legend-divider"></div>` : ''}
        ${delays ? `
        <div class="legend-row delay-toggle clickable${delays.on ? ' on' : ''}">
          <span class="switch"></span>Highlight waiting
        </div>` : ''}
      </div>` : ''}
    </div>`
  overlay.appendChild(header)
  const mountCalendar = () => {
    overlay.querySelector('.calendar-popover')?.remove()
    if (calendarOpen && hooks.calendar) overlay.appendChild(calendarCard(hooks.calendar))
  }
  if (calendarOutsideHandler) document.removeEventListener('pointerdown', calendarOutsideHandler)
  calendarOutsideHandler = (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!calendarOpen || target?.closest('.calendar-popover, .date-display')) return
    calendarOpen = false
    mountCalendar()
  }
  document.addEventListener('pointerdown', calendarOutsideHandler)
  header.querySelector<HTMLButtonElement>('.date-display')?.addEventListener('click', () => {
    calendarOpen = !calendarOpen
    if (calendarOpen && hooks.calendar) calendarMonth = hooks.calendar.selectedDate.slice(0, 7)
    mountCalendar()
  })
  mountCalendar()
  header.querySelectorAll<HTMLButtonElement>('.skin-toggle button').forEach((b) => {
    b.addEventListener('click', () => hooks.onSkin(b.dataset.s as SkinId))
  })
  const colorEditor = colorEditorEl(day, activeSkin, skin, hooks)
  if (colorEditor) header.querySelector('.header-controls')?.appendChild(colorEditor)
  header.querySelectorAll<HTMLButtonElement>('.vinyl-variants button').forEach((b) => {
    b.addEventListener('click', () => hooks.onSkinVariant?.(b.dataset.v!))
  })
  const [prevBtn, nextBtn] = header.querySelectorAll<HTMLButtonElement>('.date-nav button')
  prevBtn?.addEventListener('click', () => hooks.onNav?.(-1))
  nextBtn?.addEventListener('click', () => hooks.onNav?.(1))
  if (delays) {
    const d = delays
    const tog = header.querySelector<HTMLElement>('.delay-toggle')!
    tog.addEventListener('click', () => d.onToggle(tog.classList.toggle('on')))
  }

  // ---- the master frame's floating stat panels and Dayflow lockup
  if (activeSkin !== 'glass') {
    overlay.appendChild(buildPlaybackBrand())
    overlay.append(buildSummaryPanel(day), buildCodePanel(day))
  }
  overlay.appendChild(buildTokenPanel(day, skin))
  // ---- groove controls: pack toggle + spacing slider (real days only).
  // Handlers update their own DOM and rebuild the scene; the overlay itself
  // doesn't depend on lanes, so no rebuild here (which would also kill the
  // slider mid-drag).
  if (SHOW_GROOVE_CONTROLS && hooks.grooves) {
    const controls = header.querySelector('.header-controls')!
    controls.insertBefore(grooveControlsEl(hooks.grooves), controls.querySelector('.legend-card'))
  }

  // ---- start/end labels flanking the notch. Their centers sit on the same
  // two radial lines that cut the notch through the record, so text and line
  // stay aligned when the skin radius or vertical clearance changes.
  // The mock keeps that pinned y (clamped above the seismograph fringe); real
  // days anchor the block to the same clearance circle the hour labels hug,
  // its ~46px height standing just outside it, so the whole clock ring reads
  // as one binding.
  const seTop = day === MOCK_DAY
    ? Math.min(activeSkin === 'vinyl' || activeSkin === 'electric' ? 55 : 62, CENTER_Y - clear - 48)
    : CENTER_Y - clockRadius - 48
  const endLbl = document.createElement('div')
  endLbl.className = 'start-end-label se-end'
  endLbl.style.left = `${CENTER_X}px`
  endLbl.style.top = `${seTop}px`
  endLbl.innerHTML = `<div class="tag">End</div><div>${day.meta.endLabel}</div>`
  overlay.appendChild(endLbl)
  const startLbl = document.createElement('div')
  startLbl.className = 'start-end-label se-start'
  startLbl.style.left = `${CENTER_X}px`
  startLbl.style.top = `${seTop}px`
  startLbl.innerHTML = `<div class="tag">Start</div><div>${day.meta.startLabel}</div>`
  overlay.appendChild(startLbl)
  const h = Math.max(endLbl.offsetHeight, startLbl.offsetHeight)
  let finalTop = seTop
  if (day !== MOCK_DAY) {
    // flush against the clearance circle like the hour labels: the 48px
    // guess above overshoots the block's real height, so re-place its
    // BOTTOM edge on the circle now that the block is measurable
    if (h > 0) {
      finalTop = CENTER_Y - clockRadius - h
      // Electric's hour labels already share Vinyl's clearance geometry, but
      // its smaller authored outer ring otherwise leaves this one block 30px
      // too high. Keep the paired labels on Vinyl's visual baseline.
      if (activeSkin === 'electric') finalTop += 30
      endLbl.style.top = `${finalTop}px`
      startLbl.style.top = `${finalTop}px`
    }
  }
  if (activeSkin === 'vinyl' || activeSkin === 'paper' || activeSkin === 'electric') {
    const labelMidY = finalTop + h * 0.5
    const notchX = Math.tan((NOTCH_DEG * Math.PI) / 180) * (CENTER_Y - labelMidY)
    endLbl.style.left = `${CENTER_X - notchX}px`
    startLbl.style.left = `${CENTER_X + notchX}px`
  } else {
    endLbl.style.left = `${CENTER_X - 39.5}px`
    startLbl.style.left = `${CENTER_X + 45}px`
  }

  // ---- hour labels. The frame sets all eleven on one center radius rather
  // than clearing a text box per label — but only while that radius clears the
  // seismograph's reach; a day whose bars outgrow it switches to the clearance
  // layout so the clock ring can never run through the ticks.
  for (const l of resolveHourLabels(clockRadius, activeSkin !== 'paper' && clear <= skin.labelRadius)) {
    const el = document.createElement('div')
    el.className = 'hour-label'
    el.style.left = `${l.x}px`
    el.style.top = `${l.y}px`
    el.textContent = l.text
    overlay.appendChild(el)
  }

  // ---- donut callouts (right stack, left + bottom labels)
  const centerDonut = day === MOCK_DAY && activeSkin === 'paper' ? PAPER_MOCK_DONUT : day.donut
  const stackCats = centerDonut.map((d) => d.category)
  const donutRange = centerDonut.length === 1
    ? [0, Math.PI * 2, 0] as const
    : day === MOCK_DAY && activeSkin !== 'paper' ? [] : DONUT_FULL
  const segAngles = resolveDonut(centerDonut, ...donutRange)
  const ringR = skin.center?.ringR ?? CENTER.gaugeR
  const ringW = skin.center?.ringW ?? CENTER.gaugeW
  const rOut = ringR + ringW / 2
  if (activeSkin === 'glass') {
    // glass mock replaces the elbow stack with a bullet legend, pinned where
    // the frame puts it against the authored 6-segment ring; a real day's
    // chips are the full circle, so it uses the leader-line stack below like
    // every other skin
    if (day === MOCK_DAY) {
      stackCats.forEach((cat, i) => {
        const row = document.createElement('div')
        row.className = 'cat-legend-row'
        row.style.left = '1042px'
        row.style.top = `${478 + i * 33}px`
        const color = skin.donutPalette[cat as keyof typeof SKINS.glass.donutPalette]
        row.innerHTML = `<span class="cat-bullet" style="background:${color}"></span>${catLabel(cat)}`
        overlay.appendChild(row)
      })
    }
    // percentage labels inside the split disc (real provider share)
    const oh = providerHours(day, 'openai')
    const ch = providerHours(day, 'claude')
    const oPct = oh + ch > 0 ? Math.round((oh / (oh + ch)) * 100) : 50
    // real days center each label on its wedge bisector (openai wedge sits on
    // 12 o'clock, claude on 6); the mock keeps the authored diagonal art
    const p1 = document.createElement('div')
    p1.className = 'pct-label'
    p1.style.cssText = day === MOCK_DAY
      ? `left:${CENTER_X + 40}px;top:${CENTER_Y - 52}px;transform:translate(-50%,-50%) rotate(14deg)`
      : `left:${CENTER_X}px;top:${CENTER_Y - 74}px;transform:translate(-50%,-50%)`
    p1.textContent = `${oPct}%`
    overlay.appendChild(p1)
    const p2 = document.createElement('div')
    p2.className = 'pct-label pct-warm'
    p2.style.cssText = day === MOCK_DAY
      ? `left:${CENTER_X - 50}px;top:${CENTER_Y + 40}px;transform:translate(-50%,-50%) rotate(-16deg)`
      : `left:${CENTER_X}px;top:${CENTER_Y + 74}px;transform:translate(-50%,-50%)`
    p2.textContent = `${100 - oPct}%`
    overlay.appendChild(p2)
  }
  if (activeSkin !== 'glass' || day !== MOCK_DAY) {
    // leader lines: anchor at the chip's bisector just off the ring, project
    // the label outward along the same bisector to a constant radius, land
    // with a short horizontal into the label. Full-circle chips label to
    // whichever side their bisector points; each side stacks independently
    // (the mock's 42°..122° slice makes this the original right-only stack).
    // measured off the frame: every label's left edge lands about 174px from
    // the puck center, and consecutive rows sit 20px apart, not 30.
    // The line springs from the outer edge of the whole center puck — vinyl's
    // label disc reaches past the gauge ring, and a line anchored at the ring
    // would start on top of the chips.
    const anchorR = Math.max(rOut, skin.labelDisc?.r ?? 0) + 3
    const RL = anchorR + 20
    const rows = segAngles.map((s, i) => {
      const mid = (s.a0 + s.a1) / 2
      return {
        mid, cat: stackCats[i], right: Math.sin(mid) >= 0,
        x: CENTER_X + Math.sin(mid) * RL, y: CENTER_Y - Math.cos(mid) * RL,
      }
    })
    for (const side of [true, false]) {
      const stack = rows.filter((r) => r.right === side).sort((a, b) => a.y - b.y)
      for (let i = 1; i < stack.length; i++) {
        if (stack[i].y - stack[i - 1].y < 20) stack[i].y = stack[i - 1].y + 20
      }
    }
    for (const row of rows) {
      const [ax, ay] = polar(row.mid, anchorR)
      const dir = row.right ? 1 : -1
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${row.x.toFixed(1)} ${row.y.toFixed(1)} L ${(row.x + 12 * dir).toFixed(1)} ${row.y.toFixed(1)}`)
      callouts.appendChild(path)
      const label = document.createElement('div')
      label.className = 'callout-label'
      label.style.left = `${row.x + 17 * dir}px`
      label.style.top = `${row.y - 10}px`
      if (!row.right) label.style.transform = 'translateX(-100%)'
      label.textContent = catLabel(row.cat)
      overlay.appendChild(label)
    }
    // The frame annotates the two gauge arcs as well as the six ring chips, so
    // it carries a label on the left flank and one at the bottom that have no
    // source in `day.donut` and cannot fall out of the stack above. Both are
    // fixed positions measured off the file (nodes 517:923-927).
    if (day === MOCK_DAY && activeSkin !== 'paper') {
      const pin = (text: string, x: number, y: number, anchor: 'end' | 'middle', d: string) => {
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', d)
        callouts.appendChild(path)
        const label = document.createElement('div')
        label.className = 'callout-label'
        label.style.left = `${x}px`
        label.style.top = `${y}px`
        label.style.transform = anchor === 'end' ? 'translateX(-100%)' : 'translateX(-50%)'
        label.textContent = text
        overlay.appendChild(label)
      }
      pin(catLabel('pixel-art'), 793, 506, 'end', 'M 797 513 L 817 545')
      pin(catLabel('research'), 924, 771, 'middle', 'M 924.5 745 L 924.5 772.5')
    }
  }
  // ---- curved gauge text: paper totals curve OUTSIDE the split disc,
  // chatgpt centered on top / claude on bottom (aligned); the other skins keep
  // their authored spots — {radius, center angle, half-span, flip}
  const textSpec: Record<string, [number, number, number, boolean][]> = {
    // Node 1120:7170 centers both totals exactly on 12/6 o'clock, on matching
    // 90px baselines in the clear band between disc and category ring.
    paper: [[90, 0, 30, false], [90, 180, 30, true]],
    // the black-label frame (1002:35568) floats both totals mid-band in the
    // dark ring between the split disc (r76) and the project chips (r133)
    vinyl: [[103, 0, 25, false], [112, 180, 30, true]],
    electric: [[86, 0, 25, false], [118, 180, 25, true]],
    // glass's top text sat on the ring band — on real days the chips own the
    // whole ring, so it tucks into the gap between pie (r95) and ring (r111.5)
    glass: [[day === MOCK_DAY ? ringR : 103, 0, 25, false], [62, 180, 44, true]],
  }
  const [topSpec, botSpec] = textSpec[activeSkin]
  // real days name the gauges ("ChatGPT · 43 min") — nothing else identifies
  // the white/periwinkle arcs; the mock's authored art keeps bare totals. The
  // half-span widens with the text so long strings don't clip off the path.
  const gaugeText = (name: string, total: string) => (day === MOCK_DAY ? total : `${name} · ${total}`)
  // the arc has to be long enough to carry the string, so the half-span grows
  // with it — per-character width tracks the 17px type size
  const chW = 9
  const gaugeHalf = (spec: [number, number, number, boolean], text: string) =>
    Math.max(spec[2], (((text.length * chW) / spec[0]) * 57.296) / 2 + 3)
  // the diagonal centers are the MOCK's authored art; real days pin ChatGPT
  // dead on 12 o'clock and Claude on 6, matching the accurate wedges, and on
  // radii that clear both the provider marks and the ring chips
  const [topC, botC] = day === MOCK_DAY ? [topSpec[1], botSpec[1]] : [0, 180]
  // flipped bottom text hangs INWARD from its baseline (~17px of glyph), so
  // it needs a baseline of ~100 to keep the whole word in the clear band
  // between the split disc (r≈78) and the ring chips (r≈116) — top text
  // grows outward from its baseline, so 90 already clears
  const [topR, botR] = day === MOCK_DAY
    ? [topSpec[0], botSpec[0]]
    // vinyl's black label gives the text a deeper band to float in
    : [Math.max(topSpec[0], 90), activeSkin === 'vinyl' ? 112 : 100]
  const topText = gaugeText('Codex', day.meta.openaiTotal)
  const botText = gaugeText('Claude', day.meta.claudeTotal)
  const th = gaugeHalf([topR, topC, topSpec[2], topSpec[3]], topText)
  const bh = gaugeHalf([botR, botC, botSpec[2], botSpec[3]], botText)
  const openaiHours = providerHours(day, 'openai')
  const claudeHours = providerHours(day, 'claude')
  if (openaiHours > 0) addCurvedText(callouts, 'gauge-top', topR, topC - th, topC + th, topText, topSpec[3])
  if (claudeHours > 0) addCurvedText(callouts, 'gauge-bot', botR, botC - bh, botC + bh, botText, botSpec[3])

  // ---- provider logos in the split disc: each centered in its provider's
  // real region (wave skins by flooded area, pie skins on the wedge
  // bisector); the mock keeps its authored diagonal art positions
  const marks = splitMarkOffsets(day, skin)
  if (openaiHours > 0) {
    const [knotX, knotY] = marks.openai
    const logoTop = document.createElement('img')
    logoTop.src = '/assets/openai-mark.svg'
    logoTop.className = 'knot-logo'
    logoTop.style.cssText = `position:absolute;left:${CENTER_X + knotX - 7.5}px;top:${CENTER_Y + knotY - 7.5}px;width:15px;height:15px`
    overlay.appendChild(logoTop)
  }
  if (claudeHours > 0) {
    const [sparkX, sparkY] = marks.claude
    const logoBot = document.createElement('img')
    logoBot.src = '/assets/claude-spark.png'
    logoBot.style.cssText = `position:absolute;left:${CENTER_X + sparkX - 7}px;top:${CENTER_Y + sparkY - 7}px;width:14px;height:14px`
    overlay.appendChild(logoBot)
  }

  // ---- the frame leaves one tooltip pinned open against the thread it
  // describes (node 552:1350, sitting 6px left and 87px below that thread's
  // endpoint), so the mock reproduces it instead of waiting for a hover
  // …except the paper frame, which leaves nothing pinned open
  const tipId = activeSkin === 'paper' || activeSkin === 'electric' ? undefined : day.meta.tooltipThread
  if (day === MOCK_DAY && tipId) {
    const arc = arcs.find((a) => a.thread.id === tipId)
    if (arc) {
      const [ex, ey] = polar(arc.a1, arc.radius)
      buildTooltip(overlay, arc.thread, day, ex - 6, ey + 87)
    }
  }
}

function addCurvedText(
  svg: SVGSVGElement, id: string, r: number, degStart: number, degEnd: number, text: string, flip: boolean,
) {
  const DEG = Math.PI / 180
  const [x0, y0] = polar(degStart * DEG, r)
  const [x1, y1] = polar(degEnd * DEG, r)
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('id', id)
  path.setAttribute('class', 'tp')
  const sweep = flip ? 0 : 1
  const [ax, ay, bx, by] = flip ? [x1, y1, x0, y0] : [x0, y0, x1, y1]
  path.setAttribute('d', `M ${ax.toFixed(1)} ${ay.toFixed(1)} A ${r} ${r} 0 0 ${sweep} ${bx.toFixed(1)} ${by.toFixed(1)}`)
  path.setAttribute('fill', 'none')
  path.style.stroke = 'none'
  svg.appendChild(path)
  const t = document.createElementNS(SVG_NS, 'text')
  t.setAttribute('class', 'gauge-text')
  const tp = document.createElementNS(SVG_NS, 'textPath')
  tp.setAttribute('href', `#${id}`)
  tp.setAttribute('startOffset', '50%')
  tp.setAttribute('text-anchor', 'middle')
  tp.textContent = text
  t.appendChild(tp)
  svg.appendChild(t)
}

export function buildTooltip(overlay: HTMLElement, thread: Thread, day: DayData, x: number, y: number) {
  const el = document.createElement('div')
  el.className = 'tooltip-card'
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  el.dataset.showAt = String(thread.end)
  const label = day.labels[thread.category as keyof typeof day.labels] ?? thread.category
  el.innerHTML = `
    <div class="tooltip-head">
      <img src="${providerIcon(thread.provider)}" width="14" height="14" alt="" />
      <span class="tooltip-chip">${label}</span>
    </div>
    <div>${thread.summary ?? ''}</div>
    <div class="tooltip-time">${day === MOCK_DAY && day.meta.tooltipTime
      ? day.meta.tooltipTime // the frame's authored copy, art like the rest of the mock
      : `${fmtClock(thread.start)} - ${fmtClock(thread.end)}`}</div>`
  overlay.appendChild(el)
  return el
}

// hourToAngle is re-exported for callers that position against the dial
export { hourToAngle }
