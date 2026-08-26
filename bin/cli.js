#!/usr/bin/env node
// agentplayback: scan the coding-agent logs on this machine, serve the built
// dashboard on a random local port, open the browser. No daemon, no API keys;
// everything reads from ~/.claude and ~/.codex and writes only under
// ~/.agentplayback.

import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, statSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = join(ROOT, 'ui', 'dist')
const SCAN = join(ROOT, 'scripts', 'scan-day.mjs')
const HOME_DIR = process.env.AGENTPLAYBACK_HOME ?? join(homedir(), '.agentplayback')
const DATA = join(HOME_DIR, 'data')
const ENV = {
  ...process.env,
  DAYFLOW_OUT: DATA,
  DAYFLOW_CACHE: join(HOME_DIR, 'cache'),
  DAYFLOW_PRICE_CACHE: join(HOME_DIR, 'model-prices-cache.json'),
}

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  console.log(`
  agentplayback — are you running too few agents, or too many?

  usage: npx agentplayback [--no-open] [--port N]

  Scans Claude Code and Codex session logs on this machine, then serves the
  dashboard locally. Data lives in ${HOME_DIR}.
`)
  process.exit(0)
}
const noOpen = args.includes('--no-open')
const portArg = args.indexOf('--port')
const port = portArg >= 0 ? Number(args[portArg + 1]) || 0 : 0

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`dashboard build missing at ${DIST} — run \`npm install && npm run build\` first`)
  process.exit(1)
}
mkdirSync(DATA, { recursive: true })

// ---- scan ---------------------------------------------------------------------
// A quick today-only pass blocks (well under a second warm, ~1s cold) so the
// page has today's data the moment it opens; the full history pass then runs
// in the background and the page swaps it in when it lands. Later rescans are
// kicked by the page itself via POST /api/scan.
console.log(`
  ◐ agentplayback — are you running too few agents, or too many?

  Your Claude Code and Codex sessions on a 24-hour dial: when each agent
  ran, when it was waiting on you, and what it cost.

  From the makers of Dayflow → https://dayflow.so
`)
process.stdout.write('  ◐ scanning today…')
const first = spawnSync(process.execPath, [SCAN, '--today'], { env: ENV, stdio: ['ignore', 'ignore', 'inherit'] })
process.stdout.write(first.status === 0 ? ' done\n' : ' failed — serving whatever data exists\n')

let scanChild = null
let scanRunning = false
let lastScan = 0
const COOLDOWN_MS = 5 * 60 * 1000

function agentDayKey(value) {
  const date = new Date(value)
  if (date.getHours() < 4) date.setDate(date.getDate() - 1)
  return date.toLocaleDateString('sv')
}

function sequentialDates() {
  const today = agentDayKey(new Date())
  let earliest = today
  const note = (key) => { if (/^\d{4}-\d{2}-\d{2}$/.test(key) && key < earliest) earliest = key }

  const codexRoot = join(homedir(), '.codex', 'sessions')
  if (existsSync(codexRoot)) {
    for (const year of readdirSync(codexRoot)) {
      const yearDir = join(codexRoot, year)
      let months = []
      try { months = readdirSync(yearDir) } catch { continue }
      for (const month of months) {
        const monthDir = join(yearDir, month)
        let days = []
        try { days = readdirSync(monthDir) } catch { continue }
        for (const day of days) note(`${year}-${month}-${day}`)
      }
    }
  }

  const claudeRoot = join(homedir(), '.claude', 'projects')
  if (existsSync(claudeRoot)) {
    let files = []
    try { files = readdirSync(claudeRoot, { recursive: true }) } catch {}
    for (const rel of files) {
      if (!String(rel).endsWith('.jsonl')) continue
      try {
        const st = statSync(join(claudeRoot, String(rel)))
        note(agentDayKey(new Date(st.birthtimeMs || st.mtimeMs)))
      } catch {}
    }
  }

  const cap = Math.max(0, Number(process.env.DAYFLOW_DAYS_BACK ?? 3650))
  const out = []
  const cursor = new Date(`${today}T12:00:00`)
  for (let i = 0; i <= cap; i++) {
    const key = cursor.toLocaleDateString('sv')
    out.push(key)
    if (key <= earliest) break
    cursor.setDate(cursor.getDate() - 1)
  }
  return out
}

function writeIndex(index) {
  const path = join(DATA, 'days.json')
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...index, revision: Date.now() * 1000 }, null, 2))
  renameSync(tmp, path)
}

function prepareSequentialIndex(dates) {
  let prev = {}
  try { prev = JSON.parse(readFileSync(join(DATA, 'days.json'), 'utf8')) } catch {}
  const summary = prev.summary ?? {}
  writeIndex({
    days: [...dates].sort(),
    today: dates[0],
    partial: true,
    loading: dates.filter((date) => !summary[date]),
    projectColorOrder: prev.projectColorOrder ?? [],
    summary,
  })
}

