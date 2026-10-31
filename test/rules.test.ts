// No-limit betting rules that the engine itself must enforce (not just the UI or the bots).
import { describe, expect, it } from 'vitest';
import { options } from '../src/engine/engine';
import { play, script, table } from './helpers';

describe('minimum raise', () => {
  it('turns an under-sized raise into a minimum raise when the player has the chips', () => {
    // blinds 10/20: the minimum raise preflop is to 40. Player 3 asks to raise to 30.
    const g = table([1500, 1500, 1500, 1500]);
    let afterRaise = 0;
    play(g, script([[3, { type: 'raise', to: 30 }]], (_p, gg, k) => { if (k === 1) afterRaise = gg.currentBet; }));
    expect(afterRaise).toBe(40);
    expect(g.hist).toContain(`${g.players[3]!.name}: raises 20 to 40`);
  });

  it('still allows an all-in for less than a minimum raise', () => {
    // player 3 has only 30 chips: all-in to 30 is legal even though a full raise is to 40
    const g = table([1500, 1500, 1500, 30]);
    let afterRaise = 0;
    play(g, script([[3, { type: 'raise', to: 30 }]], (_p, gg, k) => { if (k === 1) afterRaise = gg.currentBet; }));
    expect(afterRaise).toBe(30);
  });
});

describe('short all-ins and re-opening the betting (TDA rule)', () => {
  // Button = 0, SB = 1, BB = 2. Player 3 opens to 100 (a raise of 80, so a full raise is 80).
  it('one short all-in does not re-open the betting for a player who already acted', () => {
    const g = table([1500, 1500, 1500, 1500, 150]);
    let canRaise: boolean | null = null;
    play(g, script([
      [3, { type: 'raise', to: 100 }],
      [4, { type: 'raise', to: 150 }], // all-in: +50, less than a full raise
      [0, { type: 'fold' }], [1, { type: 'fold' }], [2, { type: 'fold' }],
    ], (p, gg, k) => { if (k === 5 && p.i === 3) canRaise = options(gg, p).canRaise; }));
    expect(canRaise).toBe(false);
  });

  it('several short all-ins that add up to a full raise do re-open it', () => {
    const g = table([200, 1500, 1500, 1500, 150]);
    let canRaise: boolean | null = null;
    play(g, script([
      [3, { type: 'raise', to: 100 }],
      [4, { type: 'raise', to: 150 }], // all-in: +50
      [0, { type: 'raise', to: 200 }], // all-in: +50 more; player 3 now faces +100 >= a full raise of 80
      [1, { type: 'fold' }], [2, { type: 'fold' }],
    ], (p, gg, k) => { if (k === 5 && p.i === 3) canRaise = options(gg, p).canRaise; }));
    expect(canRaise).toBe(true);
  });
});
