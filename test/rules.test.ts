// No-limit betting rules that the engine itself must enforce (not just the UI or the bots).
import { describe, expect, it } from 'vitest';
import { buildPots, options } from '../src/engine/engine';
import { card, deckFor, play, script, table } from './helpers';

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
      [0, { type: 'fold' }], [1, { type: 'call' }], [2, { type: 'fold' }],
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
      [1, { type: 'call' }], [2, { type: 'fold' }], // the small blind stays in with chips behind
    ], (p, gg, k) => { if (k === 5 && p.i === 3) canRaise = options(gg, p).canRaise; }));
    expect(canRaise).toBe(true);
  });
});


describe('blinds, antes and order of play', () => {
  it('heads-up: the button posts the small blind, acts first preflop and last after the flop', () => {
    const g = table([1500, 1500]);
    const order: Array<[number, number]> = [];
    play(g, (s, gg) => { order.push([gg.street, s.p.i]); return { type: s.p.i === g.button ? 'call' : 'check' }; });
    expect(g.players[g.sbIdx]!.i).toBe(g.button);
    expect(order[0]).toEqual([0, g.button]);
    expect(order.find(([st]) => st === 1)).toEqual([1, g.bbIdx]);
  });

  it('posts antes from every player at the ante levels', () => {
    const g = table([1500, 1500, 1500]);
    g.handNo = 30; // level 4: 50/100, ante 10
    play(g, script([]));
    expect(g.hist.filter(l => /posts the ante 10$/.test(l))).toHaveLength(3);
  });
});

describe('paying the pot', () => {
  it('returns an uncalled bet', () => {
    const g = table([1500, 1500, 1500]);
    // button (0) raises to 300, both blinds fold: 280 of it (above the big blind's 20) was never called
    play(g, script([[0, { type: 'raise', to: 300 }], [1, { type: 'fold' }], [2, { type: 'fold' }]]));
    expect(g.hist).toContain(`Uncalled bet (280) returned to ${g.players[0]!.name}`);
    expect(g.players[0]!.stack).toBe(1500 + 10 + 20);
  });

  it('gives the odd chip of a split pot to the first winner left of the button', () => {
    // a royal flush on the board: everyone still in ties
    const g = table([1500, 1500, 1500]);
    g.handNo = 10; // level 2: blinds 15/30, so the folded small blind leaves an odd pot of 75
    g.nextDeck = deckFor([card(2, 1), card(3, 1), card(4, 1), card(5, 2), card(6, 2), card(7, 2), card(8, 3), card(14, 0), card(13, 0), card(12, 0), card(9, 3), card(11, 0), card(9, 2), card(10, 0)]);
    play(g, script([[0, { type: 'call' }], [1, { type: 'fold' }], [2, { type: 'check' }]]));
    // winners in order from the button's left: player 2 (big blind) first, then player 0
    expect(g.players[2]!.stack).toBe(1500 - 30 + 38);
    expect(g.players[0]!.stack).toBe(1500 - 30 + 37);
  });

  it('lets a short all-in win only the main pot', () => {
    // player 0 (button) is all-in for 100 with aces; players 1 and 2 build a side pot
    const g = table([100, 1000, 1000]);
    const A = [card(14, 0), card(14, 1)], weak1 = [card(2, 2), card(7, 3)], weak2 = [card(3, 2), card(8, 3)];
    // deal order from the small blind: 1, 2, 0, 1, 2, 0
    g.nextDeck = deckFor([weak1[0]!, weak2[0]!, A[0]!, weak1[1]!, weak2[1]!, A[1]!, card(4, 0), card(9, 0), card(10, 1), card(12, 2), card(5, 1), card(13, 3), card(6, 0), card(11, 3)]);
    play(g, script([[0, { type: 'raise', to: 100 }], [1, { type: 'raise', to: 400 }], [2, { type: 'call' }]], undefined));
    expect(g.players[0]!.stack).toBe(300); // main pot: 3 x 100
    expect(g.players[1]!.stack + g.players[2]!.stack).toBe(2000 - 100 * 2); // side pot stays between them
  });
});

describe('buildPots', () => {
  it('layers contributions into a main pot and side pots with the right players', () => {
    const g = table([0, 0, 0, 0]);
    const [a, b, c, d] = g.players as [typeof g.players[0], typeof g.players[0], typeof g.players[0], typeof g.players[0]];
    a.total = 50; b.total = 200; c.total = 200; d.total = 120; d.folded = true;
    const pots = buildPots(g);
    expect(pots.map(p => p.amount)).toEqual([200, 370]);
    expect(pots[0]!.eligible).toEqual([a, b, c]);
    expect(pots[1]!.eligible).toEqual([b, c]);
  });
});

describe('live-play randomness', () => {
  it('deals from crypto, and runs everything else on fast generators seeded from crypto', async () => {
    const { Streams } = await import('../src/engine/rng');
    let cryptoCalls = 0;
    const counting = (): number => { cryptoCalls++; return Math.random(); };
    const rs = new Streams(null, counting);
    const before = cryptoCalls;
    rs.seg('h1:deck', () => { for (let i = 0; i < 52; i++) rs.rand(); });
    expect(cryptoCalls - before).toBe(52); // every deck draw comes from crypto
    const mid = cryptoCalls;
    rs.seg('h1:ai:0', () => { for (let i = 0; i < 10000; i++) rs.rand(); });
    expect(cryptoCalls - mid).toBe(1); // one crypto draw to seed the fast generator
  });
});
