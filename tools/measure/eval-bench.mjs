// Evaluator benchmark + correctness check for the legacy single-file build.
// It extracts the real evaluator source from legacy/river-room.html (no copy-paste),
// so the numbers describe exactly the code that ships today.
//
// Usage: node tools/measure/eval-bench.mjs [path/to/river-room.html]
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const file = process.argv[2] || new URL('../../legacy/river-room.html', import.meta.url);
const html = readFileSync(file, 'utf8');
const start = html.indexOf('function straightHigh(');
const end = html.indexOf('function kAt(');
if (start < 0 || end < 0) throw new Error('evaluator source not found');
const src = html.slice(start, end);
const { evaluate, catOf } = new Function(src + '\nreturn { evaluate, catOf };')();

// Small seeded PRNG (mulberry32) so runs are repeatable.
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const NAMES = ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
// Standard 5-card frequencies (royal flushes are counted inside straight flush).
const EXPECTED = [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40];

// 1) Exhaustive: every one of the C(52,5) = 2,598,960 five-card hands.
const counts = new Array(9).fill(0);
const distinct = new Set();
const hand = [0, 0, 0, 0, 0];
let total = 0;
const t0 = performance.now();
for (let a = 0; a < 48; a++) { hand[0] = a;
  for (let b = a + 1; b < 49; b++) { hand[1] = b;
    for (let c = b + 1; c < 50; c++) { hand[2] = c;
      for (let d = c + 1; d < 51; d++) { hand[3] = d;
        for (let e = d + 1; e < 52; e++) { hand[4] = e;
          counts[catOf(evaluate(hand))]++; total++; } } } } }
const t1 = performance.now();
// Untimed second pass: a correct evaluator yields exactly 7,462 distinct hand values.
for (let a = 0; a < 48; a++) for (let b = a + 1; b < 49; b++) for (let c = b + 1; c < 50; c++)
  for (let d = c + 1; d < 51; d++) for (let e = d + 1; e < 52; e++) distinct.add(evaluate([a, b, c, d, e]));
const exhaustiveMs = t1 - t0;
let ok = total === 2598960;
console.log('Exhaustive 5-card enumeration');
for (let i = 8; i >= 0; i--) {
  const good = counts[i] === EXPECTED[i]; ok = ok && good;
  console.log(`  ${NAMES[i].padEnd(16)} ${String(counts[i]).padStart(8)}  expected ${String(EXPECTED[i]).padStart(8)}  ${good ? 'OK' : 'MISMATCH'}`);
}
const distinctOk = distinct.size === 7462; ok = ok && distinctOk;
console.log(`  distinct hand values: ${distinct.size}  expected 7462  ${distinctOk ? 'OK' : 'MISMATCH'}`);
console.log(`  total hands: ${total}  time: ${exhaustiveMs.toFixed(0)} ms  => ${Math.round(total / (exhaustiveMs / 1000)).toLocaleString('en-US')} hands/sec`);

// 2) Random 7-card hands (the hold'em case), seeded. Deal outside the timed loop.
const N7 = 1_000_000;
const rng = mulberry32(12345);
const deals = new Uint8Array(N7 * 7);
const deck = Array.from({ length: 52 }, (_, i) => i);
for (let h = 0; h < N7; h++) {
  for (let i = 0; i < 7; i++) { const j = i + Math.floor(rng() * (52 - i)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; deals[h * 7 + i] = deck[i]; }
}
const seven = new Array(7);
let sink = 0;
// warm-up pass so the JIT has compiled evaluate() before timing
for (let h = 0; h < 50_000; h++) { for (let i = 0; i < 7; i++) seven[i] = deals[h * 7 + i]; sink += evaluate(seven) & 1; }
const t2 = performance.now();
for (let h = 0; h < N7; h++) { for (let i = 0; i < 7; i++) seven[i] = deals[h * 7 + i]; sink += evaluate(seven) & 1; }
const t3 = performance.now();
const sevenMs = t3 - t2;
console.log('Random 7-card hands (seed 12345)');
console.log(`  hands: ${N7.toLocaleString('en-US')}  time: ${sevenMs.toFixed(0)} ms  => ${Math.round(N7 / (sevenMs / 1000)).toLocaleString('en-US')} hands/sec  (sink ${sink})`);

console.log(ok ? 'RESULT: all category counts match' : 'RESULT: MISMATCH');
process.exit(ok ? 0 : 1);
