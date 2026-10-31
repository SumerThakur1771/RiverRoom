// Time settle() at the largest exact size (16 people with nonzero balances) and compare its
// transfer count with the greedy method on the same random nights.
// Usage: npx tsx tools/ledger/bench-settle.ts [nights=200]
import { greedy, MAX_EXACT, settle, type Balance } from '../../src/ledger/settle';
import { mulberry32 } from '../../src/engine/rng';

const NIGHTS = +(process.argv[2] ?? 200);
const rnd = mulberry32(2026);
const night = (n: number): Balance[] => {
  const xs = Array.from({ length: n - 1 }, () => (Math.floor(rnd() * 41) - 20) * 50); // -$10..+$10 in 50c steps
  const last = -xs.reduce((a, b) => a + b, 0);
  return [...xs, last].map((net, i) => ({ name: 'P' + i, net: net || 50 * (i % 2 ? 1 : -1) }));
};
const fix = (b: Balance[]): Balance[] => { const t = b.reduce((a, x) => a + x.net, 0); b[0]!.net -= t; return b; };
for (const n of [6, 10, MAX_EXACT]) {
  let ms = 0, worst = 0, fewer = 0, exactT = 0, greedyT = 0;
  for (let k = 0; k < NIGHTS; k++) {
    const b = fix(night(n));
    const t0 = performance.now();
    const s = settle(b);
    const dt = performance.now() - t0;
    ms += dt; worst = Math.max(worst, dt);
    const g = greedy(b);
    exactT += s.length; greedyT += g.length;
    if (s.length < g.length) fewer++;
  }
  console.log(`${n} people, ${NIGHTS} random nights: settle() mean ${(ms / NIGHTS).toFixed(2)} ms, worst ${worst.toFixed(1)} ms; transfers exact ${exactT} vs greedy ${greedyT}; fewer than greedy on ${fewer}/${NIGHTS} nights`);
}
