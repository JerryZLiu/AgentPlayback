// Fast scanning machinery shared by the providers: local-time helpers that
// avoid Intl on the per-line hot path, an mtime-keyed per-file record cache,
// and a worker pool that fans cold files across cores.
//
// The design splits each provider's scan into two phases:
//   record(path)  — pure extraction: reads one log file into a compact,
//                   WINDOW-INDEPENDENT record (absolute day keys, raw token
//                   events). Cacheable by (path, mtime, size, version) and
//                   safe to run in a worker thread.
//   replay(rec)   — cheap: feeds the record through the wait/turn/token
//                   trackers with the CURRENT day window applied, so a cached
//                   record from last week yields byte-identical sessions to a
//                   fresh scan under today's window.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'

export const CACHE_ROOT = process.env.DAYFLOW_CACHE ?? join(dirname(dirname(fileURLToPath(import.meta.url))), '.scan-cache')

// ---- local time without Intl ------------------------------------------------
// scan-core's localTime leans on toLocaleDateString('sv'), which costs
// microseconds per call through Intl — ruinous at a million timestamped
// lines. This is the same arithmetic (local YYYY-MM-DD, 4 AM boundary,
// pre-4AM minutes as 24h+) minus the day-window filter, which replay
// applies later so records stay window-independent.
const pad2 = (n) => (n < 10 ? '0' + n : '' + n)
const keyOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
export function localT(iso) {
  const d = new Date(iso)
  if (Number.isNaN(+d)) return null
  let min = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
  let key
  if (min < 4 * 60) {
    const prev = new Date(d)
    prev.setDate(prev.getDate() - 1)
    key = keyOf(prev)
    min += 24 * 60
  } else {
    key = keyOf(d)
  }
  return { key, min }
}

// ---- record cache -----------------------------------------------------------
// One shard per source file (JSON: { v, m, s, r }) so warm runs only rewrite
// shards for files that actually changed — a single monolithic cache file
// would pay a full serialize every run. Shards for files that fell out of the
// scan window are pruned each run so the cache never outgrows the window.

const shardName = (path) => createHash('sha1').update(path).digest('hex') + '.json'

/**
 * Phase A of a provider scan: resolve which files are cache hits vs misses,
 * extract + persist the misses (in-process when there are only a few, across
 * a worker pool otherwise), prune stale shards, and report which DAYS were
 * touched by any change — old record days ∪ new record days for every changed
 * file, plus the days of any deleted/expired file. The caller unions these
 * across providers to decide which day JSONs need reshaping, then calls
 * loadNeeded() to materialize just the records that matter.
 *
 * A tiny per-provider index (shard → its record's day keys) lets hits whose
 * days don't intersect the needed set skip shard loading entirely; a hit
 * missing from the index falls back to loading its shard.
 *
 * @returns plan { files, recs (sparse: misses filled), dirtyDays:Set,
 *                 unknownOld — a changed file's previous days were unreadable,
 *                 so the caller must treat every day as dirty }
 */
