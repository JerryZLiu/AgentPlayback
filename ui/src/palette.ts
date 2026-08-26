// Per-project palettes assigned from hand-picked per-skin color pools. The
// scanner ranks projects by total cost over the latest 30 days; that stable
// rank selects the same palette position on every viewed day. The mock day
// keeps the hand-picked Figma palettes untouched.

import { MOCK_DAY, type Category, type DayData } from './data'
import { arcWidth, arcWidthRaw, CENTER, getLaneLayout, GROOVE_TOP, laneRadius } from './geometry'
import { labColor, labPalettes } from './labpal'
import { SKINS, type RingField, type SkinId, type SkinScene } from './skins'
import { variantPatch, vinylBase } from './vinylvariants'

/** the authored skin with the active audition variant layered in. Vinyl takes
 *  its repaint from vinylvariants.ts (Jerry: the pressed-surface vinyl paint
 *  is the vinyl). */
function baseSkin(id: SkinId): SkinScene {
  return id === 'vinyl' ? vinylBase() : { ...SKINS[id], ...variantPatch(id) }
}

// OKLCH bands matched to each skin's authored palette: paper/glass pastel,
// vinyl/electric vivid. `other` is the fixed neutral for the Other bucket.
// The bold look drops lightness and raises chroma so threads read from
// across the room instead of blending into the track artwork.
const BANDS: Record<Look, Record<SkinId, { L: number; C: number; other: string }>> = {
  classic: {
    paper: { L: 0.9, C: 0.08, other: '#d5c9df' },
    vinyl: { L: 0.74, C: 0.17, other: '#d7cbd9' },
    electric: { L: 0.68, C: 0.16, other: '#e8ecf2' },
    glass: { L: 0.78, C: 0.11, other: '#d5c9df' },
  },
  bold: {
    paper: { L: 0.8, C: 0.13, other: '#cfc2d8' },
    vinyl: { L: 0.7, C: 0.2, other: '#d7cbd9' },
    electric: { L: 0.65, C: 0.19, other: '#e8ecf2' },
    glass: { L: 0.72, C: 0.14, other: '#cfc2d8' },
  },
}

// ---- look: classic vs bold -------------------------------------------------
// classic = the authored balance (quiet tracks, pastel arcs). bold = data
// first: track grid/ticks/spokes fade back, arcs thicken to fill most of the
// groove, palette saturates. Geometry never changes — bold is paint only.

export type Look = 'classic' | 'bold'
let currentLook: Look = 'classic'
export function setLook(look: Look) { currentLook = look }
export function getLook(): Look { return currentLook }

function boldify(skin: SkinScene): SkinScene {
  const step = getLaneLayout()?.step ?? 18
  return {
    ...skin,
    ringFields: skin.ringFields.map((f) =>
      f.laneGrid ? { ...f, alpha: f.alpha * 0.55 }
        : f.laneZone ? f
          : { ...f, alpha: f.alpha * 0.7 }),
    ticks: { ...skin.ticks, alpha: skin.ticks.alpha * 0.45 },
    spokes: skin.spokes.map((s) => ({ ...s, alpha: s.alpha * 0.7 })),
    arcWidth: Math.max(skin.arcWidth ?? 0, Math.round(step * 0.72)),
  }
}

// ---- palette assignment ----------------------------------------------------

// The available data colors, hard-coded per skin. Glass shares paper's pool
// (both are light grounds). The Other bucket keeps its per-skin neutral from
// BANDS so it stays chrome, not data.
const POOLS: Record<SkinId, string[]> = {
  paper: ['#afb4ee', '#85e0dd', '#9cc5f2', '#a2d7af', '#f9c890', '#f5b7c4'],
  vinyl: ['#5765ff', '#32bee2', '#f9cc6c', '#a270ff', '#aaf291', '#ff94dd'],
  electric: ['#3370ff', '#38cdff', '#ce85ff', '#ffb561', '#81eebf'],
  glass: ['#afb4ee', '#85e0dd', '#9cc5f2', '#f5b7c4', '#f9c890', '#a2d7af'],
}

let projectColorRank = new Map<string, number>()
export function setProjectColorOrder(projects: string[]) {
  projectColorRank = new Map(projects.map((project, i) => [project, i]))
}

export type ProjectColorOverrides = Partial<Record<SkinId, Record<string, string>>>
let projectColorOverrides: ProjectColorOverrides = {}

/** User-picked colors are keyed by project name rather than the day's category
 * slot, because a project can occupy a different slot on a different day. */
export function setProjectColorOverrides(overrides: ProjectColorOverrides) {
  projectColorOverrides = overrides
}

export function setProjectColorOverride(id: SkinId, project: string, color: string | null) {
  const next = { ...(projectColorOverrides[id] ?? {}) }
  if (color) next[project] = color
  else delete next[project]
  projectColorOverrides = { ...projectColorOverrides, [id]: next }
}

