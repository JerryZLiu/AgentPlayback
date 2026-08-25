// Skin audition variants: paint-only patches layered over a skin's base,
// flipped from the picker under the skin toggle, pinned with
// ?vinyl=<id> / ?electric=<id>, persisted in localStorage.
//
// Vinyl's variants ride on the shared pressed-surface repaint. Electric's variants are dark-mode explorations — the brief
// was "interesting, bold, allowed outside the current design language" — so
// they retheme the chrome (grooves, ticks, rim, gauge) while the generated
// project colors stay untouched.

import { SKINS, type RingField, type SkinScene } from './skins'

/** The vinyl paint the base skin and the audition variants share. A real pressed surface:
 *  microgrooves at roughly a hundred rings across the band, a smooth deadwax
 *  ring inside them, and an anisotropic sheen that decides where any of it is
 *  visible. Sectors/spokes go — the shader's specular is the one light. */
export const VINYL_PAINT: Partial<SkinScene> = {
  // vinyl carries no seismograph/whisker ring at all (alpha 0 silences both
  // the concurrency bars and the mock's hand-ruled ticks), and the hour
  // labels pull in to sit just off the silver rim
  ticks: {
    ...SKINS.vinyl.ticks, rInner: 515, minorLen: 13, majorLen: 26, jitter: 0.6,
    minorPerHour: 14, alpha: 0, color: '#a29a90', majorEvery: undefined, majorOffset: undefined,
  },
  labelRadius: 480,
  arcGlow: 0.22,
  sectors: [],
  spokes: [],
  ringFields: [
    { r0: 311, r1: 471, period: 999, duty: 1, color: '#0b0b0b', alpha: 1, soft: 8, laneZone: true },
    { r0: 313, r1: 466, period: 18, duty: 0.5, color: '#262524', alpha: 1, soft: 3, laneGrid: true },
  ],
  // no start/end hands: the hard vertical hairlines flanking the notch read
  // as scratches on the pressed surface (Jerry axed them)
  hands: undefined,
  // the brighter silver rim the two Figma frames are drawn with
  discR: 488,
  bezel: { r0: 468, r1: 480, inner: '#161616', outer: '#585858' },
  bezel2: { r0: 480, r1: 488, inner: '#c6c2bc', outer: '#a8a29a' },
  vinylMat: {
    r0: 186,
    r1: 456,
    strength: 0.95,
    pitch: 2.9,
    gloss: 0.2,
    lightDeg: 38,
    color: '#c3c7ce',
  },
  // Keep Vinyl's black label puck and category ring, but copy the provider
  // middle from node 1136:21011: white/peach fields plus a 41px #1f1f1f
  // center hole with the Figma 2.5px angular metal stroke.
  labelDisc: { r: 140, color: '#0a0908' },
  innerMode: 'pie',
  innerTop: '#ffffff',
  innerBottom: '#ffc9b4',
  spindleAlpha: 1,
  spindleR: 20.5,
  spindle: '#1f1f1f',
  center: { ringR: 133, ringW: 7, innerR: 78, holeA: 0, holeR: 0 },
}

export interface SkinVariant {
  id: string
  label: string
  patch: Partial<SkinScene>
  /** electric only: tint for the fine record grain palette.ts injects */
  grain?: string
  /** electric only: tint for the rim ring the seismograph stands on */
  rim?: string
}

