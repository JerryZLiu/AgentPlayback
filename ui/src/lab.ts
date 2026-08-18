// Color Lab — a testing page (/lab.html) for auditioning arc palettes.
// Ten curated 10-color options, each built on one harmonic idea: hue walks
// the allowed band (yellow → gold → green → teal → cyan → blue → indigo →
// deep violet) while lightness and chroma follow a single envelope, and each
// set is tuned to its ground — cream paper wants depth, black vinyl wants
// luminance. House rules hold: no red, no orange, no pink/rose/lavender, no
// brown/gray/white. The preview is the REAL app embedded in an iframe:
// scene.ts reads
// ?labpal=…&labseed=… and cycles a seeded shuffle of the palette across the
// arcs, so what you see here is pixel-identical to the actual UI.

interface Palette {
  name: string
  note: string
  colors: string[]
  /** which ground the set works on: paper/glass are light, vinyl/electric
   * are dark; absent = works on both */
  fit?: 'light' | 'dark'
}

interface Group {
  group: string
  sets: Palette[]
}

const GROUPS: Group[] = [
  {
    group: 'Both grounds',
    sets: [
      { name: 'House Extended', note: 'the master five, hue-gaps filled at the same voltage',
        colors: ['#f4cc06', '#a0ef01', '#3ddc78', '#2bd9c7', '#4dddff', '#3e9fff', '#3b66f5', '#7d8cff', '#9d6bff', '#c46bff'] },
      { name: 'Gold \u2194 Indigo', note: 'true complements \u2014 five golds, five indigos, value-stepped',
        colors: ['#ffdf66', '#f2cb47', '#dcb52f', '#c2a021', '#a68a18', '#7d8cff', '#5c6ef5', '#4453dd', '#333cba', '#262a8f'] },
      { name: 'Triadic Weave', note: 'gold / teal / violet anchors 120\u00b0 apart, tinted',
        colors: ['#ffd951', '#d9b52e', '#b8e03d', '#84c22e', '#2fd6c4', '#17a8a4', '#0f8288', '#9c7dff', '#7452e0', '#5232b0'] },
      { name: 'Isoluminant Field', note: 'equal lightness and chroma \u2014 hue alone separates, nothing shouts',
        colors: ['#c9b23d', '#9dbc4a', '#6cc069', '#45bd90', '#35b4ac', '#3fa6c4', '#5f94d6', '#7f86dd', '#9a74d4', '#6f5fbf'] },
    ],
  },
  {
    group: 'Paper-tuned',
    sets: [
      { name: 'Descending Arc', fit: 'light', note: 'hue advances, value falls \u2014 dusk\u2019s own ordering',
        colors: ['#ffd75e', '#c8d94a', '#8fc94f', '#4fb86f', '#2f9f85', '#22868f', '#2b6b9e', '#3a52a8', '#4a3f9e', '#4c2f7f'] },
      { name: 'Nine Seas, One Gold', fit: 'light', note: 'calm analogous green\u2192indigo run, one gold anchor',
        colors: ['#ffd75e', '#7ac974', '#4fb98a', '#2fa596', '#21909c', '#2678a0', '#315f9e', '#3d4a96', '#453787', '#422a6e'] },
      { name: 'Printed Kodachrome', fit: 'light', note: 'equal-chroma mutes \u2014 ink sunk into paper',
        colors: ['#d9b84a', '#a8a855', '#7f9a58', '#5c8a68', '#45797a', '#43678a', '#4c5591', '#54468c', '#513a7a', '#452f5f'] },
      { name: 'Jewel Box', fit: 'light', note: 'dark gems on cream \u2014 gold leaf, emerald, sapphire, amethyst',
        colors: ['#c9a227', '#8a8f1f', '#3f7f2e', '#1f7a55', '#0e6b6e', '#155a8a', '#23439c', '#38328f', '#4d2a80', '#2a1f5e'] },
    ],
  },
  {
    group: 'Vinyl-tuned',
    sets: [
      { name: 'Phosphor Arc', fit: 'dark', note: 'same arc, lightness held high so black carries it',
        colors: ['#ffe14d', '#c6f23d', '#7dee5c', '#3fe8a0', '#26ddd2', '#35c2f2', '#5c9aff', '#7d7dff', '#9c64ff', '#bb55f2'] },
      { name: 'Neon Halation', fit: 'dark', note: 'weighted to the record\u2019s cyan glow, lime and gold flares',
        colors: ['#f2e83d', '#b8f22e', '#4fe87c', '#1fe0c4', '#17c6f2', '#3d9cff', '#5c78ff', '#8a66ff', '#b056f5', '#22f2a0'] },
    ],
  },
]

