// POST /api/review: an AI review of one finished hand, streamed as server-sent events.
//
//   event: attempt  data: {"model": "...", "paid": false}   a model is being asked
//   event: delta    data: {"text": "..."}                   its raw output as it arrives
//   event: result   data: {"review": {...}, "model": "...", "paid": false, "cached": false}
//   event: fallback data: {"reason": "..."}                 use the built-in review instead
//
// Errors before streaming starts are plain JSON with {fallback: true, reason}:
//   503 not_configured (no OPENROUTER_API_KEY), 429 rate_limited, 400 bad_request.
// The key is read from the server environment only and never sent to the browser.
import { ReviewCache } from '../src/review/cache.js';
import { createReviewHandler } from '../src/review/handler.js';
import { openRouterCall, type CallFn } from '../src/review/openrouter.js';
import { DailyCap, reviewLimiters } from '../src/review/rate-limit.js';

let call: CallFn | null = null;

export const POST = createReviewHandler({
  hasKey: () => !!process.env.OPENROUTER_API_KEY,
  limit: reviewLimiters(),
  call: () => (call ??= openRouterCall({ apiKey: process.env.OPENROUTER_API_KEY! })),
  cache: new ReviewCache(),
  paidCap: new DailyCap(),
});

export function GET(): Response {
  return new Response(JSON.stringify({ error: 'use POST' }), { status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } });
}
