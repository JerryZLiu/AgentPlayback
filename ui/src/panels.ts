// The two floating stat panels from the Agents-view master frame:
// "Token usage" (node 863:43826, bottom-left) and "Code written over time"
// (node 863:43077, bottom-right). Both are glass cards with the frame's
// warm header bar, and both collapse from the header.
//
// Real days show the scanner's own numbers: token buckets from the logs,
// priced per model off LiteLLM's rate table. Only the mock (which has no
// logs behind it) still derives its figures from thread durations at
// placeholder rates, to keep the authored art intact. Real days that predate
// the scanner's token support say so instead of estimating.

import { MOCK_DAY, projectHours, type DayData } from './data'

type SkinLike = { id?: string; donutPalette: Record<string, string> }

/** mock-only placeholder rates, calibrated to land near the frame's numbers */
const TOK_PER_HR = 5_650_000
const USD_PER_MTOK: Record<string, number> = { openai: 1.1, claude: 2.2 }

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US')
/** compact token count for the tight legend grid: 8.5M / 531k / 180 */
const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`
const fmtUSD = (n: number) => `$${n.toFixed(2)} USD`
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ---- shared shell ------------------------------------------------------------

/** glass card + warm header bar; the header and disclosure caret collapse
 *  the body, and the choice persists per panel */
export function panelShell(id: string, title: string, cls: string): { el: HTMLElement; body: HTMLElement } {
  const el = document.createElement('div')
  el.className = `data-panel ${cls}`
  if (localStorage.getItem(`dayflow-panel-${id}`) === '1') el.classList.add('collapsed')
  const head = document.createElement('div')
  head.className = 'data-panel-head clickable'
  head.innerHTML = `<span>${esc(title)}</span>
    <svg class="panel-caret" width="14" height="14" viewBox="0 0 14 14">
      <path d="M3 5.5 L7 9.5 L11 5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`
  head.addEventListener('click', () => {
    const c = el.classList.toggle('collapsed')
    localStorage.setItem(`dayflow-panel-${id}`, c ? '1' : '0')
  })
  const body = document.createElement('div')
  body.className = 'data-panel-body'
  el.append(head, body)
  return { el, body }
}

// ---- svg helpers -------------------------------------------------------------

/** one donut segment as a FILLED annular sector with softly rounded corners —
 *  the frame's segments round their four corners a few px, which neither butt
 *  caps (too sharp) nor round line caps (semicircles that swallow small
 *  segments) can reproduce */
function segPath(cx: number, cy: number, r: number, w: number, a0: number, a1: number, rc: number): string {
  const Ro = r + w / 2
  const Ri = r - w / 2
  rc = Math.max(Math.min(rc, w / 2 - 0.5, ((a1 - a0) * Ri) / 2.5), 0.1)
  const co = rc / Ro
  const ci = rc / Ri
  const P = (radius: number, ang: number) =>
    `${(cx + radius * Math.sin(ang)).toFixed(2)} ${(cy - radius * Math.cos(ang)).toFixed(2)}`
  const large = a1 - a0 - co * 2 > Math.PI ? 1 : 0
  return [
    `M ${P(Ro, a0 + co)}`,
    `A ${Ro} ${Ro} 0 ${large} 1 ${P(Ro, a1 - co)}`,
    `A ${rc} ${rc} 0 0 1 ${P(Ro - rc, a1)}`,
    `L ${P(Ri + rc, a1)}`,
    `A ${rc} ${rc} 0 0 1 ${P(Ri, a1 - ci)}`,
    `A ${Ri} ${Ri} 0 ${large} 0 ${P(Ri, a0 + ci)}`,
    `A ${rc} ${rc} 0 0 1 ${P(Ri + rc, a0)}`,
    `L ${P(Ro - rc, a0)}`,
    `A ${rc} ${rc} 0 0 1 ${P(Ro, a0 + co)}`,
    'Z',
  ].join(' ')
}

