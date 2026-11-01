// Prompt size on the 20-hand eval set: characters sent to the model per review (system prompt
// plus the user message). Tokens depend on each model's tokenizer; live token counts come from
// OpenRouter's usage numbers in the live eval.
// Usage: npx tsx tools/review/prompt-size.ts
import { readFileSync } from 'node:fs';
import { buildUserMessage, SYSTEM_PROMPT } from '../../src/review/prompt';
import type { EvalItem } from './make-eval-set';

const items = JSON.parse(readFileSync(new URL('../../test/review-eval/hands.json', import.meta.url), 'utf8')) as EvalItem[];
const sizes = items.map(h => SYSTEM_PROMPT.length + buildUserMessage(h.request).length);
const sum = sizes.reduce((a, b) => a + b, 0);
console.log(`prompt (system + user), ${items.length} eval hands: total ${sum} chars, mean ${(sum / sizes.length).toFixed(0)}, min ${Math.min(...sizes)}, max ${Math.max(...sizes)}; system prompt ${SYSTEM_PROMPT.length} chars`);
