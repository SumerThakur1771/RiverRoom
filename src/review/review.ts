// AI hand review: a short, structured coaching note on one finished hand.
//
// The model must return JSON matching ReviewSchema {grade, mistake, lesson}. Every answer
// is validated with zod; anything invalid moves on to the next model in the chain, and if
// none gives a valid answer the page shows the app's own built-in review.
//
// This module is plain TypeScript plus zod (no network), so the prompt builder can also run
// in the browser to compute the same cache key as the server.
import { z } from 'zod';

export const GRADES = ['great', 'good', 'fine', 'mistake', 'blunder'] as const;
export const ReviewSchema = z.object({
  grade: z.enum(GRADES),
  mistake: z.string().max(400).nullable(),
  lesson: z.string().min(1).max(400),
});
export type Review = z.infer<typeof ReviewSchema>;

/** JSON Schema for OpenRouter's response_format (kept in step with ReviewSchema by a test). */
export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    grade: { type: 'string', enum: [...GRADES] },
    mistake: { type: ['string', 'null'] },
    lesson: { type: 'string' },
  },
  required: ['grade', 'mistake', 'lesson'],
  additionalProperties: false,
} as const;

/** One decision as the app's own coach saw it (from the hand review the page already built). */
const DecisionSchema = z.object({
  st: z.number().int().min(-1).max(3),
  pos: z.string().max(10).optional(),
  pot: z.number().min(0).max(1e9).optional(),
  toCall: z.number().min(0).max(1e9).optional(),
  eq: z.number().min(0).max(1).optional(),
  need: z.number().min(0).max(1).optional(),
  act: z.string().max(10),
  to: z.number().min(0).max(1e9).optional(),
  rec: z.string().max(10).optional(),
  grade: z.enum(GRADES),
  cat: z.string().max(30).optional(),
  split: z.string().max(200).optional(),
  loss: z.number().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;
export const ReviewRequestSchema = z.object({
  /** The hand history log, as shown in the app's history panel. */
  hand: z.string().min(20).max(8000),
  decisions: z.array(DecisionSchema).max(20),
  /** Dealer's-choice variant name and rules, when it was not plain Hold'em. */
  game: z.string().max(80).optional(),
  gameDesc: z.string().max(600).optional(),
  money: z.boolean().optional(),
  /** Eval only: ask one free model on its own (must be one of FREE_CANDIDATES). */
  model: z.string().max(100).optional(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export { buildUserMessage, compactHand, decisionLine, PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.js';

export type FallbackReason =
  | 'not_configured' | 'rate_limited' | 'paid_cap' | 'bad_request'
  | 'refused' | 'truncated' | 'invalid_json' | 'invalid_schema' | 'model_error' | 'timeout' | 'all_failed';

/** Pull the JSON object out of a model's answer (tolerates code fences or a stray sentence). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* try the outermost braces */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new SyntaxError('no JSON object');
  return JSON.parse(t.slice(a, b + 1));
}

/** Validate a model's answer. */
export function parseReview(text: string): { ok: true; review: Review } | { ok: false; reason: 'invalid_json' | 'invalid_schema'; detail?: string } {
  let json: unknown;
  try { json = extractJson(text); } catch { return { ok: false, reason: 'invalid_json' }; }
  const parsed = ReviewSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'invalid_schema', detail: parsed.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ').slice(0, 300) };
  return { ok: true, review: parsed.data };
}
