// Headless driver: plays hands with bots deciding for themselves and an agent for the hero.
// Used by the simulator and the tests (the browser UI drives the same engine its own way).
import { botAction, botFinalSplit, initPlans, pickVariantFor, practiceSplits } from '../ai/bots';
import { planSplit } from '../ai/split';
import { options, playHand, sessionOver, type Action, type HandSummary } from '../engine/engine';
import type { Game, Player } from '../engine/state';
import { potTotal, roundChips } from '../engine/table';
import { VAR_ORDER, type Split, type VariantKey } from '../engine/variants';

export interface HeroAgent {
  act(g: Game, p: Player): Action;
  variant?(g: Game, p: Player): VariantKey;
  split?(g: Game, p: Player, k: number): Split;
  rebuy?(g: Game, p: Player): 'yes' | 'no';
}

/** Play one hand to the end. */
export function runHand(g: Game, hero: HeroAgent, opts: { forceVariant?: VariantKey } = {}): HandSummary {
  const flow = playHand(g);
  let answer: unknown;
  for (;;) {
    const r = flow.next(answer);
    if (r.done) return r.value;
    const s = r.value;
    answer = undefined;
    switch (s.kind) {
      case 'act': answer = s.p.isHuman ? hero.act(g, s.p) : botAction(g, s.p); break;
      case 'variant': answer = opts.forceVariant ? opts.forceVariant : s.p.isHuman ? (hero.variant ? hero.variant(g, s.p) : VAR_ORDER[g.handNo % VAR_ORDER.length]) : pickVariantFor(g, s.p); break;
      case 'plans': initPlans(g, s.order); break;
      case 'split': answer = s.p.isHuman ? (hero.split ? hero.split(g, s.p, s.k) : planSplit(g, s.p, s.k)) : botFinalSplit(g, s.p, s.k); break;
      case 'practiceView': practiceSplits(g); break;
      case 'rebuy': answer = hero.rebuy ? hero.rebuy(g, s.p) : 'yes'; break;
      case 'pause': break;
    }
  }
}

/** Play until `hands` hands are done or the session ends. Returns the hands played. */
export function runSession(g: Game, hero: HeroAgent, hands: number, opts: { forceVariant?: VariantKey } = {}): number {
  let n = 0;
  while (n < hands && !sessionOver(g)) { runHand(g, hero, opts); n++; }
  return n;
}

/**
 * The scripted hero used by the golden recorder and the parity runs: a fixed mix of folds,
 * calls, min-raises, pot-sized raises and all-ins, keyed on a hash of the decision's label.
 */
export const scriptedHero: HeroAgent = {
  act(g, p) {
    const o = options(g, p), u = g.rs.hashOf(g.rs.label(g.handNo, 'hero')) % 100;
    if (u < 12) return o.toCall > 0 ? { type: 'fold' } : { type: 'check' };
    if (u < 62 || !o.canRaise) return o.toCall > 0 ? { type: 'call' } : { type: 'check' };
    if (u < 82) return { type: 'raise', to: o.minTo };
    if (u < 94) return { type: 'raise', to: Math.min(o.maxTo, Math.max(o.minTo, roundChips(g, g.currentBet + potTotal(g) * 0.75))) };
    return { type: 'raise', to: o.maxTo };
  },
};