function donutSVG(
  cx: number, cy: number, r: number, w: number, label: string,
  segs: { color: string; frac: number }[],
  gradientPrefix?: string,
): string {
  const defs = gradientPrefix ? `<defs>${segs.map((s, i) => `
    <radialGradient id="${gradientPrefix}-${i}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r + w / 2}">
      <stop offset="7%" stop-color="${s.color}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="${s.color}" stop-opacity="1"/>
    </radialGradient>`).join('')}</defs>` : ''
  const paint = (s: { color: string }, i: number) =>
    gradientPrefix ? `url(#${gradientPrefix}-${i})` : s.color
  if (segs.length === 1) {
    return `${defs}<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${paint(segs[0], 0)}" stroke-width="${w}"/>`
      + `<text x="${cx}" y="${cy}" class="donut-label" text-anchor="middle" dominant-baseline="middle">${esc(label)}</text>`
  }
  const GAP = 4 / r // ~4px seam whatever the radius
  const usable = Math.PI * 2 - GAP * segs.length
  let a = -Math.PI / 2 // seam starts at 9 o'clock like the frame's art
  const paths = segs.map((s, i) => {
    const span = Math.max(s.frac * usable, 0.05)
    const d = segPath(cx, cy, r, w, a, a + span, gradientPrefix ? 1 : w * 0.16)
    a += span + GAP
    return `<path d="${d}" fill="${paint(s, i)}"${gradientPrefix ? ` stroke="${s.color}" stroke-opacity="0.5" stroke-width="0.5"` : ''}/>`
  }).join('')
  return `${defs}${paths}<text x="${cx}" y="${cy}" class="donut-label" text-anchor="middle" dominant-baseline="middle">${esc(label)}</text>`
}

// ---- token usage panel ---------------------------------------------------------

/** "claude-fable-5" → "Fable 5", "gpt-5.6-sol" → "GPT-5.6 Sol" */
function prettyModel(id: string): string {
  if (id.startsWith('gpt-')) {
    const [ver, ...rest] = id.slice(4).split('-')
    return `GPT-${ver}${rest.map((w) => ` ${w[0].toUpperCase()}${w.slice(1)}`).join('')}`
  }
  return id.replace(/^claude-/, '').split('-')
    .map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ')
}

