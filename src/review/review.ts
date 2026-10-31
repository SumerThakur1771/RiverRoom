// AI hand review: a short, structured coaching note on one finished hand.
//
// The model returns JSON that must match ReviewSchema {grade, mistake, lesson}. The text is
// streamed to the browser as it is generated, then validated with zod at the end; anything
// invalid (bad JSON, wrong shape, a refusal, a cut-off answer) falls back to the app's own
// built-in review, so the player always gets something.
//
// The model call is a plain function (ModelFn), so tests and the eval can swap in a mock.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** Small, fast model: a review is short and the player is waiting for it. */
export const REVIEW_MODEL = 'claude-haiku-5-5';
/** Room for adaptive thinking plus the short JSON answer. */
export const REVIEW_MAX_TOKENS = 4000;

export const GRADES = ['great', 'good', 'fine', 'mistake', 'blunder'] as const;
export const ReviewSchema = z.object({
  grade: z.enum(GRADES).describe('Overall grade of the player\'s decisions in this hand'),
  mistake: z.string().max(400).nullable().describe('The single most costly mistake, in one plain sentence; null if there was none'),
  lesson: z.string().min(1).max(400).describe('One concrete habit to practise next, in one or two plain sentences'),
});
export type Review = z.infer<typeof ReviewSchema>;

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
export const ReviewRequestSchema = z.object({
  /** The hand history log, as shown in the app's history panel. */
  hand: z.string().min(20).max(8000),
  decisions: z.array(DecisionSchema).max(20),
  /** Dealer's-choice variant name and rules, when it was not plain Hold'em. */
  game: z.string().max(80).optional(),
  gameDesc: z.string().max(600).optional(),
  money: z.boolean().optional(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const SYSTEM_PROMPT = `You are a friendly, expert poker coach reviewing one finished hand for a beginner who is learning No-Limit Texas Hold'em (and sometimes Indian home-game variants that split each player's cards into parts, such as a 2-card poker hand plus a 3-card "3 Patti" hand).

You receive the hand history and the app's own analysis of each of the player's decisions (eq = estimated chance to win against the opponents' likely hands; need = the share of the time a call must win to pay off; grade = the app's grade).

Return:
- grade: your overall grade for the player's decisions in this hand.
- mistake: the single most costly mistake in one plain sentence that names the street and what to do instead, or null if every decision was reasonable.
- lesson: one concrete habit to practise next.

Write in very simple, encouraging English. Avoid poker jargon; if you use a poker word, explain it in a few words. Base everything on the hand history and the numbers given; do not invent cards or actions.`;

export function buildUserMessage(req: ReviewRequest): string {
  const lines = [
    req.game ? `Game: ${req.game}. Rules: ${req.gameDesc ?? ''}` : 'Game: No-Limit Texas Hold\'em.',
    req.money ? 'Stakes: a friendly home cash game ($10 buy-in, blinds $0.10/$0.20); $1 is a big bet at this table.' : 'Stakes: a sit-and-go tournament (chips).',
    '',
    'Hand history:',
    req.hand,
    '',
    'The app\'s analysis of each decision (street 0 = before the flop, 1 = flop, 2 = turn, 3 = river; -1 = the card split):',
    JSON.stringify(req.decisions),
  ];
  return lines.join('\n');
}

/* ---- the model call ---- */
export interface ModelCall { system: string; user: string; onText: (delta: string) => void; signal?: AbortSignal }
export interface ModelResult { text: string; stopReason: string | null; usage?: { input_tokens: number; output_tokens: number } }
export type ModelFn = (call: ModelCall) => Promise<ModelResult>;

/** The real model: Claude Haiku 5.5, streaming, with the response format constrained to ReviewSchema. */
export function anthropicModel(client: Anthropic = new Anthropic()): ModelFn {
  return async ({ system, user, onText, signal }) => {
    const stream = client.messages.stream(
      {
        model: REVIEW_MODEL,
        max_tokens: REVIEW_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'low', format: zodOutputFormat(ReviewSchema) },
      },
      { signal },
    );
    stream.on('text', delta => onText(delta));
    const msg = await stream.finalMessage();
    const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    return { text, stopReason: msg.stop_reason, usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens } };
  };
}

export type FallbackReason = 'not_configured' | 'rate_limited' | 'bad_request' | 'refused' | 'truncated' | 'invalid_json' | 'invalid_schema' | 'model_error';
export type ReviewOutcome =
  | { ok: true; review: Review; usage?: ModelResult['usage'] }
  | { ok: false; reason: FallbackReason; detail?: string };

/** Ask the model for a review and validate it. Never throws: failures become fallback outcomes. */
export async function runReview(model: ModelFn, req: ReviewRequest, onText: (delta: string) => void = () => {}, signal?: AbortSignal): Promise<ReviewOutcome> {
  let res: ModelResult;
  try {
    res = await model({ system: SYSTEM_PROMPT, user: buildUserMessage(req), onText, signal });
  } catch (err) {
    return { ok: false, reason: 'model_error', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown error' };
  }
  if (res.stopReason === 'refusal') return { ok: false, reason: 'refused' };
  if (res.stopReason === 'max_tokens') return { ok: false, reason: 'truncated' };
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const parsed = ReviewSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'invalid_schema', detail: parsed.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ').slice(0, 300) };
  return { ok: true, review: parsed.data, usage: res.usage };
}