const PALETTES: (Palette & { group: string })[] = GROUPS.flatMap((g) =>
  g.sets.map((s) => ({ ...s, group: g.group })),
)

const LAB_SKINS = ['vinyl', 'paper', 'electric', 'glass']
const DATAS = [
  { id: 'real', label: 'Today' },
  { id: 'mock', label: 'Mock day' },
]

// ---- state / iframe ----------------------------------------------------------

const state: {
  pal: number
  skin: number
  data: number
  seed: number
  favs: string[]
  all: boolean
} = {
  pal: 0,
  skin: 0,
  data: 0,
  seed: 1,
  favs: [],
  all: false,
  ...JSON.parse(localStorage.getItem('dayflow-lab') ?? '{}'),
}
state.pal = Math.min(PALETTES.length - 1, Math.max(0, state.pal))
if (!Array.isArray(state.favs)) state.favs = []

// paper and glass are light grounds, vinyl and electric dark; a set tagged
// for the other ground gets dimmed and skipped by keyboard nav unless the
// filter is set to All
const LIGHT_SKINS = new Set(['paper', 'glass'])
const fits = (i: number) =>
  !PALETTES[i].fit ||
  (PALETTES[i].fit === 'light') === LIGHT_SKINS.has(LAB_SKINS[state.skin])
const visible = (i: number) => state.all || fits(i)

// ?skin=paper&pal=3 makes a specific combination linkable/screenshotable
{
  const q = new URLSearchParams(location.search)
  const skinQ = q.get('skin')
  if (skinQ) state.skin = Math.max(0, LAB_SKINS.indexOf(skinQ))
  if (q.get('pal')) state.pal = Math.min(PALETTES.length - 1, Math.max(0, +q.get('pal')! || 0))
  if (q.has('mock')) state.data = 1
}

const frame = document.getElementById('app') as HTMLIFrameElement
const skinsEl = document.getElementById('skins')!
const datasEl = document.getElementById('datas')!
const palsEl = document.getElementById('pals')!
const fitsEl = document.getElementById('fits')!
const swatchesEl = document.getElementById('swatches')!
const subEl = document.getElementById('sub')!

function frameSrc(): string {
  const pal = PALETTES[state.pal].colors.map((c) => c.slice(1)).join(',')
  const parts = [
    `skin=${LAB_SKINS[state.skin]}`,
    `labpal=${pal}`,
    `labseed=${state.seed}`,
    'still=1',
  ]
  if (DATAS[state.data].id === 'mock') parts.push('mock=1')
  return `/?${parts.join('&')}`
}

function apply() {
  skinsEl.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === state.skin))
  datasEl.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === state.data))
  fitsEl.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === (state.all ? 1 : 0)))
  let nFit = 0
  palsEl.querySelectorAll('.pal').forEach((b, i) => {
    b.classList.toggle('on', i === state.pal)
    b.classList.toggle('dim', !fits(i))
    if (fits(i)) nFit++
    const p = PALETTES[i]
    b.querySelector('.star')!.textContent = state.favs.includes(p.name) ? '★' : ''
    if (i === state.pal) (b as HTMLElement).scrollIntoView({ block: 'nearest' })
  })
  const p = PALETTES[state.pal]
  subEl.textContent = `${state.pal + 1} / ${PALETTES.length} — ${p.group} · ${p.note}` +
    (state.all ? '' : ` — ${nFit} fit ${LAB_SKINS[state.skin]}`)
  renderSwatches()
  const src = frameSrc()
  if (frame.getAttribute('src') !== src) frame.setAttribute('src', src)
  localStorage.setItem('dayflow-lab', JSON.stringify(state))
}

function renderSwatches() {
  const pal = PALETTES[state.pal]
  swatchesEl.innerHTML = pal.colors
    .map(
      (c) => `<div class="sw" data-hex="${c}">
        <div class="chip" style="background:${c}"></div>
        <div class="hex">${c}</div>
      </div>`,
    )
    .join('')
  swatchesEl.querySelectorAll<HTMLElement>('.sw').forEach((el) => {
    el.addEventListener('click', () => {
      navigator.clipboard?.writeText(el.dataset.hex!)
      const hexEl = el.querySelector('.hex')!
      const prev = hexEl.textContent
      hexEl.textContent = 'copied'
      setTimeout(() => (hexEl.textContent = prev), 700)
    })
  })
}

// ---- controls ------------------------------------------------------------------

