// The compute Web Worker: runs bot decisions, coach analysis and table building off the
// page's main thread, so animations and taps never wait for them.
import { run, type Job } from '../coach/compute';

self.onmessage = (e: MessageEvent<{ id: number; job: Job }>) => {
  const { id, job } = e.data;
  const t0 = performance.now();
  try {
    const result = run(job);
    self.postMessage({ id, result, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.stack || err), ms: performance.now() - t0 });
  }
};
