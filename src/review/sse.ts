// Reads /api/review's server-sent events. Kept separate from the handler so the page can use
// it without pulling the Anthropic SDK into the browser bundle.
/** Read the handler's server-sent events (used by the page, the eval and tests). */
export async function readReviewEvents(res: Response, onDelta?: (text: string) => void): Promise<{ review?: unknown; fallback?: string }> {
  if (!res.body) return { fallback: 'no_body' };
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const out: { review?: unknown; fallback?: string } = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(chunk)?.[1], data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (!ev || !data) continue;
      const d = JSON.parse(data) as { text?: string; review?: unknown; reason?: string };
      if (ev === 'delta' && d.text) onDelta?.(d.text);
      else if (ev === 'result') out.review = d.review;
      else if (ev === 'fallback') out.fallback = d.reason;
    }
    if (done) break;
  }
  return out;
}
