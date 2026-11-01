// The model side of the AI review: OpenRouter's OpenAI-compatible chat completions API, called
// with plain fetch (no SDK), and a chain of models tried in order, free ones first.
//
// A model is skipped for the next one on an HTTP error, a rate limit, a timeout, a cut-off or
// filtered answer, or an answer that is not valid JSON matching ReviewSchema. The paid model
// at the end of the chain is only called while today's paid budget lasts.
import type { DailyCap } from './rate-limit.js';
import { buildUserMessage, SYSTEM_PROMPT } from './prompt.js';
import { parseReview, REVIEW_JSON_SCHEMA, type FallbackReason, type Review, type ReviewRequest } from './review.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface ModelSpec {
  id: string;
  /** Paid models count against the daily paid cap. */
  paid: boolean;
  /**
   * How to ask for JSON: 'schema' = response_format json_schema (models with structured
   * outputs), 'object' = json_object (valid JSON, shape from the prompt), 'none' = prompt only.
   * Every answer is validated with zod either way. tools/review/check-models.ts checks these
   * against OpenRouter's model list.
   */
  json: 'schema' | 'object' | 'none';
  /** Reasoning model: ask for low effort and keep the reasoning out of the reply. */
  reasoning?: boolean;
}

/**
 * Free models the review can use. The chain's second slot was meant to be
 * openai/gpt-oss-20b:free, which OpenRouter no longer offers for free (checked by
 * tools/review/check-models.ts on 2026-11-01), so it goes to a free model from a different
 * provider than the first, so that one provider's outage or rate limit does not take out both.
 */
export const GEMMA_26B: ModelSpec = { id: 'google/gemma-4-26b-a4b-it:free', paid: false, json: 'object' };
export const NEMOTRON: ModelSpec = { id: 'nvidia/nemotron-3.5-super-vl:free', paid: false, json: 'schema', reasoning: true };
export const GEMMA_31B: ModelSpec = { id: 'google/gemma-4-31b-it:free', paid: false, json: 'object' };
export const GEMINI_FLASH_LITE: ModelSpec = { id: 'google/gemini-2.5-flash-lite', paid: true, json: 'schema' };
/** Free models a request may ask for on their own (for the eval); never a paid one. */
export const FREE_CANDIDATES: readonly ModelSpec[] = [GEMMA_26B, NEMOTRON, GEMMA_31B];

/** Free first; the paid model is the last resort. */
export const REVIEW_MODELS: readonly ModelSpec[] = [GEMMA_26B, NEMOTRON, GEMINI_FLASH_LITE];
/** A review is three short fields; this leaves room without paying for rambling. */
export const REVIEW_MAX_TOKENS = 500;
/** Per model: after this, move on to the next one. */
export const ATTEMPT_TIMEOUT_MS = 20_000;

export interface Usage { prompt_tokens?: number; completion_tokens?: number; cost?: number }
export interface AttemptResult { text: string; finish: string | null; usage?: Usage; servedBy?: string }
export interface CallInput { system: string; user: string; onText: (delta: string) => void; signal?: AbortSignal }
/** One model call. The real one is openRouterCall(); tests and the eval pass mocks. */
export type CallFn = (spec: ModelSpec, input: CallInput) => Promise<AttemptResult>;

export class ModelError extends Error {
  constructor(message: string, readonly kind: 'rate_limited' | 'model_error' | 'timeout', readonly status?: number) {
    super(message);
  }
}

interface Chunk {
  model?: string;
  error?: { code?: number | string; message?: string };
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: Usage;
}

export interface OpenRouterOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Sent as HTTP-Referer / X-Title so OpenRouter can attribute the app. */
  referer?: string;
}

