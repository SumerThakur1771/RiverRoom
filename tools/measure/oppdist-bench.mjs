// Time the split-game opponent model (oppDist) and the lazy strength tables it uses,
// extracted from legacy/river-room.html and run in Node (no browser, no rendering).
// Usage: node tools/measure/oppdist-bench.mjs
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const html = readFileSync(new URL('../../legacy/river-room.html', import.meta.url), 'utf8');
const a = html.indexOf('const RANKCH'), b = html.indexOf('const oppCdf');
if (a < 0 || b < 0) throw new Error('source markers not found');
const load = () => new Function('S', 'MONEY', html.slice(a, b) + '\nreturn { tpPct, h5Pct, oppDist };')(null, true);
const time = fn => { const t0 = performance.now(); fn(); return performance.now() - t0; };

// Run 1: build the tables first, then each variant (fresh copy of the code).
let m = load();
console.log(`tpPct first call (builds 3 Patti table, 22,100 hands): ${time(() => m.tpPct([0, 5, 9])).toFixed(0)} ms`);
console.log(`h5Pct first call (builds 30,000-hand 5-card table):   ${time(() => m.h5Pct([0, 5, 9, 13, 17])).toFixed(0)} ms`);
for (const k of ['std', 'two', 'n7', 'k8']) console.log(`oppDist('${k}') with tables built: ${time(() => m.oppDist(k)).toFixed(0)} ms`);
// Run 2: each variant cold, in a fresh copy (includes any table it needs).
for (const k of ['std', 'two', 'n7', 'k8']) { m = load(); console.log(`oppDist('${k}') cold, fresh copy: ${time(() => m.oppDist(k)).toFixed(0)} ms`); }
