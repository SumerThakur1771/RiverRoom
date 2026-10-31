// Scoring for the AI hand review eval. The reference is the app's own coach (the same code
// that grades real play), so this measures agreement with the built-in coach, not ground truth.
import { GRADES, ReviewSchema, type Review } from '../../src/review/review';
import type { EvalItem } from './make-eval-set';

export interface Checks { valid: boolean; gradeClose: boolean | null; mistakeAgrees: boolean | null; streetNamed: boolean | null }

const STREET: Record<number, RegExp> = {
  [-1]: /split|3 patti|part/i,
  0: /before the flop|pre-?flop|first two cards|starting hand/i,
  1: /(?<!before the )\bflop\b/i,
  2: /\bturn\b/i,
  3: /\briver\b|last card/i,
};

/** Score one model answer (null = no valid answer) against the expected verdict. */
export function scoreOne(answer: unknown, expected: EvalItem['expected']): Checks {
  const p = ReviewSchema.safeParse(answer);
  if (!p.success) return { valid: false, gradeClose: false, mistakeAgrees: false, streetNamed: expected.hasMistake ? false : null };
  const r: Review = p.data;
  const gradeClose = Math.abs(GRADES.indexOf(r.grade) - GRADES.indexOf(expected.grade)) <= 1;
  const mistakeAgrees = (r.mistake !== null && r.mistake.trim() !== '') === expected.hasMistake;
  const streetNamed = expected.hasMistake && expected.street !== null ? !!r.mistake && STREET[expected.street]!.test(r.mistake) : null;
  return { valid: true, gradeClose, mistakeAgrees, streetNamed };
}

export interface Summary { n: number; valid: number; gradeClose: number; mistakeAgrees: number; streetNamed: number; streetN: number; score: number }
/** Rates per check, and an overall score = mean of all applicable checks over all hands. */
export function summarize(all: Checks[]): Summary {
  const n = all.length;
  const count = (k: keyof Checks): number => all.filter(c => c[k] === true).length;
  const streetN = all.filter(c => c.streetNamed !== null).length;
  let pass = 0, total = 0;
  for (const c of all) for (const v of Object.values(c)) if (v !== null) { total++; if (v) pass++; }
  return { n, valid: count('valid'), gradeClose: count('gradeClose'), mistakeAgrees: count('mistakeAgrees'), streetNamed: count('streetNamed'), streetN, score: total ? pass / total : 0 };
}