export function buildTokenPanel(day: DayData, skin: SkinLike): HTMLElement {
  const { el, body } = panelShell('token', 'Token usage', 'panel-token')
  const catLabel = (cat: string) => day.labels[cat as keyof typeof day.labels] ?? cat

  const mock = day === MOCK_DAY
  const real = day.tokens && day.tokens.openai + day.tokens.claude > 0 ? day.tokens : null

  // a real day without token data predates the scanner's usage support —
  // say so rather than inventing an estimate that reads as measured
  if (!real && !mock) {
    body.innerHTML = `<div class="tp-cap tp-empty">No token data recorded for this day.</div>`
    return el
  }

  // the mock has no logs behind it: duration-derived figures at placeholder
  // rates keep the frame's authored art. Real days carry measured tokens and
  // per-model, per-bucket pricing from the scanner; tokens whose model the
  // price table doesn't know contribute $0, so a day with unpriced models
  // shows the dollars it can account for rather than none.
  const provHours = (p: string) =>
    day.threads.filter((t) => t.provider === p).reduce((a, t) => a + t.end - t.start, 0)
  const mockCost = (n: number, p: string) => (n / 1e6) * USD_PER_MTOK[p]
  const oTok = real ? real.openai : provHours('openai') * TOK_PER_HR
  const cTok = real ? real.claude : provHours('claude') * TOK_PER_HR
  const totalTok = oTok + cTok
  const costs = mock
    ? { openai: mockCost(oTok, 'openai'), claude: mockCost(cTok, 'claude') }
    : real?.cost ?? null
  const modelName = (p: 'openai' | 'claude', fallback: string) => {
    const ids = real?.models[p] ?? []
    return ids.length ? ids.map(prettyModel).join('<br/>') : fallback
  }

  const cats = real
    ? real.byCategory.filter((c) => c.openai + c.claude > 0).map((c) => ({
      cat: c.category,
      color: skin.donutPalette[c.category] ?? '#cccccc',
      tok: c.openai + c.claude,
      usd: (c.openaiCost ?? 0) + (c.claudeCost ?? 0),
    }))
    : projectHours(day).map((d) => {
      const co = day.threads.filter((t) => t.category === d.category && t.provider === 'openai')
        .reduce((a, t) => a + t.end - t.start, 0)
      return {
        cat: d.category,
        color: skin.donutPalette[d.category] ?? '#cccccc',
        tok: d.hours * TOK_PER_HR,
        usd: mockCost(co * TOK_PER_HR, 'openai') + mockCost((d.hours - co) * TOK_PER_HR, 'claude'),
      }
    })
  const tokSum = cats.reduce((a, c) => a + c.tok, 0) || 1
  const usdSum = cats.reduce((a, c) => a + c.usd, 0) || 1

  // model bars: heights in true proportion to each provider's token count —
  // the logo tucks inside only when the bar is tall enough to hold it. The
  // mock keeps the frame's authored share-compressed heights.
  const mxTok = Math.max(oTok, cTok, 1)
  const barH = (v: number) => mock
    ? Math.round(30 + (totalTok > 0 ? v / totalTok : 0.5) * 56)
    : Math.max(Math.round((v / mxTok) * 86), 5)
  const bar = (v: number, cls: string, logo: string) => {
    const h = barH(v)
    return `<div class="tp-bar ${cls}" style="height:${h}px">${
      h >= 26 ? `<img src="${logo}" alt="" width="16" height="16" />` : ''}</div>`
  }
  const usd = (n: number | undefined) =>
    costs && n !== undefined ? `<span class="tp-usd">${fmtUSD(n)}</span>` : ''
  const electric = skin.id === 'electric'
  // All skins share one information layout. Electric changes the paint through
  // gradient IDs below, but not the relative scale or placement of the charts.
  const usageDonut = { cx: costs ? 78 : 129, cy: costs ? 78 : 84, r: 52, w: 24 }
  const costDonut = { cx: 203, cy: 122, r: 26, w: 13 }

  body.innerHTML = `
    <div class="tp-total">
      <div class="tp-cap">Total token use</div>
      <div class="tp-big${fmtInt(totalTok).length > 8 ? ' tp-big-compact' : ''}">${fmtInt(totalTok)}</div>
      ${costs ? `<div class="tp-cost">${fmtUSD(costs.openai + costs.claude)}</div>` : ''}
    </div>
    <div class="tp-models">
      <div class="tp-model">
        <b>${fmtInt(oTok)} Tokens</b>
        ${usd(costs?.openai)}
        ${bar(oTok, 'tp-bar-openai', '/assets/openai-mark.svg')}
      </div>
      <div class="tp-model">
        <b>${fmtInt(cTok)} Tokens</b>
        ${usd(costs?.claude)}
        ${bar(cTok, 'tp-bar-claude', '/assets/claude-spark.png')}
      </div>
    </div>
    <div class="tp-axis"></div>
    <div class="tp-names">
      <span>${modelName('openai', 'Codex')}</span>
      <span>${modelName('claude', 'Claude')}</span>
    </div>
    <div class="tp-cap tp-cap-mid">Token usage${costs ? ' and cost' : ''} by category</div>
    <svg class="tp-donuts" viewBox="0 0 258 168">
      ${costs
        ? donutSVG(usageDonut.cx, usageDonut.cy, usageDonut.r, usageDonut.w, 'Usage', cats.map((c) => ({ color: c.color, frac: c.tok / tokSum })), electric ? 'electric-usage' : undefined)
          + donutSVG(costDonut.cx, costDonut.cy, costDonut.r, costDonut.w, 'Cost', cats.map((c) => ({ color: c.color, frac: c.usd / usdSum })), electric ? 'electric-cost' : undefined)
        : donutSVG(usageDonut.cx, usageDonut.cy, usageDonut.r, usageDonut.w, 'Usage', cats.map((c) => ({ color: c.color, frac: c.tok / tokSum })), electric ? 'electric-usage' : undefined)}
    </svg>
    <div class="tp-legend">${cats.map((c) => `
      <div class="tp-key">
        <span class="tp-swatch" style="background:${c.color}"></span>
        <div class="tp-key-body">
          <div class="tp-key-name">${esc(catLabel(c.cat))}</div>
          <div class="tp-key-tok">${fmtTok(c.tok)}</div>
          ${costs ? `<div class="tp-key-usd">${fmtUSD(c.usd)}</div>` : ''}
        </div>
      </div>`).join('')}
    </div>`
  return el
}