export async function planRecords(cacheName, version, files, recordFn, moduleUrl, { prune = true } = {}) {
  const dir = join(CACHE_ROOT, cacheName)
  mkdirSync(dir, { recursive: true })
  const indexPath = join(dir, 'index.json')
  let index = {}
  try { index = JSON.parse(readFileSync(indexPath, 'utf8')) } catch {}
  const recs = new Array(files.length)
  const shards = new Array(files.length)
  const misses = []
  const dirtyDays = new Set()
  let unknownOld = false
  let indexDirty = false
  const expected = new Set(['index.json'])
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const shard = shardName(f.path)
    shards[i] = shard
    expected.add(shard)
    const idx = index[shard]
    if (idx && idx.m === f.mtimeMs && idx.s === f.size && idx.v === version) continue // hit, days known
    // stat mismatch or unknown: read the shard to classify (and learn the
    // old days a changed file used to touch)
    let old = null
    try { old = JSON.parse(readFileSync(join(dir, shard), 'utf8')) } catch {}
    if (old && old.v === version && old.m === f.mtimeMs && old.s === f.size) {
      recs[i] = old.r // hit whose index entry was missing — backfill it
      index[shard] = { m: f.mtimeMs, s: f.size, v: version, d: old.r.days }
      indexDirty = true
      continue
    }
    if (old?.r?.days) for (const d of old.r.days) dirtyDays.add(d)
    else if (index[shard]?.d) for (const d of index[shard].d) dirtyDays.add(d)
    else if (old !== null || existsSyncSafe(join(dir, shard))) unknownOld = true
    misses.push(i)
  }
  if (misses.length) {
    const fresh = misses.length <= 4
      ? misses.map((i) => recordFn(files[i].path))
      : await extractPool(moduleUrl, misses.map((i) => ({ path: files[i].path, size: files[i].size })))
    misses.forEach((i, k) => {
      recs[i] = fresh[k]
      const f = files[i]
      writeFileSync(join(dir, shards[i]), JSON.stringify({ v: version, m: f.mtimeMs, s: f.size, r: fresh[k] }))
      index[shards[i]] = { m: f.mtimeMs, s: f.size, v: version, d: fresh[k].days }
      indexDirty = true
      for (const d of fresh[k].days) dirtyDays.add(d)
    })
  }
  // prune shards whose source files left the window (or were deleted) — their
  // days lose that file's contribution, so they're dirty too. A partial scan
  // (today only) passes prune:false — its file list is deliberately incomplete
  for (const f of prune ? readdirSync(dir) : []) {
    if (expected.has(f)) continue
    const days = index[f]?.d
    if (days) for (const d of days) dirtyDays.add(d)
    else {
      try { for (const d of JSON.parse(readFileSync(join(dir, f), 'utf8'))?.r?.days ?? []) dirtyDays.add(d) }
      catch { unknownOld = true }
    }
    delete index[f]
    indexDirty = true
    rmSync(join(dir, f), { force: true })
  }
  if (indexDirty) writeFileSync(indexPath, JSON.stringify(index))
  return { dir, files, recs, shards, index, dirtyDays, unknownOld }
}

const existsSyncSafe = (p) => { try { statSync(p); return true } catch { return false } }

/** Phase B: materialize the records a reshape actually needs. `needed` is the
 *  set of day keys being recomputed, or null for all. Hits whose indexed days
 *  don't intersect it stay unloaded (recs[i] left undefined). */
export function loadNeeded(plan, needed) {
  const { dir, files, recs, shards, index } = plan
  for (let i = 0; i < files.length; i++) {
    if (recs[i] !== undefined) continue // fresh miss, already in memory
    const days = index[shards[i]]?.d
    if (needed && days && !days.some((d) => needed.has(d))) continue
    try {
      const c = JSON.parse(readFileSync(join(dir, shards[i]), 'utf8'))
      recs[i] = c.r
    } catch {}
  }
  return recs
}

/** One-call form: plan + load everything. */
export async function getRecords(cacheName, version, files, recordFn, moduleUrl) {
  const plan = await planRecords(cacheName, version, files, recordFn, moduleUrl)
  return loadNeeded(plan, null)
}

/** Fan record() calls across a worker pool, results in input order. Files are
 *  dealt largest-first to the least-loaded worker so one giant rollout doesn't
 *  serialize the tail of the scan. */
async function extractPool(moduleUrl, entries) {
  const n = Math.max(1, Math.min(8, availableParallelism() - 2, entries.length))
  const workerUrl = new URL('./record-worker.mjs', import.meta.url)
  const jobs = entries.map((e, i) => ({ i, path: e.path, size: e.size }))
    .sort((a, b) => b.size - a.size)
  const buckets = Array.from({ length: n }, () => ({ load: 0, jobs: [] }))
  for (const j of jobs) {
    const b = buckets.reduce((min, cur) => (cur.load < min.load ? cur : min))
    b.load += j.size
    b.jobs.push(j)
  }
  const out = new Array(entries.length)
  await Promise.all(buckets.filter((b) => b.jobs.length).map((b) => new Promise((resolve, reject) => {
    const w = new Worker(workerUrl, { workerData: { moduleUrl, jobs: b.jobs.map(({ i, path }) => ({ i, path })) } })
    w.on('message', (msg) => {
      if (msg.err) { reject(new Error(msg.err)); return }
      for (const { i, rec } of msg.recs) out[i] = rec
      resolve()
    })
    w.on('error', reject)
  })))
  return out
}
