// Engine replay against the original game.
// Each golden file holds seeded sessions recorded from legacy/river-room.html
// (tools/golden/record.mjs): per hand the deck order, every action as submitted, the
// final splits, the hand-history log and everyone's stack afterwards.
// Here the TypeScript engine plays the same hands from the same inputs and must produce
// the same log lines (dealing, betting, pots, showdown, winners) and the same stacks.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newGame, playHand, type Action, type Step } from '../src/engine/engine';
import type { Player } from '../src/engine/state';
import type { Split, VariantKey } from '../src/engine/variants';

interface Hand {
  hand: number; variant: VariantKey; button: number; deck: number[];
  acts: Array<{ i: number; type: Action['type']; to: number | null }>;
  splits: Array<Split | null> | null; lines: string[];
  after: Array<{ name: string; stack: number; out: boolean; place: number; buyins: number }>;
}
interface Session {
  id: string; seed: string; tableNo: number;
  config: { mode: 'home' | 'tourney'; force: VariantKey | null; hands: number };
  setup: Array<{ name: string; seat: number; type: string | null; stack: number; persona: Player['persona'] }>;
  hands: Hand[];
}

const DIR = join(__dirname, 'golden');
const sessions: Session[] = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(DIR, f), 'utf8')));

/** Drop the practice-view block: which cards folded players "would have" split into comes from the bots, not the rules. */
const engineLines = (lines: string[]): string[] => {
  const out: string[] = [];
  let skip = false;
  for (const l of lines) {
    if (l === '*** ALL CARDS (practice view) ***') skip = true;
    else if (l === '*** SUMMARY ***') skip = false;
    if (!skip) out.push(l);
  }
  return out;
};

describe.each(sessions.map(s => [s.id, s] as const))('golden session %s', (_id, s) => {
  it(`replays ${s.hands.length} hands exactly`, () => {
    const g = newGame({ mode: s.config.mode, seed: s.seed, settings: { name: '', opp: 5, stack: 1500, perLevel: 10, revealAll: true, games: 'dealer' } });
    // seating is not part of the rules: take it from the recording
    expect(g.players.map(p => p.seat)).toEqual(s.setup.map(p => p.seat));
    s.setup.forEach((sp, k) => Object.assign(g.players[k]!, { name: sp.name, type: sp.type, persona: sp.persona }));
    g.tableNo = s.tableNo;
    for (const h of s.hands) {
      const n = g.players.length;
      g.button = (h.button - 1 + n) % n;
      g.nextDeck = h.deck.slice();
      let a = 0;
      const flow = playHand(g);
      let answer: unknown;
      for (;;) {
        const r = flow.next(answer);
        if (r.done) break;
        const step: Step = r.value;
        answer = undefined;
        if (step.kind === 'act') {
          const rec = h.acts[a++];
          expect(rec, `hand ${h.hand}: an action was asked for that the original never took`).toBeDefined();
          expect(step.p.i, `hand ${h.hand}: action ${a} by the wrong player`).toBe(rec!.i);
          answer = rec!.to === null ? { type: rec!.type } : { type: rec!.type, to: rec!.to };
        } else if (step.kind === 'variant') answer = h.variant;
        else if (step.kind === 'split') answer = h.splits![step.p.i];
        else if (step.kind === 'rebuy') answer = 'yes';
      }
      expect(a, `hand ${h.hand}: not every recorded action was used`).toBe(h.acts.length);
      expect(engineLines(g.hist.slice(0, h.lines.length)), `hand ${h.hand} log`).toEqual(engineLines(h.lines));
      expect(g.players.map(p => ({ name: p.name, stack: p.stack, out: p.out, place: p.place, buyins: p.buyins })), `hand ${h.hand} stacks after`).toEqual(h.after.map(({ name, stack, out, place, buyins }) => ({ name, stack, out, place, buyins })));
    }
  });
});
