// Ranges and equity: how bots and the coach estimate their chances.
// Monte Carlo: sample opponents' hands from what their actions say (a "range model"),
// deal out the board, and count wins. Ported line by line from the original so that, with
// the same random stream, every estimate comes out bit-for-bit identical.
import { catOf, cr, cs, describe, evaluate, kAt, straightHigh, type Card } from '../engine/cards';
import type { Rng } from '../engine/rng';
import { handPct } from '../engine/strength';

export interface RangeModel { top: number; low: number; agg: number; raised: boolean; calls: number; big: number; bluff: number; tight: boolean }
export interface DrawInfo { fd: boolean; sd: 'oesd' | 'gut' | null }
export interface MadeInfo { v: number; cat: number; bcat: number; improves: boolean; topPair: boolean; name: string }

export const CATN = ['high card', 'a pair', 'two pair', 'three of a kind', 'a straight', 'a flush', 'a full house', 'four of a kind', 'a straight flush'];

export function drawInfo(hole: readonly Card[], board: readonly Card[]): DrawInfo {
  const res: DrawInfo = { fd: false, sd: null };
  if (board.length < 3 || board.length >= 5) return res;
  const all = hole.concat(board);
  for (let s = 0; s < 4; s++) {
    const n = all.filter(c => cs(c) === s).length;
    if (n === 4 && hole.some(c => cs(c) === s)) res.fd = true;
  }
  let m = 0;
  for (const c of all) m |= 1 << cr(c);
  if (straightHigh(m)) return res;
  const hr = hole.map(cr);
  let outs = 0;
  for (let r = 2; r <= 14; r++) {
    if (m & (1 << r)) continue;
    const h = straightHigh(m | (1 << r));
    if (!h) continue;
    const win: number[] = [];
    for (let x = h - 4; x <= h; x++) win.push(x === 1 ? 14 : x);
    if (hr.some(x => win.includes(x))) outs++;
  }
  res.sd = outs >= 2 ? 'oesd' : outs === 1 ? 'gut' : null;
  return res;
}

export function madeInfo(hole: readonly Card[], board: readonly Card[]): MadeInfo {
  const v = evaluate(hole.concat(board)), cat = catOf(v);
  const bcat = board.length ? catOf(evaluate(board)) : 0;
  const maxB = Math.max(0, ...board.map(cr));
  const pairR = cat === 1 ? kAt(v, 0) : 0;
  const topPair = cat === 1 && cat > bcat && pairR >= maxB;
  return { v, cat, bcat, improves: cat > bcat, topPair, name: describe(v) };
}

