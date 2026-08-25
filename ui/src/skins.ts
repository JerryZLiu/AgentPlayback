// Per-skin scene configuration. Everything here is a number or color the
// renderer interpolates — skins are paint, geometry is shared.

import type { Category } from './data'

export type SkinId = 'paper' | 'vinyl' | 'electric' | 'glass'

export interface RingField {
  r0: number
  r1: number
  /** stripe period in px — line count falls out of thickness, not hardcoded */
  period: number
  /** 0..1 fraction of the period that is line (1 = solid band) */
  duty: number
  color: string
  alpha: number
  /** edge softness in px (soft airbrushed bands vs crisp lines) */
  soft?: number
  /** 0..1 pigment-grain amount so soft bands read as paint, not blur */
  grain?: number
  /** this field is the per-lane track grid — real days rebuild it as one groove per agent */
  laneGrid?: boolean
  /** this field is a zone backdrop spanning the lane area — real days retune its radii */
  laneZone?: boolean
  /** inner rim that follows the fitted lane-zone edge on real days */
  laneInnerRim?: boolean
  /** stripes drawn only inside bands: band repeat distance (0 = continuous) */
  bandPeriod?: number
  /** width of each band in px */
  bandWidth?: number
  /** clear this field inside the Start/End notch; defaults to true */
  notch?: boolean
}

export interface Spoke {
  /** hour position on the 24h dial */
  hour: number
  rIn: number
  rOut: number
  alpha: number
}

export interface SectorShade {
  /** degrees clockwise from 12 o'clock */
  a0: number
  a1: number
  /** white-wash alpha (positive lightens, negative darkens) inside sectorZone */
  wash: number
}

export interface SkinScene {
  id: SkinId
  discR: number
  discColor: string
  discAlpha: number
  bezel?: { r0: number; r1: number; inner: string; outer: string }
  /** second bezel layer (vinyl's bright rim outside the dark edge) */
  bezel2?: { r0: number; r1: number; inner: string; outer: string }
  labelDisc?: { r: number; color: string }
  /** frosted-glass annulus: band radii, frost alpha, light direction, rim strength */
  glass?: { r0: number; r1: number; alpha: number; lightDeg: number; rim: number }
  /**
   * Pressed-record surface: concentric microgrooves lit by an anisotropic
   * sheen. `r0`/`r1` bound the grooved zone (inside r0 is deadwax, outside r1
   * is the lead-in), `pitch` is the groove spacing in px, `gloss` is how much
   * light the flat surface returns before any groove relief, `lightDeg` is
   * where the highlight falls (clockwise from 12), and `strength` scales the
   * whole thing. The optional controls tune the physical read without
   * changing the record geometry: groove relief, track-band visibility,
   * surface wear, and the angular focus of the reflected light.
   */
  vinylMat?: {
    r0: number
    r1: number
    strength: number
    pitch: number
    gloss: number
    lightDeg: number
    color: string
    grooveDepth?: number
    trackBands?: number
    wear?: number
    focus?: number
  }
  ringFields: RingField[]
  sectors: SectorShade[]
  /** radial band the sector washes apply to */
  sectorZone: [number, number]
  spokes: Spoke[]
  spokeColor: string
  /** thin start/end "hands" beside the notch */
  hands?: { rIn: number; rOut: number; color: string; alpha: number; width?: number }
  /** halo painted under arcs so they separate from the disc artwork */
  arcHalo: string
  arcHaloAlpha: number
  ticks: {
    /** base circle the whisker ticks straddle */
    rInner: number
    /** typical whisker length (jitter scales it up to ~3x) */
    minorLen: number
    /** 2-hour major stroke length, centered on the base circle */
    majorLen: number
    minorPerHour: number
    jitter: number
    color: string
    alpha: number
    glow: number
    /** minors between majors — omit for one major per hour */
    majorEvery?: number
    /** radial standoff for the majors, making them a second ring */
    majorOffset?: number
  }
  /** radial center of the hour labels */
  /** clearance radius hour labels must stay outside of (text box extent is added per label) */
  labelRadius: number
  outerRing?: { r: number; color: string; alpha: number; width: number; notch?: boolean }
  arcPalette: Record<Category, string>
  donutPalette: Record<Category, string>
  spindleAlpha: number
  spindleR: number
  arcGlow: number
  /** 0..1 glossy 3D-tube shading on arcs (glass skin) */
  gloss?: number
  /** arcs render as frosted translucent glassmorphic strokes */
  glassLine?: boolean
  /** override the shared arc stroke width */
  arcWidth?: number
  /** center spindle renders as a glossy pearl sphere */
  pearl?: boolean
  /** soft white halo strength around the center puck */
  centerGlow?: number
  /** degrees — hand-placed tilt of the ring artwork (0 on the 24h dial) */
  tilt: number
  gaugeTop: string
  gaugeBottom: string
  innerTop: string
  innerBottom: string
  innerMode: 'pie' | 'wave'
  /** wave horizon: px above center + wobble amplitude */
  wave?: { y: number; amp: number }
  orb?: boolean
  spindle: string
  /** overrides for center geometry (defaults follow the paper mock) */
  center?: { ringR?: number; ringW?: number; innerR?: number; holeA?: number; holeR?: number }
}

