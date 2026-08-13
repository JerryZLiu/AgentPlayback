// Provider registry: every .mjs file in this directory (except index.mjs) is
// a provider module — drop a new file in and the next scan picks it up. The
// contract each module must satisfy is documented in README.md.

import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const providers = []
for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && x !== 'index.mjs').sort()) {
  const mod = (await import(`./${f}`)).default
  if (!mod || typeof mod.id !== 'string' || typeof mod.name !== 'string' || typeof mod.scan !== 'function') {
    throw new Error(`provider ${f} must export default { id, name, scan() } — see scripts/providers/README.md`)
  }
  if (providers.some((p) => p.id === mod.id)) throw new Error(`duplicate provider id '${mod.id}' (${f})`)
  providers.push(mod)
}

export const PROVIDERS = providers
export const providerById = new Map(providers.map((p) => [p.id, p]))