/** Draw a plausible 2-card hand for an opponent, given what their actions say about it. */
export function sampleFrom(rand: Rng, m: RangeModel, deck: readonly Card[], used: Set<Card>, board: readonly Card[], bcat: number): [Card, Card] {
  const n = deck.length;
  // decide once whether this is one of their rare bluffs, so weak hands do not slip in through repeated tries
  const tightBluff = m.tight && rand() < m.bluff * 0.4 + 0.03;
  for (let t = 0; t < 70; t++) {
    const a = deck[(rand() * n) | 0]!, b = deck[(rand() * n) | 0]!;
    if (a === b || used.has(a) || used.has(b)) continue;
    if (t < 55) {
      const p = handPct(a, b);
      if (p > m.top || p < m.low) continue;
      if (board.length >= 3) {
        const h = [a, b];
        if (m.tight && m.big >= 1 && m.agg >= 2) {
          if (!tightBluff) {
            const mi = madeInfo(h, board);
            if (!(mi.cat >= 2 && mi.improves)) continue;
          }
        } else if (m.agg >= 3 || m.big >= 1) {
          if (rand() > m.bluff * 0.4) {
            const mi = madeInfo(h, board);
            const maxB = Math.max(...board.map(cr));
            if (!((mi.cat >= 2 && mi.improves) || (mi.topPair && Math.max(cr(a), cr(b)) >= 10) || (mi.cat === 1 && mi.improves && kAt(mi.v, 0) > maxB))) continue;
          }
        } else if (m.raised || m.agg >= 2) {
          if (rand() > m.bluff * 0.5) {
            const mi = madeInfo(h, board);
            const d = drawInfo(h, board);
            if (!((mi.cat >= 2 && mi.improves) || mi.topPair || (mi.cat === 1 && mi.improves && kAt(mi.v, 0) > Math.max(...board.map(cr))) || (d.fd && d.sd))) continue;
          }
        } else if (m.agg === 1) {
          if (rand() > m.bluff) {
            const v = catOf(evaluate(h.concat(board)));
            if (!(v > bcat)) {
              const d = drawInfo(h, board);
              if (!d.fd && d.sd !== 'oesd') continue;
            }
          }
        } else if (m.calls >= 1) {
          if (rand() < 0.7) {
            const v = catOf(evaluate(h.concat(board)));
            if (!(v > bcat)) {
              const d = drawInfo(h, board);
              const maxB = Math.max(...board.map(cr));
              if (!d.fd && !d.sd && !(cr(a) > maxB && cr(b) > maxB)) continue;
            }
          }
        }
      }
    }
    return [a, b];
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (!used.has(deck[i]!) && !used.has(deck[j]!)) return [deck[i]!, deck[j]!];
  return [deck[0]!, deck[1]!];
}

/** Hold'em equity of `hole` against opponents drawn from their range models. */
export function equityVs(rand: Rng, hole: readonly Card[], board: readonly Card[], models: readonly RangeModel[], iters: number, dead?: readonly Card[]): number {
  if (!models.length) return 1;
  const known = new Set(hole.concat(board, dead || [])), deck: Card[] = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  const bcat = board.length >= 3 ? catOf(evaluate(board)) : 0;
  let score = 0;
  for (let it = 0; it < iters; it++) {
    const used = new Set<Card>(), hands: Card[][] = [];
    for (const m of models) {
      const h = sampleFrom(rand, m, deck, used, board, bcat);
      used.add(h[0]);
      used.add(h[1]);
      hands.push(h);
    }
    const fb = board.slice();
    while (fb.length < 5) {
      const c = deck[(rand() * deck.length) | 0]!;
      if (!used.has(c)) {
        used.add(c);
        fb.push(c);
      }
    }
    const my = evaluate(hole.concat(fb));
    let ties = 0, lose = false;
    for (const h of hands) {
      const v = evaluate(h.concat(fb));
      if (v > my) {
        lose = true;
        break;
      }
      if (v === my) ties++;
    }
    if (!lose) score += 1 / (ties + 1);
  }
  return score / iters;
}

/** Split games: each opponent holds N cards and can use any 2 of them for the poker part. */
export function bestPair(cards: readonly Card[], board: readonly Card[]): { v: number; h: Card[] | null } {
  let v = -1, h: Card[] | null = null;
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++) {
      const x = evaluate([cards[i]!, cards[j]!].concat(board));
      if (x > v) {
        v = x;
        h = [cards[i]!, cards[j]!];
      }
    }
  return { v, h };
}

