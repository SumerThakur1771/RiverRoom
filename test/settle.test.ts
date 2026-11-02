// Settlement: every balance gets settled exactly, with the fewest transfers possible.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { balancesFrom, greedy, HOUSE, settle, type Balance, type Transfer } from '../src/ledger/settle';

const apply = (bal: readonly Balance[], ts: readonly Transfer[]): Map<string, number> => {
  const m = new Map(bal.map(b => [b.name, b.net]));
  for (const t of ts) { m.set(t.from, m.get(t.from)! + t.amount); m.set(t.to, m.get(t.to)! - t.amount); }
  return m;
};
/** Fewest transfers by brute force: n - (most zero-sum groups), over every set partition. */
function bruteMin(nets: number[]): number {
  const xs = nets.filter(x => x !== 0);
  let bestGroups = 0;
  const go = (i: number, groups: number[]): void => {
    if (i === xs.length) { if (groups.every(g => g === 0)) bestGroups = Math.max(bestGroups, groups.length); return; }
    for (let k = 0; k < groups.length; k++) { groups[k]! += xs[i]!; go(i + 1, groups); groups[k]! -= xs[i]!; }
    groups.push(xs[i]!); go(i + 1, groups); groups.pop();
  };
  go(0, []);
  return xs.length - bestGroups;
}
/** Random balances that add up to zero, in 10-cent steps like the home game. */
const zeroSum = (min: number, max: number) => fc.array(fc.integer({ min: -100, max: 100 }), { minLength: min - 1, maxLength: max - 1 })
  .map(xs => [...xs, -xs.reduce((a, b) => a + b, 0)].map((x, i) => ({ name: 'P' + i, net: x * 10 })));

describe('settle', () => {
  it('a simple night: two losers pay one winner', () => {
    expect(settle([{ name: 'Ana', net: 1500 }, { name: 'Ben', net: -1000 }, { name: 'Cy', net: -500 }])).toEqual([
      { from: 'Ben', to: 'Ana', amount: 1000 }, { from: 'Cy', to: 'Ana', amount: 500 },
    ]);
  });
  it('finds pairs that cancel out, where the greedy method would use more transfers', () => {
    // greedy: 4 transfers; best: (A,-7 B,+7) and (C,-5 D,-3 E,+8) = 1 + 2 = 3 transfers
    const bal = [{ name: 'A', net: -7 }, { name: 'B', net: 7 }, { name: 'C', net: -5 }, { name: 'D', net: -3 }, { name: 'E', net: 8 }].map(b => ({ ...b, net: b.net * 100 }));
    expect(settle(bal)).toHaveLength(3);
    expect([...apply(bal, settle(bal)).values()].every(v => v === 0)).toBe(true);
  });
  it('rejects balances that do not add up to zero', () => {
    expect(() => settle([{ name: 'A', net: 10 }])).toThrow();
  });
  it('always settles everyone exactly, with positive amounts, in the fewest transfers (vs brute force)', () => {
    fc.assert(fc.property(zeroSum(1, 8), bal => {
      const ts = settle(bal);
      expect([...apply(bal, ts).values()].every(v => v === 0)).toBe(true);
      expect(ts.every(t => t.amount > 0 && t.from !== t.to)).toBe(true);
      expect(ts.length).toBe(bruteMin(bal.map(b => b.net)));
      expect(ts.length).toBeLessThanOrEqual(greedy(bal).length);
    }), { numRuns: 400 });
  });
});

describe('balances from the ledger', () => {
  it('buy-ins, rebuys, cash-outs and chips still on the table; winnings from the computer players show as their loss', () => {
    const bal = balancesFrom([
      { name: 'Ana', buyins: 2000, cashouts: 0, onTable: 3500 }, // rebought once, now has $35
      { name: 'Ben', buyins: 1000, cashouts: 400, onTable: 0 }, // left with $4
      { name: 'Cy', buyins: 1000, cashouts: 0, onTable: 600 },
    ]);
    expect(bal).toEqual([{ name: 'Ana', net: 1500 }, { name: 'Ben', net: -600 }, { name: 'Cy', net: -400 }, { name: HOUSE, net: -500 }]);
    const ts = settle(bal);
    expect(ts).toHaveLength(3);
    expect(ts.every(t => t.to === 'Ana')).toBe(true);
    expect([...apply(bal, ts).values()].every(v => v === 0)).toBe(true);
  });
  it('someone who left and came back as the same player is one line, never paying themselves', () => {
    const b = balancesFrom([
      { name: 'Ann', buyins: 1000, cashouts: 0, onTable: 0 },
      { name: 'Ann', buyins: 1000, cashouts: 0, onTable: 2500 },
      { name: 'Bo', buyins: 1000, cashouts: 500, onTable: 0 },
    ]);
    expect(b.filter(x => x.name === 'Ann')).toEqual([{ name: 'Ann', net: 500 }]);
    expect(settle(b).some(t => t.from === t.to)).toBe(false);
  });
});
