// AI hand review: prompt, validation, the OpenRouter client (with a fake fetch), the free-first
// model chain, the paid cap, caching and the streaming endpoint. No network, no API key.
import { describe, expect, it } from 'vitest';
import { ReviewCache } from '../src/review/cache';
import { createReviewHandler, readReviewEvents } from '../src/review/handler';
import { reviewKey } from '../src/review/key';
import { ModelError, openRouterCall, OPENROUTER_URL, REVIEW_MAX_TOKENS, REVIEW_MODELS, runChain, type AttemptResult, type CallFn, type ModelSpec } from '../src/review/openrouter';
import { DailyCap, reviewLimiters, SlidingWindowLimiter } from '../src/review/rate-limit';
import { buildUserMessage, compactHand, GRADES, parseReview, REVIEW_JSON_SCHEMA, ReviewSchema, SYSTEM_PROMPT, type ReviewRequest } from '../src/review/review';

const HAND = `Home Game Hand #3: Hold'em No Limit ($0.10/$0.20 USD)
Table 5994 5-max. Seat #2 is the button
Seat 1: Sumer ($10.00 in chips)
Seat 2: Nikhil ($9.80 in chips)
Venky: posts small blind $0.10
*** HOLE CARDS ***
Dealt to Sumer [Ac 2h]
Sumer: calls $0.20
Venky said, "wait what do I have"
*** FLOP *** [Ah 7c 2d]
Sumer: folds
*** ALL CARDS (practice view) ***
Nikhil: [5c Kh] (folded)
*** SUMMARY ***
Total pot $0.50 | Board [Ah 7c 2d]`;
const REQ: ReviewRequest = {
  hand: HAND,
  decisions: [{ st: 1, pos: 'BB', pot: 50, act: 'fold', grade: 'mistake', eq: 0.62, need: 0.25, cat: 'overfold', rec: 'call' }],
  money: true,
};
const GOOD = { grade: 'mistake', mistake: 'On the flop you folded a hand that wins often enough to call.', lesson: 'Compare your chance to win with the price before folding.' };
const FREE_A = REVIEW_MODELS[0]!, FREE_B = REVIEW_MODELS[1]!, PAID = REVIEW_MODELS[2]!;

/** A mock model call per model id: return text (streamed in pieces) or throw. */
type Script = Partial<Record<string, string | AttemptResult | Error>>;
function mockCall(script: Script, calls: string[] = []): CallFn {
  return async (spec, { onText }) => {
    calls.push(spec.id);
    const s = script[spec.id];
    if (s === undefined) throw new ModelError('not scripted', 'model_error');
    if (s instanceof Error) throw s;
    const r: AttemptResult = typeof s === 'string' ? { text: s, finish: 'stop' } : s;
    for (let i = 0; i < r.text.length; i += 20) onText(r.text.slice(i, i + 20));
    return r;
  };
}

describe('prompt', () => {
  it('keeps the actions and the player\'s own cards, and drops seats, the practice-view dump and the summary', () => {
    const h = compactHand(HAND);
    expect(h).toContain('Dealt to Sumer [Ac 2h]');
    expect(h).toContain('FLOP: [Ah 7c 2d]');
    expect(h).toContain('Stacks: Sumer $10.00, Nikhil $9.80');
    expect(h).not.toMatch(/5c Kh|SUMMARY|Table 5994|Seat 1|HOLE CARDS|said,/);
  });
  it('sends each decision as one short line with the app\'s numbers', () => {
    expect(buildUserMessage(REQ)).toContain('Flop BB: fold; pot $0.50; win chance 62%, needed 25%; app coach: call, graded mistake (overfold)');
  });
  it('asks for JSON only, and the JSON schema matches the zod schema', () => {
    expect(SYSTEM_PROMPT).toMatch(/only this JSON object/);
    expect(REVIEW_JSON_SCHEMA.required).toEqual(Object.keys(ReviewSchema.shape));
    expect(REVIEW_JSON_SCHEMA.properties.grade.enum).toEqual([...GRADES]);
  });
});