// ---- vinyl -----------------------------------------------------------------
export const VINYL_VARIANTS: SkinVariant[] = [
  // The approved render from before this study; kept byte-for-byte as the
  // baseline so every experiment can be judged against it.
  {
    id: 'sheen', label: 'Original',
    patch: {
      vinylMat: {
        r0: 190, r1: 456, strength: 0.55, pitch: 3.2, gloss: 0.07,
        lightDeg: 28, color: '#b2b6bd', grooveDepth: 1, trackBands: 1, wear: 0, focus: 7,
      },
    },
  },

  // A clean new pressing under a narrow overhead strip: finer grooves, a
  // tighter tangential reflection, quieter track separators, and a black PVC
  // edge instead of the baseline's bright machined-looking rim.
  {
    id: 'pressing', label: 'Pressing',
    patch: {
      vinylMat: {
        r0: 184, r1: 462, strength: 0.72, pitch: 2.25, gloss: 0.035,
        lightDeg: 34, color: '#c8c9c6', grooveDepth: 0.72, trackBands: 0.5, wear: 0, focus: 11,
      },
      bezel: { r0: 468, r1: 480, inner: '#080808', outer: '#242424' },
      bezel2: { r0: 480, r1: 488, inner: '#343432', outer: '#111110' },
    },
  },

  // A broad rectangular softbox makes the black PVC readable without turning
  // every groove into a chrome ring. The wider lobe also gives the deadwax a
  // distinct smooth reflection.
  {
    id: 'softbox', label: 'Softbox',
    patch: {
      vinylMat: {
        r0: 196, r1: 460, strength: 0.46, pitch: 2.65, gloss: 0.16,
        lightDeg: 18, color: '#b9b6ae', grooveDepth: 0.58, trackBands: 0.38, wear: 0, focus: 4.2,
      },
      bezel2: { r0: 480, r1: 488, inner: '#4d4b47', outer: '#22211f' },
    },
  },

  // The same black pressing after ordinary handling: reduced gloss, sparse
  // dust and hairline scuffs that appear only in the reflected light, never a
  // noisy texture pasted over the whole disc.
  {
    id: 'played', label: 'Played',
    patch: {
      vinylMat: {
        r0: 190, r1: 458, strength: 0.5, pitch: 2.5, gloss: 0.025,
        lightDeg: 26, color: '#c2beb5', grooveDepth: 0.65, trackBands: 0.42, wear: 0.32, focus: 7.5,
      },
      bezel2: { r0: 480, r1: 488, inner: '#3a3936', outer: '#181817' },
    },
  },
]

// ---- electric --------------------------------------------------------------
// electric's authored fields, re-declared for retinting (same flag rule)
const zoneE = (color: string): RingField =>
  ({ r0: 314, r1: 462, period: 999, duty: 1, color, alpha: 1, soft: 4, laneZone: true })
const gridE = (color: string): RingField =>
  ({ r0: 316, r1: 460, period: 18, duty: 0.38, color, alpha: 0.75, soft: 2, laneGrid: true })
const ringE = (color: string): RingField =>
  ({ r0: 149, r1: 155, period: 999, duty: 1, color, alpha: 1, soft: 1 })
const ticksE = (color: string, glow: number) => ({
  ...SKINS.electric.ticks, rInner: 500, minorLen: 10, majorLen: 26, jitter: 0.85,
  minorPerHour: 12, alpha: 1, color, glow, majorEvery: undefined, majorOffset: undefined,
})

