// Cards and poker hand evaluation.
// A card is an integer 0..51: rank = (c >> 2) + 2 (2..14, ace high), suit = c & 3.
import { u32, type Rng } from './rng';

export type Card = number;

export const RANKCH: Record<number, string> = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
export const LOGR: Record<number, string> = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
export const SUITS = ['♠︎', '♥︎', '♦︎', '♣︎'];
export const SUITCH = ['s', 'h', 'd', 'c'];
export const RNAME: Record<number, string> = { 1: 'Ace', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
export const PNAME = (r: number): string => (r === 6 ? 'Sixes' : RNAME[r] + 's');
export const cr = (c: Card): number => (c >> 2) + 2;
export const cs = (c: Card): number => c & 3;
export const cardTxt = (c: Card): string => LOGR[cr(c)]! + SUITCH[cs(c)]!;

/** Highest card of a straight in a rank bitmask (bit r set for rank r), or 0. Ace can be low. */
export function straightHigh(mask: number): number {
  let m = mask;
  if (m & (1 << 14)) m |= 2;
  for (let h = 14; h >= 5; h--) if (((m >> (h - 4)) & 31) === 31) return h;
  return 0;
}

/**
 * Pack a category (0 = high card .. 8 = straight flush) and up to five kickers into one
 * number: cat * 16^5 + k0 * 16^4 + ... + k4. Every kicker is <= 14 so it fits in 4 bits,
 * which makes a plain numeric comparison rank hands correctly.
 */
export function pack(cat: number, ks: readonly number[]): number {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 16 + (ks[i] || 0);
  return v;
}

/** Best 5-card poker value from any number (>= 5) of cards. Higher is better. */
export function evaluate(cards: readonly Card[]): number {
  const cnt = new Uint8Array(15), sc = [0, 0, 0, 0], sm = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    const r = (c >> 2) + 2, s = c & 3;
    cnt[r]!++;
    sc[s]!++;
    sm[s]! |= 1 << r;
    mask |= 1 << r;
  }
  let fs = -1;
  for (let s = 0; s < 4; s++) if (sc[s]! >= 5) fs = s;
  if (fs >= 0) {
    const h = straightHigh(sm[fs]!);
    if (h) return pack(8, [h]);
  }
  const quads: number[] = [], trips: number[] = [], pairs: number[] = [];
  for (let r = 14; r >= 2; r--) {
    const n = cnt[r];
    if (n === 4) quads.push(r);
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
  }
  const desc = (ex: number[]): number[] => {
    const a: number[] = [];
    for (let r = 14; r >= 2; r--) if (cnt[r] && !ex.includes(r)) a.push(r);
    return a;
  };
  if (quads.length) {
    const q = quads[0]!;
    return pack(7, [q, desc([q])[0] || 0]);
  }
  if (trips.length && (trips.length > 1 || pairs.length)) return pack(6, [trips[0]!, Math.max(trips[1] || 0, pairs[0] || 0)]);
  if (fs >= 0) {
    const f: number[] = [];
    for (let r = 14; r >= 2 && f.length < 5; r--) if (sm[fs]! & (1 << r)) f.push(r);
    return pack(5, f);
  }
  const st = straightHigh(mask);
  if (st) return pack(4, [st]);
  if (trips.length) {
    const t = trips[0]!;
    return pack(3, [t, ...desc([t]).slice(0, 2)]);
  }
  if (pairs.length >= 2) {
    const a = pairs[0]!, b = pairs[1]!;
    return pack(2, [a, b, desc([a, b])[0] || 0]);
  }
  if (pairs.length === 1) {
    const a = pairs[0]!;
    return pack(1, [a, ...desc([a]).slice(0, 3)]);
  }
  return pack(0, desc([]).slice(0, 5));
}

export const catOf = (v: number): number => Math.floor(v / 1048576);
export function kAt(v: number, i: number): number {
  return Math.floor(v / Math.pow(16, 4 - i)) % 16;
}

export function describe(v: number): string {
  const cat = catOf(v), k0 = kAt(v, 0), k1 = kAt(v, 1);
  switch (cat) {
    case 8: return k0 === 14 ? 'Royal Flush' : `Straight Flush, ${RNAME[k0]} high`;
    case 7: return `Four of a Kind, ${PNAME(k0)}`;
    case 6: return `Full House, ${PNAME(k0)} full of ${PNAME(k1)}`;
    case 5: return `Flush, ${RNAME[k0]} high`;
    case 4: return `Straight, ${RNAME[k0 - 4]} to ${RNAME[k0]}`;
    case 3: return `Three of a Kind, ${PNAME(k0)}`;
    case 2: return `Two Pair, ${PNAME(k0)} and ${PNAME(k1)}`;
    case 1: return `Pair of ${PNAME(k0)}`;
    default: return `High Card, ${RNAME[k0]}`;
  }
}

export function holeName(a: Card, b: Card): string {
  let r1 = cr(a), r2 = cr(b);
  if (r1 < r2) [r1, r2] = [r2, r1];
  if (r1 === r2) return 'Pair of ' + PNAME(r1);
  return `${RNAME[r1]}-${RNAME[r2]}, ${cs(a) === cs(b) ? 'same suit' : 'different suits'}`;
}

export function holeClass(a: Card, b: Card): string {
  let r1 = cr(a), r2 = cr(b);
  if (r1 < r2) [r1, r2] = [r2, r1];
  return LOGR[r1]! + LOGR[r2]! + (r1 === r2 ? '' : cs(a) === cs(b) ? 's' : 'o');
}

/** The five cards that make the best hand (first match in combination order). */
export function bestFive(cards: readonly Card[]): Card[] {
  const target = evaluate(cards), n = cards.length;
  let found: Card[] | null = null;
  const go = (start: number, acc: Card[]): void => {
    if (found) return;
    if (acc.length === 5) {
      if (evaluate(acc) === target) found = acc.slice();
      return;
    }
    for (let i = start; i < n; i++) {
      acc.push(cards[i]!);
      go(i + 1, acc);
      acc.pop();
    }
  };
  go(0, []);
  return found || cards.slice(0, 5);
}

/** Fisher-Yates shuffle of a fresh deck, as in the original (32-bit values, `% (i + 1)`). */
export function shuffled(rand: Rng): Card[] {
  const d = Array.from({ length: 52 }, (_, i) => i), r = new Uint32Array(52);
  for (let i = 0; i < 52; i++) r[i] = u32(rand);
  for (let i = 51; i > 0; i--) {
    const j = r[i]! % (i + 1);
    const t = d[i]!;
    d[i] = d[j]!;
    d[j] = t;
  }
  return d;
}

/** n distinct random cards avoiding `dead`. */
export function randCards(rand: Rng, n: number, dead?: Set<Card>): Card[] {
  const out: Card[] = [];
  while (out.length < n) {
    const c = (rand() * 52) | 0;
    if (!out.includes(c) && !(dead && dead.has(c))) out.push(c);
  }
  return out;
}