describe('parseReview (zod)', () => {
  it('accepts a valid answer, also inside a code fence', () => {
    expect(parseReview(JSON.stringify(GOOD))).toEqual({ ok: true, review: GOOD });
    expect(parseReview('```json\n' + JSON.stringify(GOOD) + '\n```')).toEqual({ ok: true, review: GOOD });
  });
  it('rejects text that is not JSON, and JSON of the wrong shape', () => {
    expect(parseReview('Sure! Here is my review').ok).toBe(false);
    expect(parseReview(JSON.stringify({ grade: 'excellent', lesson: '' }))).toMatchObject({ ok: false, reason: 'invalid_schema' });
  });
});

/** A fake OpenRouter: records the request and answers with SSE lines (or an HTTP error). */
function fakeFetch(answer: { status?: number; lines?: string[]; error?: string; hang?: boolean }, seen: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    if (answer.hang) return new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    if (answer.status && answer.status !== 200) return new Response(JSON.stringify({ error: { message: answer.error ?? 'nope' } }), { status: answer.status });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const l of answer.lines!) c.enqueue(enc.encode(l + '\n')); c.close(); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}
const sse = (o: unknown): string => 'data: ' + JSON.stringify(o) + '\n';

describe('openRouterCall (plain fetch, streaming)', () => {
  const text = JSON.stringify(GOOD);
  const lines = [
    ': OPENROUTER PROCESSING', '',
    sse({ model: 'google/gemma-4-26b-a4b-it:free', choices: [{ delta: { content: text.slice(0, 30) } }] }),
    sse({ model: 'google/gemma-4-26b-a4b-it:free', choices: [{ delta: { content: text.slice(30) }, finish_reason: 'stop' }] }),
    sse({ choices: [], usage: { prompt_tokens: 310, completion_tokens: 52, cost: 0 } }),
    'data: [DONE]',
  ];
  it('streams the content, ignores keep-alive comments, and reads the model, finish reason and usage', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [], deltas: string[] = [];
    const r = await openRouterCall({ apiKey: 'k', fetch: fakeFetch({ lines }, seen) })(FREE_A, { system: 's', user: 'u', onText: d => deltas.push(d) });
    expect(r).toEqual({ text, finish: 'stop', servedBy: 'google/gemma-4-26b-a4b-it:free', usage: { prompt_tokens: 310, completion_tokens: 52, cost: 0 } });
    expect(deltas).toHaveLength(2);
    expect(seen[0]!.url).toBe(OPENROUTER_URL);
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const body = JSON.parse(seen[0]!.init.body as string);
    expect(body).toMatchObject({ model: FREE_A.id, max_tokens: REVIEW_MAX_TOKENS, stream: true });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
  });
  it('asks each model for JSON in the strongest way it supports, and low reasoning effort from reasoning models', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    for (const spec of [{ id: 'a', paid: false, json: 'schema' }, { id: 'b', paid: false, json: 'none', reasoning: true }, { id: 'c', paid: false, json: 'object' }] as ModelSpec[]) {
      const seen: Array<{ url: string; init: RequestInit }> = [];
      await openRouterCall({ apiKey: 'k', fetch: fakeFetch({ lines }, seen) })(spec, { system: 's', user: 'u', onText: () => {} });
      bodies.push(JSON.parse(seen[0]!.init.body as string));
    }
    expect(bodies[0]!.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: REVIEW_JSON_SCHEMA } });
    expect(bodies[0]!.reasoning).toBeUndefined();
    expect(bodies[1]!.response_format).toBeUndefined();
    expect(bodies[1]!.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(bodies[2]!.response_format).toEqual({ type: 'json_object' });
  });
  it.each([
    ['HTTP 429', { status: 429 }, 'rate_limited'],
    ['HTTP 502', { status: 502 }, 'model_error'],
    ['an error inside the stream', { lines: [sse({ error: { code: 429, message: 'free model busy' } })] }, 'rate_limited'],
    ['no answer in time', { hang: true }, 'timeout'],
  ])('turns %s into a ModelError (%s)', async (_l, answer, kind) => {
    const call = openRouterCall({ apiKey: 'k', fetch: fakeFetch(answer), timeoutMs: 50 });
    await expect(call(FREE_A, { system: 's', user: 'u', onText: () => {} })).rejects.toMatchObject({ kind });
  });
});