function applyProjectColors(skin: SkinScene, day: DayData, id: SkinId): SkinScene {
  const overrides = projectColorOverrides[id]
  if (!overrides) return skin
  const colors: Partial<Record<Category, string>> = {}
  for (const [slot, name] of Object.entries(day.labels) as [Category, string][]) {
    if (overrides[name]) colors[slot] = overrides[name]
  }
  return Object.keys(colors).length
    ? { ...skin, arcPalette: { ...skin.arcPalette, ...colors }, donutPalette: { ...skin.donutPalette, ...colors } }
    : skin
}

function genPalette(day: DayData, id: SkinId): Partial<Record<Category, string>> {
  const band = BANDS[currentLook][id]
  const pool = POOLS[id]
  const out: Partial<Record<Category, string>> = {}
  const named: { slot: Category; name: string }[] = []
  for (const [slot, name] of Object.entries(day.labels) as [Category, string][]) {
    if (name === 'Other') out[slot] = band.other
    else named.push({ slot, name })
  }
  // A project's global 30-day cost rank is its palette index. Projects that
  // have not made it into the generated ranking yet trail the ranked set in
  // name order, which keeps zero-cost/new entries deterministic.
  named.sort((a, b) => {
    const ar = projectColorRank.get(a.name) ?? Number.MAX_SAFE_INTEGER
    const br = projectColorRank.get(b.name) ?? Number.MAX_SAFE_INTEGER
    return ar - br || a.name.localeCompare(b.name)
  })
  const fallbackStart = projectColorRank.size
  let fallback = 0
  for (const { slot, name } of named) {
    const rank = projectColorRank.get(name) ?? fallbackStart + fallback++
    out[slot] = pool[rank % pool.length]
  }
  return out
}

// ---- per-agent grooves -----------------------------------------------------
// Real days rebuild each skin's lane-grid field as one groove per agent
// thread (negative period = the shader's centered-line mode), so the dark
// lines the arcs ride on exactly match the day's thread count.

function grooveFields(base: SkinScene): RingField[] {
  const layout = getLaneLayout()
  if (!layout) return base.ringFields
  const w = base.id === 'electric' ? 2 : Math.min(arcWidth(), layout.step - 1)
  const inner = laneRadius(layout.count - 1)
  return base.ringFields.map((f) => {
    if (f.laneInnerRim && base.id === 'electric') {
      const r0 = inner - layout.step
      return { ...f, r0, r1: r0 + (f.r1 - f.r0) }
    }
    if (f.laneGrid) {
      return { ...f, r0: inner - layout.step / 2, r1: GROOVE_TOP + layout.step / 2,
        period: -layout.step, duty: w / layout.step }
    }
    if (f.laneZone) {
      // Sparse Paper and Electric days should not keep the full-depth authored
      // band. The fill follows the day's actual groove stack.
      // Leave one lane of fill inside the innermost groove: half a lane is
      // required to cover the groove itself, and the other half is breathing
      // room so the background does not end flush against the line.
      // The same one-lane allowance outside the outer groove keeps both edges
      // balanced. Derive both bounds from the live layout: clamping crowded
      // days to the authored r0=313 let the innermost r=310 groove and its arc
      // extend past the background and dividers.
      const fitted = base.id === 'electric' || base.id === 'paper'
      const r0 = fitted
        ? inner - layout.step
        : Math.min(f.r0, inner - 12)
      const r1 = fitted
        ? GROOVE_TOP + layout.step
        : f.r1
      return { ...f, r0, r1 }
    }
    return f
  })
}

/** the notch's start/end hands trimmed to the day's actual groove band —
 *  the authored radii belong to the mock's fixed grid, and on real days the
 *  band moves, leaving the hairlines poking past both edges */
function handsForLayout(base: SkinScene, fittedFields: RingField[]): SkinScene['hands'] {
  const layout = getLaneLayout()
  if (!base.hands || !layout) return base.hands
  if (base.id === 'paper' || base.id === 'electric') {
    const zone = fittedFields.find((f) => f.laneZone)
    return {
      ...base.hands,
      // Read the final fitted annulus instead of repeating its layout math.
      // Start/End and hourly dividers therefore share the exact same bounds
      // on sparse and compressed days.
      // The 1px rule's raster footprint otherwise lands one pixel outside the
      // annulus at each radial cap. Inset both ends by one stage pixel.
      rIn: (zone?.r0 ?? base.hands.rIn) + 1,
      rOut: (zone?.r1 ?? base.hands.rOut) - 1,
    }
  }
  return {
    ...base.hands,
    // the hands stop ON the first/last painted ring line, not the half-step
    // of clear band beyond it
    rIn: laneRadius(layout.count - 1),
    rOut: GROOVE_TOP,
  }
}

