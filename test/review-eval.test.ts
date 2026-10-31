// The review eval's scorer, and the eval set's shape.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ReviewRequestSchema } from '../src/review/review';
import type { EvalItem } from '../tools/review/make-eval-set';
import { scoreOne, summarize } from '../tools/review/score';

const items = JSON.parse(readFileSync(new URL('./review-eval/hands.json', import.meta.url), 'utf8')) as EvalItem[];

describe('review eval set', () => {
  it('has 20 valid requests: 10 with a coach-found mistake, 10 without', () => {
    expect(items).toHaveLength(20);
    for (const i of items) expect(ReviewRequestSchema.safeParse(i.request).success).toBe(true);
    expect(items.filter(i => i.expected.hasMistake)).toHaveLength(10);
  });
});

describe('scorer', () => {
  const mistake = { grade: 'mistake' as const, hasMistake: true, street: 2, cat: 'overfold' };
  const clean = { grade: 'good' as const, hasMistake: false, street: null, cat: null };
  it('passes a matching answer', () => {
    expect(scoreOne({ grade: 'blunder', mistake: 'On the turn you folded too much.', lesson: 'Call when the price is right.' }, mistake)).toEqual({ valid: true, gradeClose: true, mistakeAgrees: true, streetNamed: true });
    expect(scoreOne({ grade: 'great', mistake: null, lesson: 'Keep it up.' }, clean)).toEqual({ valid: true, gradeClose: true, mistakeAgrees: true, streetNamed: null });
  });
  it('fails a wrong grade, a missed mistake, the wrong street and invalid output', () => {
    expect(scoreOne({ grade: 'great', mistake: null, lesson: 'x' }, mistake)).toEqual({ valid: true, gradeClose: false, mistakeAgrees: false, streetNamed: false });
    expect(scoreOne({ grade: 'mistake', mistake: 'Before the flop you called.', lesson: 'x' }, mistake).streetNamed).toBe(false);
    expect(scoreOne({ grade: 'nope' }, clean).valid).toBe(false);
    expect(summarize([scoreOne(null, mistake), scoreOne({ grade: 'good', mistake: null, lesson: 'x' }, clean)]).score).toBeCloseTo(3 / 7);
  });
});
