// Where the agent logs live. Mirrors ccusage's discovery rules so the same
// environment variables work here:
//   CLAUDE_CONFIG_DIR  comma-separated Claude config dirs (or their projects/ dirs)
//                      default: $XDG_CONFIG_HOME/claude and ~/.claude, whichever exist
//   CODEX_HOME         comma-separated Codex homes; default ~/.codex
// Paths are OS-native, so this is also the one place that knows about
// Windows (%USERPROFILE%\.claude, backslashes, drive letters).
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
const expandHome = (p) => p === '~' ? homedir() : /^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p
const envList = (name) => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => resolve(expandHome(s)))

/** Claude Code `projects/` dirs that exist, deduped, in priority order */
export function claudeProjectRoots(home = homedir()) {
  const out = []
  const add = (dir) => { if (isDir(dir) && !out.includes(dir)) out.push(dir) }
  const env = envList('CLAUDE_CONFIG_DIR')
  if (env.length) {
    for (const p of env) add(basename(p) === 'projects' ? p : join(p, 'projects'))
    return out
  }
  const xdg = process.env.XDG_CONFIG_HOME ? resolve(expandHome(process.env.XDG_CONFIG_HOME)) : join(home, '.config')
  add(join(xdg, 'claude', 'projects'))
  add(join(home, '.claude', 'projects'))
  return out
}

/** Codex home dirs (each may hold sessions/, archived_sessions/, session_index.jsonl) */
export function codexHomes(home = homedir()) {
  const env = envList('CODEX_HOME')
  return env.length ? env : [join(home, '.codex')]
}

/** split a path on either separator — readdirSync({recursive}) hands back
 *  backslash-joined relatives on Windows */
export const splitPath = (p) => String(p).split(/[\\/]/)
