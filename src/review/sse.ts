// Reads /api/review's server-sent events. Kept separate from the handler so the page can use
// it without pulling server code into the browser bundle.
export interface ReviewEvents {
  review?: unknown;
  /** Which model answered, and whether it was a paid one. */
  model?: string;
  paid?: boolean;
  /** Answered from the server's cache (no model call). */
  cached?: boolean;
  fallback?: string;
}

/** Read the handler's server-sent events (used by the page, the eval and tests). */
export async function readReviewEvents(res: Response, onDelta?: (text: string) => void, onAttempt?: (model: string, paid: boolean) => void): Promise<ReviewEvents> {
  if (!res.body) return { fallback: 'no_body' };
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const out: ReviewEvents = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(chunk)?.[1], data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (!ev || !data) continue;
      const d = JSON.parse(data) as { text?: string; review?: unknown; reason?: string; model?: string; paid?: boolean; cached?: boolean };
      if (ev === 'delta' && d.text) onDelta?.(d.text);
      else if (ev === 'attempt' && d.model) onAttempt?.(d.model, !!d.paid);
      else if (ev === 'result') Object.assign(out, { review: d.review, model: d.model, paid: d.paid, cached: d.cached });
      else if (ev === 'fallback') out.fallback = d.reason;
    }
    if (done) break;
  }
  return out;
}
