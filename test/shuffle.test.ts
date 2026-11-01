// The live deck shuffle is exactly uniform: Fisher-Yates driven by rejection sampling on
// crypto random values. Seeded games keep the original shuffle (golden replay depends on it).
import { describe, expect, it } from 'vitest';
import { shuffled, shuffledUniform } from '../src/engine/cards';
import { cryptoUint32, Streams, uniformInt } from '../src/engine/rng';

/** Chi-square statistic of observed counts against a uniform expectation. */
const chiSquare = (counts: number[]): number => {
  const total = counts.reduce((a, b) => a + b, 0), e = total / counts.length;
  return counts.reduce((a, c) => a + (c - e) ** 2 / e, 0);
};
// 51 degrees of freedom: the statistic exceeds 114.5 with probability about 1e-6 for a truly
// uniform source (Wilson-Hilferty approximation), so these checks essentially never flake.
const CHI2_51_P1E6 = 114.5;

describe('uniformInt (rejection sampling)', () => {
  it('maps the accepted inputs onto every result equally often, for every n up to 52 (exhaustive, 8-bit source)', () => {
    const range = 256;
    for (let n = 1; n <= 52; n++) {
      const counts = new Array<number>(n).fill(0);
      let rejected = 0;
      for (let x = 0; x < range; x++) {
        // feed x first; if x is rejected the sampler asks again (and gets 0)
        let calls = 0;
        const r = uniformInt(n, () => (calls++ === 0 ? x : 0), range);
        if (calls > 1) rejected++; else counts[r]!++;
      }
      expect(new Set(counts).size).toBe(1); // every result had the same number of inputs
      expect(counts[0]).toBe(Math.floor(range / n));
      expect(rejected).toBe(range % n);
    }
  });

  it('rejects exactly the top range % n inputs and draws again', () => {
    const range = 256, n = 52; // 256 % 52 = 48 inputs (208..255) must be rejected
    let rejectedInputs = 0;
    for (let x = 0; x < range; x++) {
      const seq = [x, 7];
      let calls = 0;
      const r = uniformInt(n, () => seq[calls++]!, range);
      if (calls === 2) { rejectedInputs++; expect(r).toBe(7); } else expect(r).toBe(x % n);
    }
    expect(rejectedInputs).toBe(range % n);
    expect(rejectedInputs).toBe(48);
  });

  it('with a 32-bit source every deck size has an exact multiple of n accepted inputs', () => {
    for (let n = 1; n <= 52; n++) {
      const limit = 2 ** 32 - (2 ** 32 % n);
      expect(limit % n).toBe(0);
      expect((2 ** 32 - limit) / 2 ** 32).toBeLessThan(52 / 2 ** 32); // rejection is vanishingly rare
    }
  });

  it('the old `% n` method is biased (why this change): with an 8-bit source and n = 52, 48 results get 5 inputs and 4 get 4', () => {
    const counts = new Array<number>(52).fill(0);
    for (let x = 0; x < 256; x++) counts[x % 52]!++;
    expect(counts.filter(c => c === 5)).toHaveLength(48);
    expect(counts.filter(c => c === 4)).toHaveLength(4);
  });

  it('rejects bad n', () => {
    expect(() => uniformInt(0, cryptoUint32)).toThrow();
    expect(() => uniformInt(2.5, cryptoUint32)).toThrow();
  });

  it('crypto draws are uniform over 52 values (chi-square, 208,000 draws)', () => {
    const counts = new Array<number>(52).fill(0);
    for (let i = 0; i < 208_000; i++) counts[uniformInt(52, cryptoUint32)]!++;
    expect(chiSquare(counts)).toBeLessThan(CHI2_51_P1E6);
  });
});

describe('live deck shuffle', () => {
  it('live play uses the uniform shuffle; seeded play keeps the original one', () => {
    expect(new Streams(null).deckInt).not.toBeNull();
    expect(new Streams('any seed').deckInt).toBeNull();
  });

  it('Fisher-Yates asks for one uniform integer per position, from 52 down to 2, and returns a permutation', () => {
    const asked: number[] = [];
    const deck = shuffledUniform(n => { asked.push(n); return n - 1; });
    expect(asked).toEqual(Array.from({ length: 51 }, (_, i) => 52 - i));
    expect([...deck].sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i));
  });

  it('the live deck draws only from the crypto source, through rejection sampling', () => {
    let calls = 0;
    const counting = (): number => { calls++; return cryptoUint32(); };
    const rs = new Streams(null, Math.random, counting);
    const deck = rs.seg('h1:deck', () => shuffledUniform(rs.deckInt!));
    expect(new Set(deck).size).toBe(52);
    expect(calls).toBeGreaterThanOrEqual(51); // 51 draws, plus any (rare) rejected ones
  });

  it('every card is equally likely in the top position (chi-square, 52,000 live shuffles)', () => {
    const rs = new Streams(null);
    const top = new Array<number>(52).fill(0), bottom = new Array<number>(52).fill(0);
    for (let i = 0; i < 52_000; i++) {
      const d = shuffledUniform(rs.deckInt!);
      top[d[0]!]!++;
      bottom[d[51]!]!++;
    }
    expect(chiSquare(top)).toBeLessThan(CHI2_51_P1E6);
    expect(chiSquare(bottom)).toBeLessThan(CHI2_51_P1E6);
  });

  it('seeded decks are reproducible: the same seed deals the same deck', () => {
    const deal = (seed: string): number[] => { const rs = new Streams(seed); return rs.seg('h1:deck', () => shuffled(rs.rand)); };
    expect(deal('golden')).toEqual(deal('golden'));
    expect(deal('golden')).not.toEqual(deal('other'));
  });
});
