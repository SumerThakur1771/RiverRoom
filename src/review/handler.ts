// The /api/review request handler, built from its dependencies so tests can run it with a
// mock model and a fresh limiter. api/review.ts wires in the real ones.
import type { LimitResult } from './rate-limit.js';
import { ReviewRequestSchema, runReview, type ModelFn } from './review.js';

export interface HandlerDeps {
  hasKey: () => boolean;
  limit: (ip: string) => LimitResult;
  model: () => ModelFn;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

/** Client IP as set by Vercel's edge (it overwrites x-forwarded-for, so a client cannot spoof it there). */
export function clientIp(request: Request): string {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || request.headers.get('x-real-ip') || 'unknown';
}

export function createReviewHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  return async request => {
    if (!deps.hasKey()) return json(503, { fallback: true, reason: 'not_configured' });
    const r = deps.limit(clientIp(request));
    if (!r.allowed) {
      const s = String(Math.ceil(r.retryAfterMs / 1000));
      return json(429, { fallback: true, reason: 'rate_limited', retryAfter: +s }, { 'retry-after': s });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { fallback: true, reason: 'bad_request', detail: 'body is not JSON' });
    }
    const parsed = ReviewRequestSchema.safeParse(body);
    if (!parsed.success) return json(400, { fallback: true, reason: 'bad_request', detail: parsed.error.issues.slice(0, 3).map(i => i.path.join('.') + ': ' + i.message).join('; ') });
    const model = deps.model(), req = parsed.data, enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown): void => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        const outcome = await runReview(model, req, text => send('delta', { text }), request.signal);
        if (outcome.ok) send('result', { review: outcome.review });
        else send('fallback', { reason: outcome.reason });
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  };
}

export { readReviewEvents } from './sse.js';