describe('model chain: free first, paid last', () => {
  const cap = (): DailyCap => new DailyCap(200);
  it('stops at the first free model with a valid answer; the paid model is never called', async () => {
    const calls: string[] = [];
    const out = await runChain(mockCall({ [FREE_A.id]: JSON.stringify(GOOD) }, calls), REQ, { paidCap: cap() });
    expect(out).toMatchObject({ ok: true, model: FREE_A.id, paid: false, review: GOOD });
    expect(calls).toEqual([FREE_A.id]);
  });
  it('moves on after a rate limit and after output that fails validation, ending at the paid model', async () => {
    const calls: string[] = [];
    const out = await runChain(mockCall({ [FREE_A.id]: new ModelError('429', 'rate_limited'), [FREE_B.id]: '{"grade":"awesome"}', [PAID.id]: JSON.stringify(GOOD) }, calls), REQ, { paidCap: cap() });
    expect(out).toMatchObject({ ok: true, model: PAID.id, paid: true });
    expect(out.attempts.map(a => a.outcome)).toEqual(['rate_limited', 'invalid_schema', 'ok']);
    expect(calls).toEqual([FREE_A.id, FREE_B.id, PAID.id]);
  });
  it('moves on after a timeout and after a cut-off answer', async () => {
    const out = await runChain(mockCall({ [FREE_A.id]: new ModelError('slow', 'timeout'), [FREE_B.id]: { text: '{"grade":"go', finish: 'length' }, [PAID.id]: JSON.stringify(GOOD) }), REQ, { paidCap: cap() });
    expect(out.attempts.map(a => a.outcome)).toEqual(['timeout', 'truncated', 'ok']);
  });
  it('when today\'s paid budget is used up, it skips the paid model and falls back', async () => {
    const calls: string[] = [], c = new DailyCap(0);
    const out = await runChain(mockCall({ [FREE_A.id]: 'nope', [FREE_B.id]: new ModelError('x', 'model_error'), [PAID.id]: JSON.stringify(GOOD) }, calls), REQ, { paidCap: c });
    expect(out).toMatchObject({ ok: false, reason: 'paid_cap' });
    expect(calls).toEqual([FREE_A.id, FREE_B.id]);
  });
  it('falls back when every model fails', async () => {
    expect(await runChain(mockCall({}), REQ, { paidCap: cap() })).toMatchObject({ ok: false, reason: 'all_failed' });
  });
});

describe('daily paid cap', () => {
  it('allows 200 paid calls per UTC day, then none until the next day', () => {
    const c = new DailyCap(), day = Date.UTC(2026, 10, 1, 9);
    expect(Array.from({ length: 201 }, () => c.tryUse(day)).filter(Boolean)).toHaveLength(200);
    expect(c.tryUse(Date.UTC(2026, 10, 1, 23, 59))).toBe(false);
    expect(c.tryUse(Date.UTC(2026, 10, 2, 0, 1))).toBe(true);
  });
});