/** The real model call: streaming chat completion over plain fetch. */
export function openRouterCall(opts: OpenRouterOptions): CallFn {
  const doFetch = opts.fetch ?? fetch;
  return async (spec, { system, user, onText, signal }) => {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS);
    const onAbort = (): void => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const body: Record<string, unknown> = {
        model: spec.id,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: REVIEW_MAX_TOKENS,
        temperature: 0.2,
        stream: true,
        usage: { include: true },
      };
      if (spec.json === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: 'hand_review', strict: true, schema: REVIEW_JSON_SCHEMA } };
      else if (spec.json === 'object') body.response_format = { type: 'json_object' };
      if (spec.reasoning) body.reasoning = { effort: 'low', exclude: true };
      const res = await doFetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          'http-referer': opts.referer ?? 'https://sumer-riverroom.vercel.app',
          'x-title': 'River Room',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        const msg = `HTTP ${res.status}: ${err?.error?.message ?? res.statusText}`.slice(0, 200);
        throw new ModelError(msg, res.status === 429 ? 'rate_limited' : 'model_error', res.status);
      }
      return await readStream(res.body, onText);
    } catch (err) {
      if (err instanceof ModelError) throw err;
      if (timedOut) throw new ModelError(`no complete answer in ${opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS} ms`, 'timeout');
      throw new ModelError(err instanceof Error ? err.message.slice(0, 200) : 'network error', 'model_error');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

/** Read OpenRouter's server-sent events: content deltas, then usage, then [DONE]. Comment lines are keep-alives. */
async function readStream(body: ReadableStream<Uint8Array>, onText: (delta: string) => void): Promise<AttemptResult> {
  const reader = body.getReader(), dec = new TextDecoder();
  const out: AttemptResult = { text: '', finish: null };
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue; // blank lines and ": OPENROUTER PROCESSING" comments
      const data = line.slice(5).trim();
      if (data === '[DONE]') return out;
      let c: Chunk;
      try { c = JSON.parse(data) as Chunk; } catch { continue; }
      if (c.error) throw new ModelError(`stream error: ${c.error.message ?? c.error.code}`.slice(0, 200), String(c.error.code) === '429' ? 'rate_limited' : 'model_error');
      if (c.model) out.servedBy = c.model;
      if (c.usage) out.usage = c.usage;
      const ch = c.choices?.[0];
      const delta = ch?.delta?.content;
      if (delta) { out.text += delta; onText(delta); }
      if (ch?.finish_reason) out.finish = ch.finish_reason;
    }
    if (done) return out;
  }
}

export interface Attempt { model: string; paid: boolean; outcome: 'ok' | FallbackReason; ms: number; detail?: string }
export type ChainOutcome =
  | { ok: true; review: Review; model: string; paid: boolean; attempts: Attempt[]; usage?: Usage }
  | { ok: false; reason: FallbackReason; attempts: Attempt[] };

export interface ChainOptions {
  models?: readonly ModelSpec[];
  paidCap: DailyCap;
  onAttempt?: (spec: ModelSpec) => void;
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  now?: () => number;
}

/** Try each model in order until one returns a valid review. Never throws. */
export async function runChain(call: CallFn, req: ReviewRequest, opts: ChainOptions): Promise<ChainOutcome> {
  const models = opts.models ?? REVIEW_MODELS, now = opts.now ?? Date.now, attempts: Attempt[] = [];
  const user = buildUserMessage(req);
  for (const spec of models) {
    if (opts.signal?.aborted) break;
    if (spec.paid && !opts.paidCap.tryUse(now())) {
      attempts.push({ model: spec.id, paid: true, outcome: 'paid_cap', ms: 0 });
      continue;
    }
    opts.onAttempt?.(spec);
    const t0 = now();
    const done = (outcome: Attempt['outcome'], detail?: string): void => { attempts.push({ model: spec.id, paid: spec.paid, outcome, ms: now() - t0, ...(detail ? { detail } : {}) }); };
    let res: AttemptResult;
    try {
      res = await call(spec, { system: SYSTEM_PROMPT, user, onText: opts.onText ?? (() => {}), signal: opts.signal });
    } catch (err) {
      done(err instanceof ModelError ? err.kind : 'model_error', err instanceof Error ? err.message : undefined);
      continue;
    }
    if (res.finish === 'length') { done('truncated'); continue; }
    if (res.finish === 'content_filter') { done('refused'); continue; }
    const parsed = parseReview(res.text);
    if (!parsed.ok) { done(parsed.reason, parsed.detail); continue; }
    done('ok');
    return { ok: true, review: parsed.review, model: spec.id, paid: spec.paid, attempts, ...(res.usage ? { usage: res.usage } : {}) };
  }
  const tried = attempts.filter(a => a.outcome !== 'paid_cap');
  const reason: FallbackReason = attempts.some(a => a.outcome === 'paid_cap') ? 'paid_cap' : tried.length === 1 ? (tried[0]!.outcome as FallbackReason) : 'all_failed';
  return { ok: false, reason, attempts };
}
