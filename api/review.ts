// POST /api/review: an AI review of one finished hand, streamed as server-sent events.
//
//   event: delta    data: {"text": "..."}     raw model output as it is generated
//   event: result   data: {"review": {...}}   the validated review (grade, mistake, lesson)
//   event: fallback data: {"reason": "..."}  use the built-in review instead
//
// Errors before streaming starts are plain JSON with {fallback: true, reason}:
//   503 not_configured (no ANTHROPIC_API_KEY), 429 rate_limited, 400 bad_request.
// The API key is read from the server environment only and never sent to the browser.
import { createReviewHandler } from '../src/review/handler.js';
import { reviewLimiters } from '../src/review/rate-limit.js';
import { anthropicModel, type ModelFn } from '../src/review/review.js';

let model: ModelFn | null = null;

export const POST = createReviewHandler({
  hasKey: () => !!process.env.ANTHROPIC_API_KEY,
  limit: reviewLimiters(),
  model: () => (model ??= anthropicModel()),
});

export function GET(): Response {
  return new Response(JSON.stringify({ error: 'use POST' }), { status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } });
}
