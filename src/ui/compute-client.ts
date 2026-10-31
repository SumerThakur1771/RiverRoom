// Talks to the compute worker. Every call returns a promise. If the browser cannot start the
// worker, the same jobs run on the page instead (slower, but the game still works).
import { run, type Job, type ResultOf } from '../coach/compute';

interface Reply { id: number; result?: unknown; error?: string; ms: number }
interface Waiting { type: Job['type']; resolve: (v: unknown) => void; reject: (e: Error) => void; fallback: () => void }

let worker: Worker | null = null, nextId = 1;
const waiting = new Map<number, Waiting>();
/** Durations reported by the worker, per job type (read by the measurement build). */
export const workerMs: Partial<Record<Job['type'], number[]>> = {};

try {
  worker = new Worker(new URL('../worker/compute-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const { id, result, error, ms } = e.data, w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    (workerMs[w.type] ||= []).push(ms);
    if (error) w.reject(new Error(error)); else w.resolve(result);
  };
  worker.onerror = e => {
    console.error('compute worker failed; computing on the page', e.message);
    worker = null;
    for (const [, w] of waiting) w.fallback();
    waiting.clear();
  };
} catch {
  worker = null;
}

/** Run a job in the worker (or on the page if there is no worker); resolves with its result. */
export function compute<J extends Job>(job: J): Promise<ResultOf<J>> {
  const w = worker;
  if (!w) return Promise.resolve().then(() => run(job));
  return new Promise<ResultOf<J>>((resolve, reject: (e: Error) => void) => {
    const id = nextId++;
    // the worker runs the same run(job), so its reply has this job's result type
    const done = (v: unknown): void => resolve(v as ResultOf<J>);
    waiting.set(id, { type: job.type, resolve: done, reject, fallback: () => { Promise.resolve().then(() => run(job)).then(resolve, reject); } });
    w.postMessage({ id, job });
  });
}
export const usingWorker = (): boolean => !!worker;
