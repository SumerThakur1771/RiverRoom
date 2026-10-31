// Builds the 20-hand eval set for the AI hand review (test/review-eval/hands.json).
//
// Plays seeded hands with the scripted hero, has the app's own coach grade every hero
// decision (the same code that grades real play), and keeps:
//   - 10 hands where the coach found a mistake or blunder, and
//   - 10 hands where every decision was good or great,
// spread over home Hold'em, tournament Hold'em and the split games.
// Each item is exactly the request the page sends to /api/review, plus the coach's verdict
// as the reference ("expected") that tools/review/eval.ts scores against.
//
// Usage: npx tsx tools/review/make-eval-set.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { botAction, botFinalSplit, initPlans, pickVariantFor, practiceSplits } from '../../src/ai/bots';
import { planSplit } from '../../src/ai/split';
import { bindGame, coachContext, coachRec, gradeDecision, GRADE_SCORE, type CoachCtx, type GradeKey } from '../../src/coach/coach';
import { newGame, playHand, type Action, type ActionResult } from '../../src/engine/engine';
import type { Mode } from '../../src/engine/state';
import { VARIANTS, type VariantKey } from '../../src/engine/variants';
import { scriptedHero } from '../../src/sim/driver';
import type { ReviewRequest } from '../../src/review/review';

export interface EvalItem {
  id: string;
  request: ReviewRequest;
  expected: { grade: GradeKey; hasMistake: boolean; street: number | null; cat: string | null };
}

interface Raw { st: number; pos: string; pot: number; toCall: number; eq: number; need: number; act: string; to: number; rec: string; grade: GradeKey; cat: string }

function* hands(mode: Mode, force: VariantKey | null, seed: string): Generator<{ req: ReviewRequest; decs: Raw[] }> {
  const settings = { name: '', opp: 5, stack: 1500, perLevel: 10, revealAll: true, games: 'dealer' as const };
  const g = newGame({ mode, seed, settings });
  for (let h = 0; h < 400; h++) {
    if (mode === 'tourney' && (g.players[0]!.out || g.players.filter(p => !p.out).length === 1)) return;
    const flow = playHand(g);
    const decs: Raw[] = [];
    let answer: unknown, ctx: CoachCtx | null = null;
    for (;;) {
      const r = flow.next(answer);
      if (r.done) break;
      const s = r.value;
      answer = undefined;
      if (s.kind === 'act' && s.p.isHuman) {
        bindGame(g, g.money, settings);
        ctx = g.rs.seg(g.rs.label(g.handNo, 'coach'), () => coachContext(s.p));
        answer = scriptedHero.act(g, s.p) as Action;
      } else if (s.kind === 'act') answer = botAction(g, s.p);
      else if (s.kind === 'variant') answer = force ?? pickVariantFor(g, s.p);
      else if (s.kind === 'plans') initPlans(g, s.order);
      else if (s.kind === 'split') answer = s.p.isHuman ? planSplit(g, s.p, s.k) : botFinalSplit(g, s.p, s.k);
      else if (s.kind === 'practiceView') practiceSplits(g);
      else if (s.kind === 'rebuy') answer = 'yes';
      else if (s.kind === 'pause' && s.what === 'action' && ctx && (s.data as { p: { isHuman: boolean } }).p.isHuman) {
        const act = (s.data as { res: ActionResult }).res, c: CoachCtx = ctx;
        bindGame(g, g.money, settings);
        const rec = g.rs.seg(g.rs.label(g.handNo, 'rec'), () => coachRec(c));
        const grade = gradeDecision(c, act, rec);
        decs.push({ st: c.st, pos: c.pos.label, pot: c.pot, toCall: c.toCall, eq: +c.eq.toFixed(3), need: +c.need.toFixed(3), act: act.type, to: act.to || 0, rec: rec.act, grade: grade.grade, cat: grade.cat || '' });
        ctx = null;
      }
    }
    if (!decs.length) continue;
    const V = g.variant && g.variant !== 'holdem' ? VARIANTS[g.variant] : null;
    const req: ReviewRequest = { hand: g.hist.join('\n'), decisions: decs, money: g.money, ...(V ? { game: V.name, gameDesc: V.desc } : {}) };
    yield { req, decs };
  }
}

const want: Array<[string, Mode, VariantKey | null, number, number]> = [
  // [label, mode, forced variant, mistakes wanted, clean hands wanted]
  ['home-holdem', 'home', 'holdem', 4, 4],
  ['tourney', 'tourney', null, 3, 3],
  ['home-std', 'home', 'std', 2, 2],
  ['home-two', 'home', 'two', 1, 1],
];
const items: EvalItem[] = [];
for (const [label, mode, force, nBad, nGood] of want) {
  let bad = 0, good = 0, session = 0;
  while ((bad < nBad || good < nGood) && session < 40) {
    for (const { req, decs } of hands(mode, force, `review-eval-${label}-${session++}`)) {
      const worst = decs.slice().sort((a, b) => GRADE_SCORE[a.grade] - GRADE_SCORE[b.grade])[0]!;
      const isBad = worst.grade === 'mistake' || worst.grade === 'blunder';
      const isClean = decs.every(d => d.grade === 'good' || d.grade === 'great') && decs.length >= 2;
      if (req.hand.length > 8000) continue;
      if (isBad && bad < nBad) { bad++; items.push({ id: `${label}-m${bad}`, request: req, expected: { grade: worst.grade, hasMistake: true, street: worst.st, cat: worst.cat || null } }); }
      else if (isClean && good < nGood) { good++; items.push({ id: `${label}-c${good}`, request: req, expected: { grade: worst.grade, hasMistake: false, street: null, cat: null } }); }
      if (bad >= nBad && good >= nGood) break;
    }
  }
}
mkdirSync(new URL('../../test/review-eval/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../test/review-eval/hands.json', import.meta.url), JSON.stringify(items, null, 1) + '\n');
console.log(`${items.length} hands: ${items.filter(i => i.expected.hasMistake).length} with a mistake, ${items.filter(i => !i.expected.hasMistake).length} clean`);
for (const i of items) console.log(`  ${i.id.padEnd(16)} expected ${i.expected.grade.padEnd(8)} street ${i.expected.street ?? '-'} ${i.expected.cat ?? ''}  (${i.request.decisions.length} decisions, ${i.request.hand.length} chars)`);