/** The grey track a thread rides on is exactly as wide as the arc painted
 *  over it. grooveFields sizes the track before the skin's own arcWidth or
 *  the bold look have had their say, so the two drifted apart — this re-syncs
 *  the lane-grid duty to the final painted width. Electric keeps its authored
 *  hairline orbits: its tracks are HUD chrome, not arc beds. */
function syncGrooveWidth(skin: SkinScene): SkinScene {
  const layout = getLaneLayout()
  if (!layout || skin.id === 'electric') return skin
  // must mirror the painted width exactly: scene caps the skin's authored
  // stroke by the groove-aware dynamic width, so the track does too
  const w = Math.min(skin.arcWidth ?? arcWidth(), arcWidthRaw(), layout.step - 1)
  return {
    ...skin,
    ringFields: skin.ringFields.map((f) =>
      f.laneGrid ? { ...f, duty: w / Math.abs(f.period) } : f),
  }
}

/** the skin to draw with: authored palettes/grid for the mock, generated for real days */
export function skinFor(id: SkinId, day: DayData): SkinScene {
  if (day === MOCK_DAY) {
    const authored = baseSkin(id)
    return withLab(applyProjectColors(currentLook === 'bold' ? boldify(authored) : authored, day, id))
  }
  const gen = genPalette(day, id)
  const base = baseSkin(id)
  const fittedFields = grooveFields(base)
  const pal = { arc: SKINS[id].arcPalette, donut: SKINS[id].donutPalette }
  const fittedHands = handsForLayout(base, fittedFields)
  const fittedRuleZone = (id === 'paper' || id === 'electric')
    ? fittedFields.find((f) => f.laneZone)
    : undefined
  const skin: SkinScene = {
    ...base,
    ringFields: fittedFields,
    hands: fittedHands,
    // Paper and Electric use the same construction for hour rules and notch
    // edges: every line is clipped to the fitted groove-background annulus.
    // This preserves the open center band and prevents spokes from extending
    // beyond the background when the live groove count changes its depth.
    spokes: fittedRuleZone
      ? base.spokes.map((s) => ({ ...s, rIn: fittedRuleZone.r0 + 1, rOut: fittedRuleZone.r1 - 1 }))
      : base.spokes,
    // glass stays out of project coloring — every arc comes out the same
    // periwinkle while the glass legend still shows six distinct swatches
    arcPalette: id === 'glass' ? pal.arc : { ...pal.arc, ...gen },
    donutPalette: { ...pal.donut, ...gen },
  }
  const done = currentLook === 'bold' ? boldify(skin) : skin
  // Electric's selected master keeps the bright seismograph fringe around the
  // dial. The quieter skins suppress it for real days.
  const ticks = id === 'electric' ? done.ticks : { ...done.ticks, alpha: 0, glow: 0 }
  return withLab(applyProjectColors(syncGrooveWidth({ ...done, ticks }), day, id))
}

/** Color Lab (/lab.html) audition override — inert without ?labpal */
function withLab(skin: SkinScene): SkinScene {
  return {
    ...skin,
    arcPalette: labPalettes(skin.arcPalette),
    donutPalette: labPalettes(skin.donutPalette),
    // the provider gauge (Claude vs OpenAI halves) takes the first two
    // audition slots so the center ring auditions along with everything else
    gaugeTop: labColor(0, skin.gaugeTop),
    gaugeBottom: labColor(1, skin.gaugeBottom),
  }
}

/** the wave skins' horizon height (up-positive, disc coords): the circular
 *  segment above it holds OpenAI's real share of agent-hours, solved by area
 *  so the split reads true. Mock and pie skins keep the authored y. Shared
 *  by the scene (which floods the wave) and the overlay (which anchors each
 *  provider's mark inside its own region). */
export function waveHorizonFor(day: DayData, skin: SkinScene): number {
  if (day === MOCK_DAY || skin.innerMode !== 'wave') return skin.wave?.y ?? 8
  const R = skin.center?.innerR ?? CENTER.innerR
  const dur = (p: string) => day.threads.filter((t) => t.provider === p).reduce((a, t) => a + t.end - t.start, 0)
  const o = dur('openai')
  const c = dur('claude')
  const fc = o + c > 0 ? c / (o + c) : 0.5
  // horizon height d whose circular segment above it holds openai's share:
  // R²·acos(d/R) − d·√(R²−d²) = (1−fc)·πR², bisected (area-true, not height)
  const target = (1 - fc) * Math.PI * R * R
  let lo = -R
  let hi = R
  for (let i = 0; i < 40; i++) {
    const d = (lo + hi) / 2
    const above = R * R * Math.acos(Math.max(-1, Math.min(1, d / R))) - d * Math.sqrt(Math.max(R * R - d * d, 0))
    if (above > target) lo = d
    else hi = d
  }
  return (lo + hi) / 2
}
