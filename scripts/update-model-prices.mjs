#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFile } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_OUTPUT = resolve(ROOT, 'pricing', 'openai-anthropic.json')
const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

const sourcePath = arg('--source')
const outputPath = resolve(arg('--output') ?? DEFAULT_OUTPUT)
const sourceText = sourcePath
  ? readFileSync(resolve(sourcePath), 'utf8')
  : await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(30_000) }).then((res) => {
      if (!res.ok) throw new Error(`LiteLLM pricing download failed: HTTP ${res.status}`)
      return res.text()
    })
const upstream = JSON.parse(sourceText)
const prices = Object.fromEntries(Object.entries(upstream)
  .filter(([, entry]) => (entry?.litellm_provider === 'openai' || entry?.litellm_provider === 'anthropic')
    && Number.isFinite(entry.input_cost_per_token)
    && Number.isFinite(entry.output_cost_per_token))
  .sort(([a], [b]) => a.localeCompare(b)))

if (!Object.keys(prices).length) throw new Error('LiteLLM pricing subset was empty')

let previous = null
try { previous = JSON.parse(readFileSync(outputPath, 'utf8')) } catch {}
if (previous?.schema_version === 1 && JSON.stringify(previous.prices) === JSON.stringify(prices)) {
  console.log(`Pricing unchanged (${Object.keys(prices).length} OpenAI/Anthropic models)`)
  process.exit(0)
}

const manifest = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  upstream: {
    url: UPSTREAM_URL,
    sha256: createHash('sha256').update(sourceText).digest('hex'),
  },
  prices,
}
const json = JSON.stringify(manifest, null, 2) + '\n'
mkdirSync(dirname(outputPath), { recursive: true })
const tmp = `${outputPath}.${process.pid}.tmp`
await new Promise((resolveWrite, reject) => writeFile(tmp, json, (error) => error ? reject(error) : resolveWrite()))
renameSync(tmp, outputPath)
console.log(`Wrote ${Object.keys(prices).length} OpenAI/Anthropic models to ${outputPath}`)