describe('rate limiting', () => {
  it('allows up to the limit in the window, then reports when to retry', () => {
    const lim = new SlidingWindowLimiter(3, 60_000);
    expect([0, 1, 2].map(t => lim.check('ip', 1000 + t).allowed)).toEqual([true, true, true]);
    const r = lim.check('ip', 2000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(1000 + 60_000 - 2000);
    expect(lim.check('ip', 1000 + 60_001).allowed).toBe(true);
    expect(lim.check('other-ip', 2000).allowed).toBe(true);
  });
  it('limits each IP to 5 a minute and 20 an hour; rejected requests are not counted', () => {
    const limit = reviewLimiters();
    const t0 = 1_000_000;
    expect(Array.from({ length: 6 }, () => limit('a', t0).allowed)).toEqual([true, true, true, true, true, false]);
    let allowed = 5;
    for (let m = 1; m < 60; m++) for (let k = 0; k < 6; k++) if (limit('a', t0 + m * 60_000).allowed) allowed++;
    expect(allowed).toBe(20);
  });
});

describe('cache key', () => {
  it('is the same for the same hand, different for a different hand, and ignores what the prompt leaves out', async () => {
    const k = await reviewKey(REQ);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(await reviewKey({ ...REQ })).toBe(k);
    expect(await reviewKey({ ...REQ, hand: REQ.hand.replace('folds', 'calls $0.20') })).not.toBe(k);
    expect(await reviewKey({ ...REQ, hand: REQ.hand.replace('[5c Kh]', '[9d 9h]') })).toBe(k); // practice-view cards are not sent
    expect(await reviewKey({ ...REQ, hand: REQ.hand.replace('wait what do I have', 'umm') })).toBe(k); // nor is table chat
  });
});

describe('POST /api/review handler', () => {
  const post = (body: unknown, ip = '1.2.3.4'): Request =>
    new Request('http://x/api/review', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip + ', 10.0.0.1' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const make = (over: Partial<Parameters<typeof createReviewHandler>[0]> = {}, calls: string[] = [], logs: Array<Record<string, unknown>> = []) =>
    createReviewHandler({ hasKey: () => true, limit: reviewLimiters(), call: () => mockCall({ [FREE_A.id]: JSON.stringify(GOOD) }, calls), cache: new ReviewCache(), paidCap: new DailyCap(), log: e => logs.push(e), ...over });

  it('without an API key: 503 and the built-in review', async () => {
    const res = await make({ hasKey: () => false })(post(REQ));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ fallback: true, reason: 'not_configured' });
  });
  it('rejects bad input with 400 before calling any model', async () => {
    const calls: string[] = [], h = make({}, calls);
    expect((await h(post('not json'))).status).toBe(400);
    expect((await h(post({ hand: 'x', decisions: [] }))).status).toBe(400);
    expect((await h(post({ ...REQ, hand: 'y'.repeat(9000) }))).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it('streams which model is asked, its output, then the validated review with the model name; logs free or paid', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const res = await make({}, [], logs)(post(REQ));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    let streamed = '';
    const tried: string[] = [];
    const out = await readReviewEvents(res, t => (streamed += t), m => tried.push(m));
    expect(out).toMatchObject({ review: GOOD, model: FREE_A.id, paid: false, cached: false });
    expect(out.attempts).toEqual([{ model: FREE_A.id, outcome: 'ok', ms: expect.any(Number) }]);
    expect(streamed).toBe(JSON.stringify(GOOD));
    expect(tried).toEqual([FREE_A.id]);
    expect(logs[0]).toMatchObject({ event: 'ai_review', outcome: 'ok', model: FREE_A.id, tier: 'free' });
  });
  it('answers the same hand from the cache: one model call, and repeats do not use up the rate limit', async () => {
    const calls: string[] = [], h = make({}, calls);
    expect((await readReviewEvents(await h(post(REQ, '7.7.7.7')))).cached).toBe(false);
    for (let i = 0; i < 10; i++) expect(await readReviewEvents(await h(post(REQ, '7.7.7.7')))).toMatchObject({ review: GOOD, model: FREE_A.id, cached: true });
    expect(calls).toHaveLength(1);
  });
  it('two requests for the same hand at the same time share one model call', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const slow: CallFn = async (spec, input) => { calls.push(spec.id); await gate; input.onText('x'); return { text: JSON.stringify(GOOD), finish: 'stop' }; };
    const h = make({ call: () => slow });
    const [a, b] = await Promise.all([h(post(REQ)), h(post(REQ))]);
    release();
    const [ra, rb] = await Promise.all([readReviewEvents(a), readReviewEvents(b)]);
    expect(ra.review).toEqual(GOOD);
    expect(rb.review).toEqual(GOOD);
    expect([ra.cached, rb.cached].sort()).toEqual([false, true]); // either one may start first
    expect(calls).toHaveLength(1);
  });
  it('sends a fallback event when no model gives a valid answer (and caches nothing)', async () => {
    const calls: string[] = [], h = make({ call: () => mockCall({ [FREE_A.id]: 'nope' }, calls) });
    expect(await readReviewEvents(await h(post(REQ)))).toMatchObject({ fallback: 'all_failed' });
    await readReviewEvents(await h(post(REQ)));
    expect(calls.filter(c => c === FREE_A.id)).toHaveLength(2);
  });
  it('rate-limits new hands by client IP (first x-forwarded-for entry): 429 with retry-after', async () => {
    const h = make();
    for (let i = 0; i < 5; i++) expect((await h(post({ ...REQ, hand: REQ.hand.replace('Sumer: folds', 'Sumer: folds #' + i) }, '9.9.9.9'))).status).toBe(200);
    const res = await h(post({ ...REQ, hand: REQ.hand.replace('Sumer: folds', 'Sumer: folds #6') }, '9.9.9.9'));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await res.json()).reason).toBe('rate_limited');
    expect((await h(post(REQ, '8.8.8.8'))).status).toBe(200);
  });
});
