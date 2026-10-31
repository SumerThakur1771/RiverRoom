// Property tests: random tables and random (legal or illegal) actions must never break the
// chip accounting, and side pots must always be built correctly.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildPots, newGame, options, type Action } from '../src/engine/engine';
import { runSession, scriptedHero } from '../src/sim/driver';
import type { VariantKey } from '../src/engine/variants';
import { play, table } from './helpers';

describe('chip accounting (random hands)', () => {
  it('conserves chips, never goes negative, and pays every chip out', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 3000 }), { minLength: 2, maxLength: 6 }), // stacks
        fc.array(fc.nat(), { minLength: 1, maxLength: 200 }), // choices, used in a cycle
        fc.integer({ min: 0, max: 40 }), // hands already played (sets the blind level)
        (stacks, choices, handNo) => {
          const g = table(stacks, { seed: 'prop' });
          g.handNo = handNo;
          const before = g.players.reduce((a, p) => a + p.stack, 0);
          let k = 0;
          play(g, (s, gg): Action => {
            const c = choices[k++ % choices.length]!, o = options(gg, s.p);
            switch (c % 6) {
              case 0: return { type: 'fold' };
              case 1: return { type: 'check' };
              case 2: return { type: 'call' };
              case 3: return { type: 'raise', to: o.minTo };
              case 4: return { type: 'raise', to: o.maxTo };
              default: return { type: 'raise', to: (c % 997) + 1 }; // often illegal: the engine must fix it
            }
          });
          const after = g.players.reduce((a, p) => a + p.stack, 0);
          expect(after).toBe(before);
          expect(g.players.every(p => p.stack >= 0)).toBe(true);
          expect(g.pot).toBe(0);
          expect(g.players.every(p => p.bet === 0)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('buildPots', () => {
  it('splits any contributions into pots that add up, with only live contributors eligible', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ total: fc.integer({ min: 0, max: 5000 }), folded: fc.boolean() }), { minLength: 2, maxLength: 6 }), rows => {
        fc.pre(rows.some(r => !r.folded && r.total > 0));
        const g = table(rows.map(() => 0));
        rows.forEach((r, i) => Object.assign(g.players[i]!, r));
        const pots = buildPots(g);
        expect(pots.reduce((a, p) => a + p.amount, 0)).toBe(rows.reduce((a, r) => a + r.total, 0));
        for (const pot of pots) {
          expect(pot.amount).toBeGreaterThan(0);
          expect(pot.eligible.every(p => !p.folded && p.total > 0)).toBe(true);
        }
        // later pots have fewer (or the same) eligible players, each also eligible for earlier ones
        for (let i = 1; i < pots.length; i++) expect(pots[i]!.eligible.every(p => pots[i - 1]!.eligible.includes(p))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('bots in every game', () => {
  const cases: Array<['home' | 'tourney', VariantKey | null, number]> = [['home', 'holdem', 40], ['home', 'std', 8], ['home', 'two', 8], ['home', 'k8', 4], ['home', 'n7', 8], ['tourney', null, 40]];
  it.each(cases)('%s %s: %i hands with bots keep every chip accounted for', (mode, force, hands) => {
    const g = newGame({ mode, seed: `bots-${mode}-${force}`, settings: { name: '', opp: 5, stack: 1500, perLevel: 10, revealAll: true, games: 'dealer' } });
    const n = runSession(g, scriptedHero, hands, force ? { forceVariant: force } : {});
    expect(n).toBeGreaterThan(0);
    const chips = g.players.reduce((a, p) => a + p.stack, 0);
    if (mode === 'home') expect(chips).toBe(g.players.reduce((a, p) => a + p.buyins, 0) * 1000);
    else expect(chips).toBe(1500 * g.players.length);
  });
});
