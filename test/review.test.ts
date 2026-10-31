// AI hand review: validation, fallbacks, rate limiting and the streaming endpoint, all with a
// mock model (no network, no API key).
import { describe, expect, it } from 'vitest';
import { createReviewHandler, readReviewEvents } from '../src/review/handler';
import { reviewLimiters, SlidingWindowLimiter } from '../src/review/rate-limit';
import { buildUserMessage, runReview, type ModelFn, type ModelResult, type ReviewRequest } from '../src/review/review';

const REQ: ReviewRequest = {
  hand: 'Home Game Hand #3: Hold\'em No Limit ($0.10/$0.20 USD)\nSumer: calls $0.20\n*** FLOP *** [Ah 7c 2d]\nSumer: folds',
  decisions: [{ st: 1, act: 'fold', grade: 'mistake', eq: 0.62, need: 0.25, cat: 'overfold', rec: 'call' }],
  money: true,
};
const GOOD = { grade: 'mistake', mistake: 'On the flop you folded a hand that wins often enough to call.', lesson: 'Compare your chance to win with the price before folding.' };
const mock = (text: string, stopReason: string | null = 'end_turn', chunks = 3): ModelFn => async ({ onText }) => {
  const n = Math.ceil(text.length / chunks);
  for (let i = 0; i < text.length; i += n) onText(text.slice(i, i + n));
  return { text, stopReason } satisfies ModelResult;
};

describe('runReview', () => {
  it('streams the text and returns a validated review', async () => {
    const deltas: string[] = [];
    const out = await runReview(mock(JSON.stringify(GOOD)), REQ, d => deltas.push(d));
    expect(out).toEqual({ ok: true, review: GOOD, usage: undefined });
    expect(deltas.join('')).toBe(JSON.stringify(GOOD));
    expect(deltas.length).toBeGreaterThan(1);
  });
  it.each([
    ['not JSON', mock('Sure! Here is my review...'), 'invalid_json'],
    ['wrong shape', mock(JSON.stringify({ grade: 'excellent', lesson: '' })), 'invalid_schema'],
    ['a refusal', mock('', 'refusal'), 'refused'],
    ['a cut-off answer', mock('{"grade": "go', 'max_tokens'), 'truncated'],
    ['a model error', (async () => { throw new Error('overloaded'); }) as ModelFn, 'model_error'],
  ])('falls back on %s', async (_label, model, reason) => {
    const out = await runReview(model, REQ);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe(reason);
  });
  it('puts the hand and the app\'s own analysis in the prompt', () => {
    const msg = buildUserMessage(REQ);
    expect(msg).toContain('*** FLOP *** [Ah 7c 2d]');
    expect(msg).toContain('"cat":"overfold"');
    expect(msg).toContain('$1 is a big bet');
  });
});

describe('rate limiting', () => {
  it('allows up to the limit in the window, then reports when to retry', () => {
    const lim = new SlidingWindowLimiter(3, 60_000);
    expect([0, 1, 2].map(t => lim.check('ip', 1000 + t).allowed)).toEqual([true, true, true]);
    const r = lim.check('ip', 2000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(1000 + 60_000 - 2000);
    expect(lim.check('ip', 1000 + 60_001).allowed).toBe(true); // the first hit has left the window
    expect(lim.check('other-ip', 2000).allowed).toBe(true);
  });
  it('limits each IP to 5 a minute and 20 an hour; rejected requests are not counted', () => {
    const limit = reviewLimiters();
    const t0 = 1_000_000;
    expect(Array.from({ length: 6 }, () => limit('a', t0).allowed)).toEqual([true, true, true, true, true, false]);
    let allowed = 5;
    for (let m = 1; m < 60; m++) for (let k = 0; k < 6; k++) if (limit('a', t0 + m * 60_000).allowed) allowed++;
    expect(allowed).toBe(20);
    expect(limit('b', t0).allowed).toBe(true);
  });
});

describe('POST /api/review handler', () => {
  const post = (body: unknown, ip = '1.2.3.4'): Request =>
    new Request('http://x/api/review', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip + ', 10.0.0.1' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const handler = (over: Partial<Parameters<typeof createReviewHandler>[0]> = {}) =>
    createReviewHandler({ hasKey: () => true, limit: reviewLimiters(), model: () => mock(JSON.stringify(GOOD)), ...over });

  it('without an API key: 503 and the built-in review', async () => {
    const res = await handler({ hasKey: () => false })(post(REQ));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ fallback: true, reason: 'not_configured' });
  });
  it('rejects bad input with 400 before calling the model', async () => {
    let called = false;
    const h = handler({ model: () => { called = true; return mock('{}'); } });
    expect((await h(post('not json'))).status).toBe(400);
    expect((await h(post({ hand: 'x', decisions: [] }))).status).toBe(400);
    expect((await h(post({ ...REQ, hand: 'y'.repeat(9000) }))).status).toBe(400);
    expect(called).toBe(false);
  });
  it('streams deltas, then the validated review', async () => {
    const res = await handler()(post(REQ));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    let streamed = '';
    const out = await readReviewEvents(res, t => (streamed += t));
    expect(out.review).toEqual(GOOD);
    expect(streamed).toBe(JSON.stringify(GOOD));
  });
  it('sends a fallback event when the model output is invalid', async () => {
    const res = await handler({ model: () => mock('nope') })(post(REQ));
    expect(await readReviewEvents(res)).toEqual({ fallback: 'invalid_json' });
  });
  it('rate-limits by the client IP (first x-forwarded-for entry): 429 with retry-after', async () => {
    const h = handler();
    for (let i = 0; i < 5; i++) expect((await h(post(REQ, '9.9.9.9'))).status).toBe(200);
    const res = await h(post(REQ, '9.9.9.9'));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await res.json()).reason).toBe('rate_limited');
    expect((await h(post(REQ, '8.8.8.8'))).status).toBe(200);
  });
});
