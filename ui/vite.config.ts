import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

// Fire-and-forget rescan of the transcript logs, kicked by the UI on page
// load. The full sweep takes ~90s, so the page always renders the cached
// JSON and picks up fresh data on the next reload. Single-flight + cooldown
// keep rapid refreshes from stacking scans.
function scanApi(): Plugin {
  let child: ChildProcess | null = null
  let lastRun = 0
  const COOLDOWN_MS = 5 * 60 * 1000
  return {
    name: 'scan-api',
    configureServer(server) {
      server.middlewares.use('/api/scan', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        res.setHeader('content-type', 'application/json')
        if (child && child.exitCode === null) {
          res.end(JSON.stringify({ started: false, running: true }))
          return
        }
        if (Date.now() - lastRun < COOLDOWN_MS) {
          res.end(JSON.stringify({ started: false, cooldown: true }))
          return
        }
        lastRun = Date.now()
        const script = fileURLToPath(new URL('../scripts/scan-day.mjs', import.meta.url))
        child = spawn(process.execPath, [script], { stdio: 'ignore' })
        res.end(JSON.stringify({ started: true }))
      })
    },
  }
}

// The dashboard runs locally, so an authenticated GitHub CLI can complete the
// explicit button action without sending credentials through the browser.
function githubStarApi(): Plugin {
  return {
    name: 'github-star-api',
    configureServer(server) {
      server.middlewares.use('/api/github/status', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end()
          return
        }

        const canStar = spawnSync('gh', ['auth', 'status'], {
          stdio: 'ignore', timeout: 3_000,
        }).status === 0
        const starred = canStar && spawnSync(
          'gh', ['api', '--silent', '/user/starred/JerryZLiu/AgentPlayback'],
          { stdio: 'ignore', timeout: 5_000 },
        ).status === 0
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ canStar, starred }))
      })

      server.middlewares.use('/api/github/star', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }

        const result = spawnSync(
          '/bin/zsh',
          ['-lic', 'gh api -X PUT user/starred/JerryZLiu/AgentPlayback'],
          { stdio: 'ignore', timeout: 15_000 },
        )
        res.setHeader('content-type', 'application/json')
        res.statusCode = result.status === 0 ? 200 : 503
        res.end(JSON.stringify({ starred: result.status === 0 }))
      })
    },
  }
}

export default defineConfig({
  base: './',
  server: { port: 5199, strictPort: true },
  plugins: [scanApi(), githubStarApi()],
  // main.ts uses top-level await (es2022+) — local dashboard, no old-browser target
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        lab: fileURLToPath(new URL('./lab.html', import.meta.url)),
      },
    },
  },
})
