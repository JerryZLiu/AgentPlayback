// Color Lab override, shared by scene.ts (per-arc colors) and palette.ts
// (category palettes for the donut, chips and callouts) so every surface
// draws from the same audition palette. /lab.html embeds the app with
// ?labpal=<comma-separated hex, no #> and ?labseed=N; absent labpal, all of
// this is inert and the app renders exactly as shipped.

const LAB_ASSIGN: string[] | null = (() => {
  const q = new URLSearchParams(location.search)
  const pal = q
    .get('labpal')
    ?.split(',')
    .filter((c) => /^[0-9a-f]{6}$/i.test(c))
    .map((c) => '#' + c)
  if (!pal?.length) return null
  let s = (Number(q.get('labseed')) || 1) >>> 0
  const rand = () => ((s = (s * 48271) % 2147483647), s / 2147483647)
  // repeated shuffled cycles keep every color's share even while the order
  // stays random-looking
  const assign: string[] = []
  while (assign.length < 256) {
    const cycle = [...pal]
    for (let i = cycle.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[cycle[i], cycle[j]] = [cycle[j], cycle[i]]
    }
    assign.push(...cycle)
  }
  return assign
})()

/** per-arc color: arc `i` takes the i-th slot of the shuffled assignment */
export function labColor(i: number, fallback: string): string {
  return LAB_ASSIGN ? LAB_ASSIGN[i % LAB_ASSIGN.length] : fallback
}

/** category palettes (donut, chips, callouts): each category takes a stable
 * slot from the same assignment, so the center reads in the audition colors */
export function labPalettes<T extends Record<string, string>>(pal: T): T {
  if (!LAB_ASSIGN) return pal
  const out = { ...pal } as Record<string, string>
  Object.keys(out).forEach((k, i) => {
    out[k] = LAB_ASSIGN[i % LAB_ASSIGN.length]
  })
  return out as T
}
