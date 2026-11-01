// Cache key for a review: SHA-256 of the prompt version plus the exact text the model would
// see. The server and the browser compute it the same way (Web Crypto exists in both), so a
// hand that was already reviewed is answered from a cache instead of calling a model again.
import { buildUserMessage, PROMPT_VERSION } from './prompt.js';
import type { ReviewRequest } from './review.js';

export async function reviewKey(req: ReviewRequest): Promise<string> {
  const bytes = new TextEncoder().encode(PROMPT_VERSION + '\n' + buildUserMessage(req));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
