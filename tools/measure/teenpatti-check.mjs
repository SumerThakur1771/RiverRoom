// Exhaustive check of the 3 Patti scorer (tpScore) from legacy/river-room.html:
// all C(52,3) = 22,100 three-card hands, counted per category against the standard frequencies.
// Usage: node tools/measure/teenpatti-check.mjs
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../legacy/river-room.html', import.meta.url), 'utf8');
const a = html.indexOf('const cr = c =>'), b = html.indexOf('const cardTxt');
const c = html.indexOf('function tpScore('), d = html.indexOf('function tpName(');
const { tpScore } = new Function(html.slice(a, b) + html.slice(c, d) + '\nreturn { tpScore };')();
const NAMES = ['High card', 'Pair', 'Color', 'Sequence', 'Pure sequence', 'Trail'];
const EXPECTED = [16440, 3744, 1096, 720, 48, 52];
const counts = new Array(6).fill(0), distinct = new Set(); let total = 0;
for (let i = 0; i < 50; i++) for (let j = i + 1; j < 51; j++) for (let k = j + 1; k < 52; k++) {
  const s = tpScore([i, j, k]); counts[Math.floor(s / 1e6)]++; distinct.add(s); total++;
}
let ok = total === 22100;
for (let i = 5; i >= 0; i--) { const g = counts[i] === EXPECTED[i]; ok &&= g; console.log(`  ${NAMES[i].padEnd(14)} ${String(counts[i]).padStart(6)}  expected ${String(EXPECTED[i]).padStart(6)}  ${g ? 'OK' : 'MISMATCH'}`); }
// Order spot checks: A-K-Q > A-2-3 > K-Q-J sequence; trail beats pure sequence.
const card = (r, s) => (r - 2) * 4 + s;
const AKQ = tpScore([card(14, 0), card(13, 1), card(12, 2)]), A23 = tpScore([card(14, 0), card(2, 1), card(3, 2)]), KQJ = tpScore([card(13, 0), card(12, 1), card(11, 2)]);
const order = AKQ > A23 && A23 > KQJ; ok &&= order;
console.log(`  sequence order A-K-Q > A-2-3 > K-Q-J: ${order ? 'OK' : 'WRONG'}`);
console.log(`  hands: ${total}, distinct scores: ${distinct.size}`);
console.log(ok ? 'RESULT: all 3 Patti checks pass' : 'RESULT: MISMATCH');
process.exit(ok ? 0 : 1);
