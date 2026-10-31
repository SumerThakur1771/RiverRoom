// Grading a decision later (from snapshots, in the compute worker) must give exactly the
// grade the coach would have given at the time. This plays seeded hands, grades every hero
// decision both ways with the same random streams, and compares.
import { describe, expect, it } from 'vitest';
import { botAction, botFinalSplit, initPlans, pickVariantFor, practiceSplits } from '../src/ai/bots';
import { planSplit } from '../src/ai/split';
import { bindGame, coachContext, coachRec, gradeDecision, type CoachCtx } from '../src/coach/coach';
import { computeGrade, computeHint, toPlain, type Snapshot } from '../src/coach/compute';
import { newGame, playHand, type Action, type ActionResult } from '../src/engine/engine';
import type { Game } from '../src/engine/state';
import type { VariantKey } from '../src/engine/variants';
import { scriptedHero } from '../src/sim/driver';

const clone = <T>(x: T): T => structuredClone(x);

function compareSession(mode: 'home' | 'tourney', force: VariantKey | null, hands: number): number {
  const settings = { name: '', opp: 5, stack: 1500, perLevel: 10, revealAll: true, games: 'dealer' as const, hints: true };
  const g: Game = newGame({ mode, seed: `lazy-${mode}-${force}`, settings });
  const money = g.money, seed = g.rs.seed;
  let compared = 0;
  for (let h = 0; h < hands; h++) {
    const flow = playHand(g);
    let answer: unknown, pending: { pre: Snapshot; label: string; ctx: CoachCtx; pi: number } | null = null;
    for (;;) {
      const r = flow.next(answer);
      if (r.done) break;
      const s = r.value;
      answer = undefined;
      if (s.kind === 'act' && s.p.isHuman) {
        const pre = clone(toPlain(g)), label = g.rs.label(g.handNo, 'coach');
        bindGame(g, money, settings);
        const ctx = g.rs.seg(label, () => coachContext(s.p)); // the old way: right away, on live state
        // the Hint panel computes the same read from the snapshot
        const hint = computeHint({ snap: clone(pre), seed, pi: s.p.i, label, recLabel: 'hint-check', money, settings });
        expect(hint.ctx.eq).toBe(ctx.eq);
        pending = { pre, label, ctx, pi: s.p.i };
        answer = scriptedHero.act(g, s.p) as Action;
      } else if (s.kind === 'act') answer = botAction(g, s.p);
      else if (s.kind === 'variant') answer = force ?? pickVariantFor(g, s.p);
      else if (s.kind === 'plans') initPlans(g, s.order);
      else if (s.kind === 'split') answer = s.p.isHuman ? planSplit(g, s.p, s.k) : botFinalSplit(g, s.p, s.k);
      else if (s.kind === 'practiceView') practiceSplits(g);
      else if (s.kind === 'rebuy') answer = 'yes';
      else if (s.kind === 'pause' && s.what === 'action' && pending && (s.data as { p: { i: number } }).p.i === pending.pi) {
        const act = (s.data as { res: ActionResult }).res, post = clone(toPlain(g)), recLabel = g.rs.label(g.handNo, 'rec');
        bindGame(g, money, settings);
        const rec = g.rs.seg(recLabel, () => coachRec(pending!.ctx));
        const eager = { rec, g: gradeDecision(pending.ctx, act, rec) };
        const lazy = computeGrade({ pre: clone(pending.pre), post, seed, pi: pending.pi, label: pending.label, recLabel, act, money, settings });
        expect(lazy.ctx.eq).toBe(pending.ctx.eq);
        expect({ act: lazy.rec.act, size: lazy.rec.size ?? null }).toEqual({ act: eager.rec.act, size: eager.rec.size ?? null });
        expect(lazy.g).toEqual(eager.g);
        compared++;
        pending = null;
      }
    }
  }
  return compared;
}

describe('coach graded later = coach graded at the time', () => {
  it.each([
    ['home', 'holdem', 12], ['home', 'std', 4], ['home', 'two', 4], ['home', 'k8', 2], ['home', 'n7', 4], ['tourney', null, 12],
  ] as Array<['home' | 'tourney', VariantKey | null, number]>)('%s %s (%i hands)', (mode, force, hands) => {
    const n = compareSession(mode, force, hands);
    expect(n).toBeGreaterThan(0);
    console.log(`${mode} ${force ?? 'holdem'}: ${n} decisions graded identically`);
  });
});
