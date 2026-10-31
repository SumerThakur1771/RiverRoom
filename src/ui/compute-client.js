// Talks to the compute worker. Every call returns a promise. If the browser cannot start the
// worker, the same jobs run on the page instead (slower, but the game still works).
import { run } from '../coach/compute.js';

let worker = null, nextId = 1;
const waiting = new Map();
/** Durations reported by the worker, per job type (read by the measurement build). */
export const workerMs = {};

try {
  worker = new Worker(new URL('../worker/compute-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    const { id, result, error, ms } = e.data, w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    (workerMs[w.type] ||= []).push(ms);
    if (error) w.reject(new Error(error)); else w.resolve(result);
  };
  worker.onerror = e => { console.error('compute worker failed; computing on the page', e.message); worker = null; for (const [, w] of waiting) w.fallback(); waiting.clear(); };
} catch (e) {
  worker = null;
}

export function compute(job) {
  if (!worker) return Promise.resolve().then(() => run(job));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { type: job.type, resolve, reject, fallback: () => Promise.resolve().then(() => run(job)).then(resolve, reject) });
    worker.postMessage({ id, job });
  });
}
export const usingWorker = () => !!worker;
