// The compute Web Worker: runs bot decisions, coach analysis and table building off the
// page's main thread, so animations and taps never wait for them.
import { run } from '../coach/compute.js';

self.onmessage = e => {
  const { id, job } = e.data;
  const t0 = performance.now();
  try {
    const result = run(job);
    self.postMessage({ id, result, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err), ms: performance.now() - t0 });
  }
};