export function sampleMulti(rand: Rng, m: RangeModel, deck: readonly Card[], used: Set<Card>, board: readonly Card[], N: number): Card[] {
  let hand: Card[] = [];
  const tightBluff = m.tight && rand() < m.bluff * 0.4 + 0.03;
  for (let t = 0; t < 25; t++) {
    hand = [];
    let g = 0;
    while (hand.length < N && g++ < 400) {
      const c = deck[(rand() * deck.length) | 0]!;
      if (!used.has(c) && !hand.includes(c)) hand.push(c);
    }
    if (t >= 20 || board.length < 3) return hand;
    // what they did tells you something about their best poker cards
    const h = bestPair(hand, board).h!, mi = madeInfo(h, board), d = drawInfo(h, board), maxB = Math.max(...board.map(cr));
    const good = (mi.cat >= 2 && mi.improves) || mi.topPair || (mi.cat === 1 && mi.improves && kAt(mi.v, 0) > maxB);
    if (m.tight && m.big >= 1 && m.agg >= 2) {
      if (!tightBluff && !(mi.cat >= 2 && mi.improves)) continue;
    } else if (m.agg >= 3 || m.big >= 1) {
      if (rand() > m.bluff * 0.4 && !((mi.cat >= 2 && mi.improves) || (mi.topPair && Math.max(...h.map(cr)) >= 10))) continue;
    } else if (m.raised || m.agg >= 2) {
      if (rand() > m.bluff * 0.5 && !(good || (d.fd && d.sd))) continue;
    } else if (m.agg === 1) {
      if (rand() > m.bluff && !(mi.improves || d.fd || d.sd === 'oesd')) continue;
    } else if (m.calls >= 1) {
      if (rand() < 0.6 && !(mi.improves || d.fd || d.sd)) continue;
    }
    return hand;
  }
  return hand;
}

export type Threat = { behind: number; top: Array<[string, number]> } | null;

/** Poker-part equity in split games after the flop: opponents hold N cards each. */
export function equityVsMulti(rand: Rng, hold: readonly Card[], board: readonly Card[], models: readonly RangeModel[], iters: number, dead: readonly Card[], N: number): { eq: number; threat: Threat } {
  if (!models.length) return { eq: 1, threat: null };
  const known = new Set(hold.concat(board, dead || [])), deck: Card[] = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  const myNow = evaluate(hold.concat(board)), beat: Record<string, number> = {};
  let score = 0, behind = 0;
  for (let it = 0; it < iters; it++) {
    const used = new Set<Card>(), hands: Card[][] = [];
    for (const m of models) {
      const h = sampleMulti(rand, m, deck, used, board, N);
      h.forEach(c => used.add(c));
      hands.push(h);
    }
    let top = -1;
    for (const h of hands) {
      const v = bestPair(h, board).v;
      if (v > top) top = v;
    }
    if (top > myNow) {
      behind++;
      const k = CATN[catOf(top)]!;
      beat[k] = (beat[k] || 0) + 1;
    }
    const fb = board.slice();
    while (fb.length < 5) {
      const c = deck[(rand() * deck.length) | 0]!;
      if (!used.has(c)) {
        used.add(c);
        fb.push(c);
      }
    }
    const my = evaluate(hold.concat(fb));
    let ties = 0, lose = false;
    for (const h of hands) {
      const v = bestPair(h, fb).v;
      if (v > my) {
        lose = true;
        break;
      }
      if (v === my) ties++;
    }
    if (!lose) score += 1 / (ties + 1);
  }
  const threat: Threat = { behind: behind / iters, top: Object.entries(beat).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => [k, n / iters] as [string, number]) };
  return { eq: score / iters, threat };
}

/** Exact or sampled equity of known hands (all-in with cards face up). */
export function equityKnown(rand: Rng, hands: readonly Card[][], board: readonly Card[], iters: number): number[] {
  const dead = new Set(board.concat(...hands)), deck: Card[] = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) deck.push(c);
  const need = 5 - board.length, res = hands.map(() => 0);
  const score = (fb: Card[]): void => {
    const vals = hands.map(h => evaluate(h.concat(fb))), best = Math.max(...vals), w = vals.filter(v => v === best).length;
    vals.forEach((v, i) => {
      if (v === best) res[i]! += 1 / w;
    });
  };
  if (need === 0) {
    score(board.slice());
    return res;
  }
  if (need === 1) {
    for (const c of deck) score(board.concat([c]));
    return res.map(x => x / deck.length);
  }
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rand() * (deck.length - i));
      const t = deck[i]!;
      deck[i] = deck[j]!;
      deck[j] = t;
    }
    score(board.concat(deck.slice(0, need)));
  }
  return res.map(x => x / iters);
}