// ---- code written over time panel ----------------------------------------------

/** sum-preserving rebin of the scanner's buckets onto the chart's bar count */
function rebin(src: number[], n: number): number[] {
  const out = Array(n).fill(0)
  src.forEach((v, i) => { out[Math.min(n - 1, Math.floor((i / src.length) * n))] += v })
  return out
}

/** Compact chart-edge time, matching the Figma pills: 9 AM / 1:30 PM. */
function chartTime(hours: number): string {
  const totalMinutes = Math.round(hours * 60)
  const hour24 = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  const hour12 = hour24 % 12 || 12
  return `${hour12}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''} ${hour24 < 12 ? 'AM' : 'PM'}`
}

function chartTimePill(label: string, edge: 'start' | 'end'): string {
  const width = Math.max(22, label.length * 3.35 + 6)
  const x = edge === 'start' ? 0 : 260 - width
  const cx = x + width / 2
  return `<g class="cp-time cp-time-${edge}">
    <rect class="cp-time-bg" x="${x.toFixed(1)}" y="78.5" width="${width.toFixed(1)}" height="12" rx="6"/>
    <text class="cp-time-label" x="${cx.toFixed(1)}" y="84.8" text-anchor="middle" dominant-baseline="middle">${label}</text>
  </g>`
}

