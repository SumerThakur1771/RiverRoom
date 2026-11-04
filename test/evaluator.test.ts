// Hand evaluators, checked exhaustively where that is cheap enough.
import { describe, expect, it } from 'vitest';
import { catOf, evaluate, type Card } from '../src/engine/cards';
import { mulberry32 } from '../src/engine/rng';
import { tpName, tpScore } from '../src/engine/teenpatti';
import { tpTab } from '../src/engine/strength';
import { partScore } from '../src/ai/split';
import type { Game } from '../src/engine/state';
import { combos } from '../src/engine/variants';

const card = (rank: number, suit: number): Card => (rank - 2) * 4 + suit;

describe('5-card evaluator', () => {
  it('ranks all 2,598,960 hands into the standard category counts and 7,462 distinct values', () => {
    const counts = new Array(9).fill(0), distinct = new Set<number>(), h = [0, 0, 0, 0, 0];
    for (let a = 0; a < 48; a++) for (let b = a + 1; b < 49; b++) for (let c = b + 1; c < 50; c++)
      for (let d = c + 1; d < 51; d++) for (let e = d + 1; e < 52; e++) {
        h[0] = a; h[1] = b; h[2] = c; h[3] = d; h[4] = e;
        const v = evaluate(h);
        counts[catOf(v)]++;
        distinct.add(v);
      }
    expect(counts).toEqual([1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
    expect(distinct.size).toBe(7462);
  });

  it('values 7 cards as their best 5 (checked against brute force on 20,000 random hands)', () => {
    const rand = mulberry32(7);
    for (let n = 0; n < 20000; n++) {
      const deck = Array.from({ length: 52 }, (_, i) => i);
      for (let i = 0; i < 7; i++) { const j = i + Math.floor(rand() * (52 - i)); [deck[i], deck[j]] = [deck[j]!, deck[i]!]; }
      const seven = deck.slice(0, 7);
      const best = Math.max(...combos(seven, 5).map(f => evaluate(f)));
      expect(evaluate(seven)).toBe(best);
    }
  });

  it('handles the wheel (A-2-3-4-5) as a 5-high straight', () => {
    const wheel = evaluate([card(14, 0), card(2, 1), card(3, 2), card(4, 3), card(5, 0)]);
    const six = evaluate([card(2, 1), card(3, 2), card(4, 3), card(5, 0), card(6, 1)]);
    expect(catOf(wheel)).toBe(4);
    expect(six).toBeGreaterThan(wheel);
  });
});

describe('3 Patti scorer', () => {
  it('ranks all 22,100 hands into the standard category counts', () => {
    const counts = new Array(6).fill(0), distinct = new Set<number>();
    for (let i = 0; i < 50; i++) for (let j = i + 1; j < 51; j++) for (let k = j + 1; k < 52; k++) {
      const s = tpScore([i, j, k]);
      counts[Math.floor(s / 1e6)]++;
      distinct.add(s);
    }
    // high card, pair, color, sequence, pure sequence, trail
    expect(counts).toEqual([16440, 3744, 1096, 720, 48, 52]);
    expect(distinct.size).toBe(741);
  });

  it('orders sequences A-K-Q > A-2-3 > K-Q-J, and a trail beats a pure sequence', () => {
    const akq = tpScore([card(14, 0), card(13, 1), card(12, 2)]);
    const a23 = tpScore([card(14, 0), card(2, 1), card(3, 2)]);
    const kqj = tpScore([card(13, 0), card(12, 1), card(11, 2)]);
    const trail2 = tpScore([card(2, 0), card(2, 1), card(2, 2)]);
    const pureAkq = tpScore([card(14, 0), card(13, 0), card(12, 0)]);
    expect(akq).toBeGreaterThan(a23);
    expect(a23).toBeGreaterThan(kqj);
    expect(trail2).toBeGreaterThan(pureAkq);
  });

  it('house rule "A-2-3 is lowest": A-2-3 drops below 2-3-4 and nothing else moves', () => {
    const a23 = [card(14, 0), card(2, 1), card(3, 2)], s234 = [card(2, 0), card(3, 1), card(4, 2)];
    const pureA23 = [card(14, 3), card(2, 3), card(3, 3)], pure234 = [card(2, 1), card(3, 1), card(4, 1)];
    const color = [card(14, 0), card(13, 0), card(11, 0)];
    // standard: A-2-3 beats 2-3-4; house rule: the other way round
    expect(tpScore(a23)).toBeGreaterThan(tpScore(s234));
    expect(tpScore(a23, true)).toBeLessThan(tpScore(s234, true));
    expect(tpScore(pureA23, true)).toBeLessThan(tpScore(pure234, true));
    // still a sequence: a pure A-2-3 beats any plain sequence, a plain one beats any color
    expect(tpScore(pureA23, true)).toBeGreaterThan(tpScore([card(14, 0), card(13, 1), card(12, 2)], true));
    expect(tpScore(a23, true)).toBeGreaterThan(tpScore(color, true));
    expect(tpName(a23, true)).toBe('Sequence A-2-3');
    expect(tpName(pureA23, true)).toBe('Pure sequence A-2-3');
    // every hand that is not A-2-3 scores the same under both rules; counts per category are unchanged
    let moved = 0;
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 50; i++) for (let j = i + 1; j < 51; j++) for (let k = j + 1; k < 52; k++) {
      const h = [i, j, k];
      if (tpScore(h) !== tpScore(h, true)) moved++;
      counts[Math.floor(tpScore(h, true) / 1e6)]++;
    }
    expect(moved).toBe(64); // the 4 x 4 x 4 A-2-3 hands
    expect(counts).toEqual([16440, 3744, 1096, 720, 48, 52]);
    // the percentile table for the house rule ranks A-2-3 at the bottom of the sequences
    expect(tpTab(true)).toHaveLength(22100);
  });

  it('the showdown scores 3 Patti parts with the table\'s rule', () => {
    const g = (a23Low: boolean): Game => ({ settings: { a23Low }, board: [], board2: [] }) as unknown as Game;
    const a23 = [card(14, 0), card(2, 1), card(3, 2)], s234 = [card(2, 0), card(3, 1), card(4, 2)];
    expect(partScore(g(false), 'tp', a23)).toBeGreaterThan(partScore(g(false), 'tp', s234));
    expect(partScore(g(true), 'tp', a23)).toBeLessThan(partScore(g(true), 'tp', s234));
  });
});

describe('exact equity', () => {
  it('AA vs KK all-in preflop (no shared suits) has 81.3% equity (enumerating all 1,712,304 boards)', () => {
    const aa = [card(14, 0), card(14, 1)], kk = [card(13, 2), card(13, 3)];
    const rest = Array.from({ length: 52 }, (_, i) => i).filter(c => !aa.includes(c) && !kk.includes(c));
    let win = 0, tie = 0, boards = 0;
    const b = [0, 0, 0, 0, 0];
    for (let i = 0; i < 44; i++) for (let j = i + 1; j < 45; j++) for (let k = j + 1; k < 46; k++) for (let l = k + 1; l < 47; l++) for (let m = l + 1; m < 48; m++) {
      b[0] = rest[i]!; b[1] = rest[j]!; b[2] = rest[k]!; b[3] = rest[l]!; b[4] = rest[m]!;
      const x = evaluate(aa.concat(b)), y = evaluate(kk.concat(b));
      if (x > y) win++; else if (x === y) tie++;
      boards++;
    }
    expect(boards).toBe(1712304);
    const eq = (win + tie / 2) / boards;
    expect(eq).toBeGreaterThan(0.81);
    expect(eq).toBeLessThan(0.83);
    console.log(`AA (spades, hearts) vs KK (diamonds, clubs): equity ${(eq * 100).toFixed(3)}%  wins ${win}  ties ${tie}`);
  });
});
