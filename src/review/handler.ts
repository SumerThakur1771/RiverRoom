// The /api/review request handler, built from its dependencies so tests can run it with mock
// models, a fresh limiter and a fresh cache. api/review.ts wires in the real ones.
//
// Order of checks: key configured -> valid input -> cache (no model call, no rate limit) ->
// same hand already being reviewed (share that call) -> per-IP rate limit -> model chain.
import type { ReviewCache } from './cache.js';
import { reviewKey } from './key.js';
import { FREE_CANDIDATES, runChain, type CallFn, type ChainOutcome, type ModelSpec } from './openrouter.js';
import type { DailyCap, LimitResult } from './rate-limit.js';
import { ReviewRequestSchema } from './review.js';

export interface HandlerDeps {
  hasKey: () => boolean;
  limit: (ip: string) => LimitResult;
  call: () => CallFn;
  cache: ReviewCache;
  paidCap: DailyCap;
  models?: readonly ModelSpec[];
  /** One line per review (which model answered, free or paid); console.log in production. */
  log?: (entry: Record<string, unknown>) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

/** Client IP as set by Vercel's edge (it overwrites x-forwarded-for, so a client cannot spoof it there). */
export function clientIp(request: Request): string {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || request.headers.get('x-real-ip') || 'unknown';
}

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' };

export function createReviewHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? (e => console.log(JSON.stringify(e)));
  return async request => {
    if (!deps.hasKey()) return json(503, { fallback: true, reason: 'not_configured' });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { fallback: true, reason: 'bad_request', detail: 'body is not JSON' });
    }
    const parsed = ReviewRequestSchema.safeParse(body);
    if (!parsed.success) return json(400, { fallback: true, reason: 'bad_request', detail: parsed.error.issues.slice(0, 3).map(i => i.path.join('.') + ': ' + i.message).join('; ') });
    const req = parsed.data;
    // eval only: one free model on its own; a paid or unknown model is refused
    const only = req.model ? FREE_CANDIDATES.find(m => m.id === req.model) : undefined;
    if (req.model && !only) return json(400, { fallback: true, reason: 'bad_request', detail: 'model must be one of the free candidates' });
    const key = await reviewKey(req), enc = new TextEncoder(), t0 = Date.now();
    const sse = (run: (send: (event: string, data: unknown) => void) => Promise<void>): Response =>
      new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          await run((event, data) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)));
          controller.close();
        },
      }), { headers: SSE_HEADERS });
    const finish = (send: (event: string, data: unknown) => void, out: ChainOutcome, shared: boolean): void => {
      // which models were tried and why the chain moved on (no prompt or key details)
      const attempts = shared ? [] : out.attempts.map(a => ({ model: a.model, outcome: a.outcome, ms: a.ms }));
      if (out.ok) send('result', { review: out.review, model: out.model, paid: out.paid, cached: shared, attempts });
      else send('fallback', { reason: out.reason, attempts });
    };

    // 1. already reviewed: no model call
    const hit = deps.cache.get(key);
    if (hit) {
      log({ event: 'ai_review', key: key.slice(0, 12), outcome: 'cache', model: hit.model, tier: hit.paid ? 'paid' : 'free', ms: Date.now() - t0 });
      return sse(async send => send('result', { ...hit, cached: true }));
    }
    // 2. the same hand is being reviewed right now: wait for that call instead of making another
    const running = deps.cache.inFlight(key);
    if (running) return sse(async send => finish(send, await running, true));

    // 3. new hand: rate limit, then the model chain
    const r = deps.limit(clientIp(request));
    if (!r.allowed) {
      const s = String(Math.ceil(r.retryAfterMs / 1000));
      return json(429, { fallback: true, reason: 'rate_limited', retryAfter: +s }, { 'retry-after': s });
    }
    const call = deps.call();
    return sse(async send => {
      const work = runChain(call, req, {
        ...(only ? { models: [only] } : deps.models ? { models: deps.models } : {}),
        paidCap: deps.paidCap,
        onAttempt: spec => send('attempt', { model: spec.id, paid: spec.paid }),
        onText: text => send('delta', { text }),
        signal: request.signal,
      });
      const out = await deps.cache.track(key, work);
      log({
        event: 'ai_review', key: key.slice(0, 12), outcome: out.ok ? 'ok' : out.reason,
        model: out.ok ? out.model : null, tier: out.ok ? (out.paid ? 'paid' : 'free') : null,
        ms: Date.now() - t0, attempts: out.attempts, ...(out.ok && out.usage ? { usage: out.usage } : {}),
        paidUsedToday: deps.paidCap.used(),
      });
      finish(send, out, false);
    });
  };
}

export { readReviewEvents } from './sse.js';