export function buildCodePanel(day: DayData): HTMLElement {
  const { el, body } = panelShell('code', 'Code written over time', 'panel-code')
  const catLabel = (cat: string) => day.labels[cat as keyof typeof day.labels] ?? cat

  // the Data-vis frame (node 863:43693): dense 2px bars mirrored on a shared
  // axis — lines added rise above it, lines removed hang below, both fading
  // toward the axis. Real days draw the scanner's diff counts and show a bare
  // axis when there are none; only the mock (which has no logs) substitutes a
  // thread-activity silhouette, to keep the frame's authored art.
  const NB = 84
  let add: number[] = Array(NB).fill(0)
  let del: number[] = Array(NB).fill(0)
  if (day.code && (day.code.add.some(Boolean) || day.code.del.some(Boolean))) {
    add = rebin(day.code.add, NB)
    del = rebin(day.code.del, NB)
  } else if (day === MOCK_DAY) {
    const s = day.meta.dayStart ?? 0
    const e = day.meta.dayEnd ?? 24
    add = Array.from({ length: NB }, (_, i) => {
      const h = s + ((i + 0.5) / NB) * Math.max(e - s, 0.1)
      return day.threads.reduce((n, t) => n + (t.start <= h && t.end >= h ? 1 : 0), 0)
    })
    del = add.map((v, i) => (i > 0 && add[i - 1] > v ? add[i - 1] - v : 0))
  }
  const mx = Math.max(...add, ...del, 1)
  // sqrt scale: one 4k-line refactor spike would otherwise flatten the rest
  // of the day into hairlines
  const H_UP = 58
  const H_DN = 44
  const bw = 2
  const stepX = 244 / NB
  let bars = ''
  for (let i = 0; i < NB; i++) {
    const x = (8 + i * stepX).toFixed(1)
    if (add[i]) {
      const h = Math.max(Math.sqrt(add[i] / mx) * H_UP, 1.5)
      bars += `<rect x="${x}" y="${(84 - h).toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="0.5" fill="url(#cpUp)"/>`
    }
    if (del[i]) {
      const h = Math.max(Math.sqrt(del[i] / mx) * H_DN, 1.5)
      bars += `<rect x="${x}" y="85" width="${bw}" height="${h.toFixed(1)}" rx="0.5" fill="url(#cpDown)"/>`
    }
  }

  // Electric's authored HUD uses one continuous filled waveform instead of
  // scanner needles. Rebinning before smoothing keeps individual bursts
  // visible while producing the broad silhouette in the Figma frame.
  const areaPath = (src: number[], baseline: number, height: number, down = false): string => {
    const vals = rebin(src, 34)
    const pts = vals.map((v, i) => {
      const x = 8 + (i / Math.max(vals.length - 1, 1)) * 244
      const h = Math.sqrt(v / mx) * height
      return [x, baseline + (down ? h : -h)] as const
    })
    if (!pts.length) return ''
    let d = `M ${pts[0][0].toFixed(1)} ${baseline} L ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1]
      const cur = pts[i]
      const mxp = ((prev[0] + cur[0]) / 2).toFixed(1)
      const myp = ((prev[1] + cur[1]) / 2).toFixed(1)
      d += ` Q ${prev[0].toFixed(1)} ${prev[1].toFixed(1)} ${mxp} ${myp}`
    }
    const last = pts[pts.length - 1]
    d += ` T ${last[0].toFixed(1)} ${last[1].toFixed(1)} L ${last[0].toFixed(1)} ${baseline} Z`
    return d
  }
  const areaUp = areaPath(add, 84.5, H_UP)
  const areaDown = areaPath(del, 84.5, H_DN, true)
  const chartStart = chartTime(day.code?.start ?? day.meta.dayStart ?? 0)
  const chartEnd = chartTime(day.code?.end ?? day.meta.dayEnd ?? 24)

  // per-category lines +/− from the logs; mock/pre-scan days show nothing
  // rather than an invented number
  const totals = (day.codeTotals ?? []).filter((c) => c.add || c.del)
  const rows = totals.map((c) => `
    <div class="cp-row">
      <span>${esc(catLabel(c.category))}</span>
      <span class="cp-delta"><b class="cp-pos">+ ${fmtInt(c.add)}</b><b class="cp-neg">− ${fmtInt(c.del)}</b></span>
    </div>`).join('')

  body.innerHTML = `
    <svg class="cp-chart" viewBox="0 0 260 150">
      <defs>
        <linearGradient id="cpUp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="cp-stop-pos" stop-opacity="1"/>
          <stop offset="1" class="cp-stop-pos" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="cpDown" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="cp-stop-neg" stop-opacity="0"/>
          <stop offset="1" class="cp-stop-neg" stop-opacity="1"/>
        </linearGradient>
      </defs>
      <line x1="8" y1="84.5" x2="252" y2="84.5" class="cp-axis"/>
      <g class="cp-bars">${bars}</g>
      <g class="cp-electric-area" filter="url(#cpGlow)">
        <defs>
          <filter id="cpGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.6" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <path d="${areaUp}" fill="url(#cpUp)"/>
        <path d="${areaDown}" fill="url(#cpDown)"/>
      </g>
      ${chartTimePill(chartStart, 'start')}
      ${chartTimePill(chartEnd, 'end')}
    </svg>
    <div class="cp-list">
      <div class="cp-cap">Lines changed by project</div>
      ${rows || '<div class="cp-row"><span>No code changes recorded</span></div>'}
    </div>`
  return el
}
