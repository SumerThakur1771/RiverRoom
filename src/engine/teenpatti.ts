// 3 Patti (Teen Patti) three-card hand ranking.
// Trail > Pure sequence > Sequence > Color > Pair > High card. A-K-Q is the top sequence, then A-2-3.
import { cr, cs, PNAME, RANKCH, RNAME, type Card } from './cards';

export function tpScore(h: readonly Card[]): number {
  const r = h.map(cr).sort((a, b) => b - a) as [number, number, number];
  const suited = cs(h[0]!) === cs(h[1]!) && cs(h[1]!) === cs(h[2]!);
  if (r[0] === r[2]) return 5e6 + r[0] * 1e4;
  let seq = 0;
  if (r[0] === 14 && r[1] === 13 && r[2] === 12) seq = 16;
  else if (r[0] === 14 && r[1] === 3 && r[2] === 2) seq = 15;
  else if (r[0] - 1 === r[1] && r[1] - 1 === r[2]) seq = r[0];
  if (seq) return (suited ? 4e6 : 3e6) + seq * 1e4;
  if (suited) return 2e6 + r[0] * 1e4 + r[1] * 100 + r[2];
  if (r[0] === r[1]) return 1e6 + r[0] * 1e4 + r[2];
  if (r[1] === r[2]) return 1e6 + r[1] * 1e4 + r[0];
  return r[0] * 1e4 + r[1] * 100 + r[2];
}

export function tpName(h: readonly Card[]): string {
  const s = tpScore(h), cat = Math.floor(s / 1e6), k = Math.floor(s / 1e4) % 100;
  if (cat === 5) return 'Trail of ' + PNAME(k);
  if (cat >= 3) {
    const run = k === 16 ? 'A-K-Q' : k === 15 ? 'A-2-3' : `${RANKCH[k]}-${RANKCH[k - 1]}-${RANKCH[k - 2]}`;
    return (cat === 4 ? 'Pure sequence ' : 'Sequence ') + run;
  }
  if (cat === 2) return `Color, ${RNAME[k]} high`;
  if (cat === 1) return 'Pair of ' + PNAME(k);
  return `High card, ${RNAME[k]}`;
}