function seg(el: HTMLElement, labels: string[], pick: (i: number) => void) {
  labels.forEach((label, i) => {
    const b = document.createElement('button')
    b.textContent = label
    b.addEventListener('click', () => { pick(i); apply() })
    el.appendChild(b)
  })
}

seg(skinsEl, LAB_SKINS.map((s) => s[0].toUpperCase() + s.slice(1)), (i) => (state.skin = i))
seg(datasEl, DATAS.map((d) => d.label), (i) => (state.data = i))
seg(fitsEl, ['Fit this skin', 'All'], (i) => (state.all = i === 1))

{
  let lastGroup = ''
  PALETTES.forEach((p, i) => {
    if (p.group !== lastGroup) {
      lastGroup = p.group
      const h = document.createElement('div')
      h.className = 'ghead'
      h.textContent = p.group
      palsEl.appendChild(h)
    }
    const b = document.createElement('button')
    b.className = 'pal'
    b.title = p.note
    b.innerHTML = `<div class="row"><span class="idx">${i + 1}</span><span class="name">${p.name}</span><span class="star"></span></div>
      <div class="strip">${p.colors.map((c) => `<i style="background:${c}"></i>`).join('')}</div>`
    b.addEventListener('click', () => { state.pal = i; apply() })
    palsEl.appendChild(b)
  })
}

const reseed = () => { state.seed = (state.seed * 48271 + 11) % 2147483647; apply() }
document.getElementById('shuffle')!.addEventListener('click', reseed)

// group start indices, for [ / ] jumps
const GROUP_STARTS: number[] = []
{
  let g = ''
  PALETTES.forEach((p, i) => { if (p.group !== g) { g = p.group; GROUP_STARTS.push(i) } })
}

// typed-number jump: hit "4" "2" to go to set 42 (1-based); commits after a
// short pause or Enter
let numBuf = ''
let numTimer = 0
function commitNum() {
  const n = parseInt(numBuf, 10)
  numBuf = ''
  if (n >= 1 && n <= PALETTES.length) { state.pal = n - 1; apply() }
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key
  if (k >= '0' && k <= '9') {
    numBuf += k
    clearTimeout(numTimer)
    if (numBuf.length >= 3 || +numBuf > PALETTES.length / 10) commitNum()
    else numTimer = window.setTimeout(commitNum, 450)
    return
  }
  if (k === 'Enter' && numBuf) { clearTimeout(numTimer); commitNum(); return }

  // step to the next set the filter allows (wraps; falls back to a plain
  // step if nothing fits, which can't happen while untagged sets exist)
  const step = (dir: number) => {
    for (let n = 1; n <= PALETTES.length; n++) {
      const i = (state.pal + dir * n + PALETTES.length * PALETTES.length) % PALETTES.length
      if (visible(i)) { state.pal = i; return }
    }
  }

  if (k === 'ArrowDown' || k === 'j') { step(1); apply() }
  else if (k === 'ArrowUp' || k === 'k') { step(-1); apply() }
  else if (k === 'ArrowRight' || k === 'l') { state.skin = (state.skin + 1) % LAB_SKINS.length; apply() }
  else if (k === 'ArrowLeft' || k === 'h') { state.skin = (state.skin + 3) % LAB_SKINS.length; apply() }
  else if (k === ']') {
    state.pal = GROUP_STARTS.find((s) => s > state.pal) ?? 0
    if (!visible(state.pal)) step(1)
    apply()
  } else if (k === '[') {
    // jump to this group's start, or the previous group's if already there
    const starts = GROUP_STARTS.filter((s) => s < state.pal)
    state.pal = starts.length ? starts[starts.length - 1] : GROUP_STARTS[GROUP_STARTS.length - 1]
    if (!visible(state.pal)) step(1)
    apply()
  } else if (k === 'a') { state.all = !state.all; apply() }
  else if (k === 'm') { state.data = 1 - state.data; apply() }
  else if (k === 'f') {
    const name = PALETTES[state.pal].name
    state.favs = state.favs.includes(name) ? state.favs.filter((n) => n !== name) : [...state.favs, name]
    apply()
  } else if (k === '.' || k === ',') {
    const favIdx = PALETTES.map((p, i) => (state.favs.includes(p.name) ? i : -1)).filter((i) => i >= 0)
    if (!favIdx.length) return
    if (k === '.') state.pal = favIdx.find((i) => i > state.pal) ?? favIdx[0]
    else state.pal = [...favIdx].reverse().find((i) => i < state.pal) ?? favIdx[favIdx.length - 1]
    apply()
  } else if (k === ' ') { e.preventDefault(); reseed() }
})

apply()
