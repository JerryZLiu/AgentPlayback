// Worker-thread body for fastscan's extract pool: import the provider module
// named in workerData, run its record() over the assigned files, post the
// records back tagged with their input indices.
import { workerData, parentPort } from 'node:worker_threads'

const { moduleUrl, jobs } = workerData
try {
  const { record } = await import(moduleUrl)
  const recs = jobs.map(({ i, path }) => ({ i, rec: record(path) }))
  parentPort.postMessage({ recs })
} catch (e) {
  parentPort.postMessage({ err: e?.stack ?? String(e) })
}