function finalizeSequentialIndex(dates, failed) {
  const summary = {}
  const projectCosts = new Map()
  const ascending = [...dates].sort()
  for (const key of ascending) {
    let day
    try { day = JSON.parse(readFileSync(join(DATA, `day-${key}.json`), 'utf8')) } catch { continue }
    const cost = day.tokens?.cost
    summary[key] = {
      agents: day.threads.filter((thread) => !thread.dotted).length,
      cost: cost ? +((cost.openai ?? 0) + (cost.claude ?? 0)).toFixed(2) : 0,
    }
    if (ascending.indexOf(key) < ascending.length - 30) continue
    const rows = new Map((day.tokens?.byCategory ?? []).map((row) => [row.category, row]))
    for (const [slot, project] of Object.entries(day.labels ?? {})) {
      if (!project || project === 'Other') continue
      const row = rows.get(slot)
      const providerCosts = Object.values(row?.byProvider ?? {})
      const value = providerCosts.length
        ? providerCosts.reduce((sum, provider) => sum + (Number(provider?.cost) || 0), 0)
        : (Number(row?.openaiCost) || 0) + (Number(row?.claudeCost) || 0)
      projectCosts.set(project, (projectCosts.get(project) ?? 0) + value)
    }
  }
  const projectColorOrder = [...projectCosts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([project]) => project)
  writeIndex({
    days: ascending,
    today: dates[0],
    ...(failed.length ? { partial: true, loading: failed } : {}),
    projectColorOrder,
    summary,
  })
}

function scanDate(date) {
  return new Promise((resolve) => {
    scanChild = spawn(process.execPath, [SCAN, '--date', date], { env: ENV, stdio: 'ignore' })
    scanChild.once('exit', (code) => resolve(code === 0))
    scanChild.once('error', () => resolve(false))
  })
}

async function runSequentialBackfill() {
  const dates = sequentialDates()
  prepareSequentialIndex(dates)
  const failed = []
  // Today was completed by the blocking quick pass. Every historical child
  // must exit before the next date begins, so only one day's scan runs at once.
  for (const date of dates.slice(1)) {
    let ok = await scanDate(date)
    if (!ok) ok = await scanDate(date)
    if (!ok) failed.push(date)
  }
  finalizeSequentialIndex(dates, failed)
  if (failed.length) console.error(`  history finished with ${failed.length} failed day(s)`)
  scanChild = null
  scanRunning = false
}

function rescan(force = false) {
  if (scanRunning) return { started: false, running: true }
  if (!force && Date.now() - lastScan < COOLDOWN_MS) return { started: false, cooldown: true }
  lastScan = Date.now()
  scanRunning = true
  void runSequentialBackfill().catch((error) => {
    console.error('  history backfill failed:', error)
    scanRunning = false
    scanChild = null
  })
  return { started: true }
}
// The mounted page calls POST /api/scan after rendering today's quick result.
// Starting here would let a fast machine finish history before the loading
// calendar ever reaches the screen.

// ---- server -----------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
}
const DAY_JSON = /^\/(day(-\d{4}-\d{2}-\d{2})?|days)\.json$/
const GITHUB_REPOSITORY = 'JerryZLiu/AgentPlayback'

function canUseGitHubCLI() {
  try {
    return spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 3000 }).status === 0
  } catch {
    return false
  }
}

function hasStarredRepository() {
  try {
    return spawnSync('gh', ['api', '--silent', `/user/starred/${GITHUB_REPOSITORY}`], {
      stdio: 'ignore', timeout: 5000,
    }).status === 0
  } catch {
    return false
  }
}

function sendFile(res, file) {
  let st
  try { st = statSync(file) } catch { return false }
  if (!st.isFile()) return false
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-store',
  })
  createReadStream(file).pipe(res)
  return true
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = decodeURIComponent(url.pathname)

  if (path === '/api/github/status') {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    const canStar = canUseGitHubCLI()
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ canStar, starred: canStar && hasStarredRepository() }))
    return
  }
  if (path === '/api/github/star') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    if (!canUseGitHubCLI()) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end('{"error":"gh is unavailable or unauthenticated"}')
      return
    }
    const result = spawnSync('gh', ['api', '--method', 'PUT', `/user/starred/${GITHUB_REPOSITORY}`], {
      stdio: 'ignore', timeout: 10000,
    })
    res.writeHead(result.status === 0 ? 200 : 502, { 'content-type': 'application/json' })
    res.end(result.status === 0 ? '{"starred":true}' : '{"error":"GitHub star failed"}')
    return
  }
  if (path === '/api/scan') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(rescan()))
    return
  }
  // day data comes from the scan output dir, everything else from the build
  if (DAY_JSON.test(path)) {
    if (sendFile(res, join(DATA, path.slice(1)))) return
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not scanned yet"}')
    return
  }
  const rel = normalize(path === '/' ? '/index.html' : path)
  const file = resolve(DIST, '.' + rel)
  if (!file.startsWith(DIST + sep) || !sendFile(res, file)) {
    res.writeHead(404)
    res.end('not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${server.address().port}/`
  console.log(`\n  ◐ agentplayback is running at ${url}\n  press ctrl+c to stop\n`)
  if (!noOpen) openBrowser(url)
})

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
    : ['xdg-open', [url]]
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true })
    child.on('error', () => {}) // no opener on this box — the URL is printed either way
    child.unref()
  } catch {}
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0) })