export const ELECTRIC_VARIANTS: SkinVariant[] = [
  { id: 'classic', label: 'Classic', patch: {} },

  // OLED minimalism: pure black, all the cyan HUD chrome collapsed to quiet
  // grays, arcs left to glow as the only light on the panel
  {
    id: 'void', label: 'Void',
    grain: '#17181a', rim: '#48484a',
    patch: {
      discColor: '#000000',
      ringFields: [zoneE('#050505'), gridE('#1f1f21'), ringE('#2c2c2e')],
      ticks: ticksE('#8e8e93', 0.15),
      outerRing: { r: 474, color: '#3a3a3c', alpha: 1, width: 1.5 },
      bezel: { r0: 466, r1: 471, inner: '#101010', outer: '#333336' },
      spokeColor: '#3a3a3c',
      sectors: [],
      arcGlow: 0.9,
      gaugeTop: '#f2f2f7',
      gaugeBottom: '#8e8e93',
      innerTop: '#3a3a3c',
      innerBottom: '#c05a24',
      spindle: '#000000',
    },
  },

  // coal and copper: a warm dark mode lit like a forge, amber chrome instead
  // of cyan
  {
    id: 'ember', label: 'Ember',
    grain: '#33200f', rim: '#c8863c',
    patch: {
      discColor: '#120b06',
      ringFields: [zoneE('#1a1008'), gridE('#3a2a18'), ringE('#c8863c')],
      ticks: ticksE('#e8a34c', 0.8),
      outerRing: { r: 474, color: '#b87333', alpha: 1, width: 2 },
      bezel: { r0: 466, r1: 471, inner: '#2a1808', outer: '#a06428' },
      spokeColor: '#7a5a34',
      arcGlow: 0.6,
      gaugeTop: '#f0e0cc',
      gaugeBottom: '#e8934c',
      innerTop: '#8a7a66',
      innerBottom: '#c05a24',
      spindle: '#140d08',
    },
  },

  // CRT terminal: black-green glass, phosphor traces, heavy glow
  {
    id: 'phosphor', label: 'Phosphor',
    grain: '#083318', rim: '#00cc66',
    patch: {
      discColor: '#020a05',
      ringFields: [zoneE('#04160b'), gridE('#0e3a20'), ringE('#00cc66')],
      ticks: ticksE('#4dff9d', 1.2),
      outerRing: { r: 474, color: '#00b359', alpha: 1, width: 2 },
      bezel: { r0: 466, r1: 471, inner: '#04270f', outer: '#0d8f4a' },
      spokeColor: '#0e6634',
      arcGlow: 0.85,
      gaugeTop: '#d8f0e0',
      gaugeBottom: '#33e07d',
      innerTop: '#6e8a7c',
      innerBottom: '#c05a24',
      spindle: '#020a05',
    },
  },

  // deep-space violet: nebula glass with ultraviolet chrome
  {
    id: 'nebula', label: 'Nebula',
    grain: '#1d1240', rim: '#7a4dff',
    patch: {
      discColor: '#0a0518',
      ringFields: [zoneE('#120a26'), gridE('#2c1d52'), ringE('#7a4dff')],
      ticks: ticksE('#a98cff', 0.9),
      outerRing: { r: 474, color: '#6e46d9', alpha: 1, width: 2 },
      bezel: { r0: 466, r1: 471, inner: '#170f38', outer: '#5a3fc0' },
      spokeColor: '#4a3580',
      arcGlow: 0.7,
      gaugeTop: '#e4defa',
      gaugeBottom: '#8f6cff',
      innerTop: '#8a84a4',
      innerBottom: '#c05a24',
      spindle: '#0a0518',
    },
  },

  // neutral engineering dark: graphite panel, colorless chrome, so the data
  // colors are the only saturated thing on screen
  {
    id: 'graphite', label: 'Graphite',
    grain: '#22262c', rim: '#6a7078',
    patch: {
      discColor: '#101214',
      ringFields: [zoneE('#16181c'), gridE('#2e3238'), ringE('#4a5058')],
      ticks: ticksE('#9aa2ac', 0.15),
      outerRing: { r: 474, color: '#5a6068', alpha: 1, width: 1.5 },
      bezel: { r0: 466, r1: 471, inner: '#1c2024', outer: '#4a5058' },
      spokeColor: '#3a3f46',
      arcGlow: 0.35,
      gaugeTop: '#e8ecf2',
      gaugeBottom: '#9aa2ac',
      innerTop: '#5a6068',
      innerBottom: '#c05a24',
      spindle: '#101214',
    },
  },
]

// ---- registry --------------------------------------------------------------

const REGISTRY: Record<string, SkinVariant[]> = {
  vinyl: VINYL_VARIANTS,
  electric: ELECTRIC_VARIANTS,
}

const current: Record<string, string> = { vinyl: 'pressing', electric: 'classic' }

/** the audition set for a skin, or undefined if it has none */
export function variantsFor(skin: string): SkinVariant[] | undefined {
  return REGISTRY[skin]
}

export function setVariant(skin: string, id: string | null | undefined) {
  const set = REGISTRY[skin]
  if (set) current[skin] = set.some((v) => v.id === id) ? id! : set[0].id
}

export function variantId(skin: string): string {
  return current[skin] ?? REGISTRY[skin]?.[0]?.id ?? 'classic'
}

function active(skin: string): SkinVariant | undefined {
  return REGISTRY[skin]?.find((v) => v.id === current[skin])
}

/** the active variant's patch — {} for skins without variants */
export function variantPatch(skin: string): Partial<SkinScene> {
  return active(skin)?.patch ?? {}
}

/** grain tint for electric's fine record rings (palette.ts injects them) */
export function electricGrainColor(): string {
  return active('electric')?.grain ?? '#0f4a75'
}

/** rim-ring tint for electric's seismograph baseline */
export function electricRimColor(): string {
  return active('electric')?.rim ?? '#3f9ccc'
}

/** the vinyl skin as painted: pressed-surface look + variant */
export function vinylBase(): SkinScene {
  return { ...SKINS.vinyl, ...VINYL_PAINT, ...variantPatch('vinyl') }
}
