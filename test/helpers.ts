// Test helpers: build a table with chosen stacks and drive a hand with a script.
import { newGame, playHand, type Action, type Step } from '../src/engine/engine';
import type { Game, Player } from '../src/engine/state';

export function table(stacks: number[], opts: { mode?: 'home' | 'tourney'; seed?: string } = {}): Game {
  const n = stacks.length;
  const g = newGame({ mode: opts.mode ?? 'tourney', seed: opts.seed ?? 'test', settings: { name: 'You', opp: n - 1, stack: 1500, perLevel: 10, revealAll: false, games: 'dealer' } });
  g.players.forEach((p, i) => { p.stack = stacks[i]!; });
  // next hand's button is player 0, so: SB = 1, BB = 2, first to act preflop = 3 (with 4+ players)
  g.button = n - 1;
  return g;
}

export type Answer = (step: Step & { kind: 'act' }, g: Game) => Action;

/** Play one hand. `act` answers every decision; other requests get simple defaults. */
export function play(g: Game, act: Answer): void {
  const flow = playHand(g);
  let answer: unknown;
  for (;;) {
    const r = flow.next(answer);
    if (r.done) return;
    const s = r.value;
    answer = undefined;
    if (s.kind === 'act') answer = act(s, g);
    else if (s.kind === 'variant') answer = 'holdem';
    else if (s.kind === 'split') answer = s.p.parts;
    else if (s.kind === 'rebuy') answer = 'yes';
  }
}

/** A scripted sequence of actions by player index; afterwards everyone checks/folds. */
export function script(steps: Array<[number, Action]>, onAsk?: (p: Player, g: Game, k: number) => void): Answer {
  let k = 0;
  return (s, g) => {
    onAsk?.(s.p, g, k);
    const next = steps[k];
    if (next) {
      if (next[0] !== s.p.i) throw new Error(`step ${k}: expected player ${next[0]} to act, got ${s.p.i}`);
      k++;
      return next[1];
    }
    return { type: 'check' }; // check if possible; the engine turns it into a fold otherwise
  };
}