// Vinyl arc palette == the vinyl donut segment palette (sampled from the mock)
const VINYL_PALETTE: Record<Category, string> = {
  research: '#3b66f5',
  seo: '#4dddff',
  'agent-tooling': '#ff80fb',
  swift: '#f4cc06',
  personal: '#a0ef01',
  'pixel-art': '#d7cbd9',
}

// …but only on the ring: every arc in the master frame is vivid, and the pale
// lavender that reads correctly as a 10px chip renders as near-white wire when
// it is stretched into a 100°-long stroke on black. The arcs take a saturated
// violet in the same band as the other five, filling the one hue gap between
// the frame's magenta and its blue.
const VINYL_ARC_PALETTE: Record<Category, string> = { ...VINYL_PALETTE, 'pixel-art': '#c46bff' }

export const SKINS: Record<SkinId, SkinScene> = {
  paper: {
    id: 'paper',
    discR: 500,
    discColor: '#f6f2ea',
    discAlpha: 0, // paper bg + watercolor texture show through
    ringFields: [
      // Figma: one continuous #DAD1CF wash at 20% sits behind the full groove
      // stack. It is an annulus only; the center and page outside stay paper.
      { r0: 313, r1: 465, period: 999, duty: 1, color: '#dad1cf', alpha: 0.2, soft: 2, grain: 0.45, laneZone: true },
      // The individual groove beds sit above that shared ring background.
      { r0: 313, r1: 465, period: 18, duty: 0.5, color: '#dad1cf', alpha: 0.2, soft: 2, grain: 0.45, laneGrid: true },
    ],
    // Keep the Paper lane background uniform around the full dial.
    sectors: [],
    sectorZone: [140, 502],
    // Figma's hour divisions rule the complete groove annulus with evenly
    // spaced 1px #D5D1CC separators aligned to the visible time labels.
    spokes: [{ hour: 0, rIn: 313, rOut: 465, alpha: 1 }],
    spokeColor: '#d5d1cc',
    // notch edge lines stop inside the track zone like the mock — they were
    // running up through the tick band into the Start/End labels
    hands: { rIn: 313, rOut: 465, color: '#d5d1cc', alpha: 1, width: 1 },
    arcHalo: '#f3efe9',
    arcHaloAlpha: 0, // no knockout band — it reads as an outline around light arcs
    // the paper frame's fringe sits almost flush against the outer groove and
    // is far softer than the vinyl one — a hairline ruler, not dark bars
    ticks: { rInner: 474, minorLen: 20, majorLen: 29, minorPerHour: 12, jitter: 0.25, color: '#a89a8c', alpha: 0.55, glow: 0 },
    labelRadius: 508,
    arcWidth: 10.5,
    // The paper frame drops colour coding on the dial entirely: every thread is
    // the same periwinkle, and only the centre chips carry category colour.
    arcPalette: {
      research: '#a8affc',
      seo: '#a8affc',
      'agent-tooling': '#a8affc',
      swift: '#a8affc',
      personal: '#a8affc',
      'pixel-art': '#a8affc',
    },
    donutPalette: {
      research: '#7edbd8',
      seo: '#97d8ad',
      'agent-tooling': '#8dbceb',
      swift: '#f2bf7b',
      personal: '#efa3b4',
      'pixel-art': '#a4a9e9',
    },
    spindleAlpha: 0,
    spindleR: 19,
    arcGlow: 0,
    tilt: 0,
    gaugeTop: '#ffffff',
    gaugeBottom: '#b5bcff',
    innerTop: '#ffffff',
    innerBottom: '#f2cebe',
    innerMode: 'pie',
    spindle: '#8a8a8a',
    // Node 1120:7170 at 100%: 268px outer category ring, 11px stroke,
    // 156px provider disc, and a 70px paper-punched center hole.
    center: { ringR: 127.5, ringW: 11, innerR: 78, holeA: 1, holeR: 35 },
  },

  vinyl: {
    id: 'vinyl',
    // The master frame's edge is not a silver ring: measured across it, the
    // disc stays near-black to r 471, ramps through grey to r 483, and then
    // everything beyond is the soft shadow it casts on the page (which the
    // stylesheet paints, since it falls outside the disc).
    discR: 486,
    discColor: '#000000',
    discAlpha: 1,
    // Not one smooth ramp: cross-sectioning the frame gives a mid-grey step at
    // r 472, a highlight crest at 478, a slightly darker shelf behind it, and
    // then the hard bright rim line at 483.5 — three distinct terraces.
    bezel: { r0: 470.5, r1: 476, inner: '#2c2c2c', outer: '#2f2f2f' },
    bezel2: { r0: 476, r1: 486, inner: '#6a6a6a', outer: '#d6d6d6' },
    labelDisc: { r: 140, color: '#dcd7d2' },
    ringFields: [
      // groove zone: the frame is pure black out to r 315.5 and then steps hard
      // onto its groove floor — a clean edge, not a fade, so `soft` is small
      { r0: 316, r1: 472, period: 999, duty: 1, color: '#0e0e0e', alpha: 1, soft: 1.5, laneZone: true },
      // …with a lighter charcoal separator band between each pair of lanes.
      // First ridge crests at r 325 on an 18.2px pitch.
      { r0: 316.5, r1: 460, period: 18.2, duty: 0.5, color: '#252423', alpha: 1, soft: 3, laneGrid: true },
    ],
    // Two wedges of overhead light, symmetric about 12 o'clock and 60° wide
    // each, lifting the groove floor by about ten levels inside them.
    sectors: [
      { a0: 299, a1: 360, wash: 0.042 },
      { a0: 0, a1: 59, wash: 0.042 },
    ],
    sectorZone: [316, 472],
    // The frame rules a hairline out through every hour label, from the edge of
    // the black centre to just inside the rim (nodes 517:805-815 measure r 295
    // to 471). Only the first entry is a template — the renderer repeats it on
    // whatever hours the current day window labels.
    spokes: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((hour) => ({ hour, rIn: 316, rOut: 483, alpha: 0.34 })),
    spokeColor: '#b0aaa2',
    hands: { rIn: 316, rOut: 483, color: '#787878', alpha: 0.55 },
    arcHalo: '#050505',
    // no knockout band: it draws a dark rim around every stroke, and the frame
    // sets its arcs straight onto the platter
    arcHaloAlpha: 0,
    // The frame's fringe is a machined ruler, not a whisker field: 384 even
    // marks starting at exactly r 490 and stopping at exactly r 503.5, with a
    // second, sparser ring of 48 long marks standing off outside it at r 525.
    ticks: {
      rInner: 490, minorLen: 13.5, majorLen: 23.3, minorPerHour: 16, jitter: 0,
      majorEvery: 8, majorOffset: 35, color: '#7e7e7e', alpha: 1, glow: 0,
    },
    labelRadius: 540,
    arcPalette: VINYL_ARC_PALETTE,
    donutPalette: VINYL_PALETTE,
    spindleAlpha: 0,
    spindleR: 20.5,
    // the frame's arcs flood the platter beneath them with a soft white bloom —
    // most of what makes its lower half look lit rather than ruled
    arcGlow: 0.34,
    tilt: 0,
    gaugeTop: '#fdfdfd',
    gaugeBottom: '#b5bcfa',
    innerTop: '#fdfdfd',
    innerBottom: '#fcc7b1',
    innerMode: 'pie',
    spindle: '#1f1f1f',
    // Copy Paper's provider middle: white annulus, duration-proportional
    // Claude wedge, and a 70px punched center hole. The surrounding category
    // ring remains Vinyl's own palette and dimensions.
    center: { ringR: 128.25, ringW: 10.5, innerR: 78, holeA: 1, holeR: 35 },
  },

  electric: {
    id: 'electric',
    discR: 461,
    discColor: '#00111d',
    discAlpha: 1,
    ringFields: [
      // thin cyan orbit rings. The frame keeps the approach to the puck clean —
      // no second field of rings across the inner disc.
      // the core is a black void; only the lane band lifts, and its separator
      // bands are soft and share the lane pitch so they read as lane edges
      // rather than as an unrelated moire laid over the top
      { r0: 314, r1: 462, period: 999, duty: 1, color: '#0b2238', alpha: 1, soft: 4, laneZone: true },
      { r0: 316, r1: 460, period: 18, duty: 0.42, color: '#294766', alpha: 0.82, soft: 2, laneGrid: true },
      // The Figma frame's inner edge is a cyan-lit bowl, not an empty hard cut.
      { r0: 303, r1: 308, period: 999, duty: 1, color: '#008bd5', alpha: 0.78, soft: 5, laneInnerRim: true },
    ],
    // Keep the Electric lane background uniform around the full dial.
    sectors: [],
    sectorZone: [305, 461],
    spokes: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((hour) => ({ hour, rIn: 305, rOut: 460, alpha: 0.16 })),
    spokeColor: '#168ccc',
    arcHalo: '#020d1c',
    arcHaloAlpha: 0,
    // the frame's comb is as machined as the vinyl one, just lit
    ticks: {
      rInner: 492, minorLen: 14, majorLen: 24, minorPerHour: 12, jitter: 0.85,
      color: '#74c7ff', alpha: 0, glow: 0,
    },
    // Match Vinyl's 54px clock clearance from the rendered outer edge:
    // Electric ends at r472, so its label centers sit at r526.
    labelRadius: 526,
    // the frame ends the platter on a single hairline; there is no bezel ramp
    outerRing: { r: 472, color: '#0173cd', alpha: 1, width: 1.5, notch: true },
    arcPalette: {
      research: '#3465f6',
      seo: '#00c4fb',
      'agent-tooling': '#31c787',
      swift: '#e8b02a',
      personal: '#e8ecf2',
      'pixel-art': '#9d4efe',
    },
    // the authored list had slipped one slot against the frame — every chip
    // carried its neighbour's colour, and the callouts name them individually
    donutPalette: {
      research: '#3769ff',
      seo: '#9f50ff',
      'agent-tooling': '#ffc550',
      swift: '#33cc8a',
      personal: '#f878ff',
      'pixel-art': '#2b2f6e',
    },
    spindleAlpha: 0,
    spindleR: 19,
    // a hot core against black, not a wide halo: the wider spill was lifting
    // the whole platter out of the frame's near-black
    // Figma uses crisp linear-opacity paint on these paths; there is no
    // neon spill around the thread itself.
    arcGlow: 0,
    arcWidth: 10,
    tilt: 0,
    gaugeTop: '#d8dee4',
    gaugeBottom: '#3ec6e8',
    innerTop: '#8a9099',
    innerBottom: '#8f3f18',
    // the provider split reads as paper's pie wedge now, not the flooded wave
    innerMode: 'wave',
    wave: { y: 8, amp: 4 },
    orb: true,
    spindle: '#061424',
    // the frame carries two rings, not one: a thick segmented gauge band well
    // inside, and a thin solid blue circle outside it
    center: { ringR: 130, ringW: 14, innerR: 77, holeA: 0 },
  },

  glass: {
    id: 'glass',
    discR: 500,
    discColor: '#ffffff',
    discAlpha: 0,
    glass: { r0: 250, r1: 480, alpha: 0.5, lightDeg: 318, rim: 1.0 },
    ringFields: [
      // track ridges pressed into the glass
      { r0: 313, r1: 466, period: 18, duty: 0.5, color: '#ffffff', alpha: 0.22, soft: 3 },
    ],
    sectors: [
      { a0: 296.5, a1: 360, wash: 0.1 },
      { a0: 0, a1: 76, wash: 0.1 },
    ],
    sectorZone: [250, 480],
    spokes: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((hour) => ({ hour, rIn: 150, rOut: 478, alpha: 0.3 })),
    spokeColor: '#ffffff',
    hands: { rIn: 300, rOut: 548, color: '#ffffff', alpha: 0.8 },
    arcHalo: '#ffffff',
    arcHaloAlpha: 0,
    ticks: { rInner: 540, minorLen: 12, majorLen: 34, minorPerHour: 12, jitter: 0.8, color: '#eef0fb', alpha: 0.9, glow: 0 },
    labelRadius: 562,
    outerRing: { r: 492, color: '#ffffff', alpha: 0.55, width: 1.5 },
    arcPalette: {
      research: '#8b96f5',
      seo: '#8b96f5',
      'agent-tooling': '#8b96f5',
      swift: '#8b96f5',
      personal: '#f0a9a0',
      'pixel-art': '#8b96f5',
    },
    donutPalette: {
      research: '#6f8df5',
      seo: '#f0a08e',
      'agent-tooling': '#8ed98a',
      swift: '#6fc6ea',
      personal: '#e87bd0',
      'pixel-art': '#9b8cf0',
    },
    spindleAlpha: 1,
    spindleR: 21,
    arcGlow: 0,
    gloss: 0,
    glassLine: true,
    arcWidth: 10,
    pearl: true,
    centerGlow: 0.5,
    tilt: 0,
    gaugeTop: '#f7f8fd',
    gaugeBottom: '#c6cdf9',
    innerTop: '#b9c1dc',
    innerBottom: '#f2b3aa',
    innerMode: 'pie',
    spindle: '#dfe3f4',
    center: { ringR: 120, ringW: 17, innerR: 95, holeA: 0 },
  },
}
