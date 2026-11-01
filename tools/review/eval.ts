// Runs the 20-hand review eval and prints per-check rates, an overall score, and which model
// answered each hand (free or paid).
//
//   npx tsx tools/review/eval.ts --mock            a perfect mock (checks the eval pipeline itself)
//   npx tsx tools/review/eval.ts --mock-lazy       a mock that always says "good, no mistake"
//   npx tsx tools/review/eval.ts --mock-chain      the perfect mock, but the free models fail on some
//                                                  hands, so the chain falls through to the paid one
//   npx tsx tools/review/eval.ts --live <url>      the deployed endpoint (real models, real key)
//   add --out <file> to save the report, --min <score> to fail below a score.
import { readFileSync, writeFileSync } from 'node:fs';
import { ModelError, REVIEW_MODELS, runChain, type CallFn } from '../../src/review/openrouter';
import { DailyCap } from '../../src/review/rate-limit';
import { readReviewEvents } from '../../src/review/sse';
import type { EvalItem } from './make-eval-set';
import { scoreOne, summarize, type Checks } from './score';

const args = process.argv.slice(2), arg = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const items = JSON.parse(readFileSync(new URL('../../test/review-eval/hands.json', import.meta.url), 'utf8')) as EvalItem[];
const NAMES = ['', 'flop', 'turn', 'river'];

/** Mock models: answer from the reference (or lazily); in chain mode the free models fail on some hands. */
function mockCall(item: EvalItem, index: number, mode: string): CallFn {
  const e = item.expected;
  const answer = mode === 'mock-lazy' ? { grade: 'good', mistake: null, lesson: 'Keep playing solid hands.' }
    : { grade: e.grade, mistake: e.hasMistake ? `On the ${e.street === 0 ? 'cards before the flop' : e.street === -1 ? 'split' : NAMES[e.street!]} you made a costly choice.` : null, lesson: 'Compare the price with your chance to win.' };
  return async (spec, { onText }) => {
    if (mode === 'mock-chain') {
      if (spec.id === REVIEW_MODELS[0]!.id && index % 2 === 1) throw new ModelError('free model busy', 'rate_limited');
      if (spec.id === REVIEW_MODELS[1]!.id && index % 4 === 3) return { text: 'Here is my review: good job!', finish: 'stop' };
    }
    const t = JSON.stringify(answer);
    onText(t);
    return { text: t, finish: 'stop' };
  };
}

interface Row { answer: unknown; ms: number; note: string; model?: string; paid?: boolean; cached?: boolean; tried?: string }
const triedText = (a?: Array<{ model: string; outcome: string; ms: number }>): string | undefined =>
  a && a.length > 1 ? a.map(x => `${x.model.split('/')[1]}:${x.outcome}`).join(' > ') : undefined;

async function live(url: string, item: EvalItem): Promise<Row> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = Date.now();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item.request) });
    if (res.status === 429) { const wait = Number(res.headers.get('retry-after') || 30); console.log(`  rate limited, waiting ${wait}s`); await new Promise(r => setTimeout(r, (wait + 1) * 1000)); continue; }
    if (!res.ok) return { answer: null, ms: Date.now() - t0, note: `HTTP ${res.status} ${(await res.text()).slice(0, 120)}` };
    const out = await readReviewEvents(res);
    const tried = triedText(out.attempts);
    return { answer: out.review ?? null, ms: Date.now() - t0, note: out.fallback ? `fallback: ${out.fallback}` : '', ...(out.model ? { model: out.model, paid: !!out.paid, cached: !!out.cached } : {}), ...(tried ? { tried } : {}) };
  }
  return { answer: null, ms: 0, note: 'gave up after repeated rate limits' };
}

const mode = ['--mock', '--mock-lazy', '--mock-chain'].find(m => args.includes(m))?.slice(2) ?? (arg('--live') ? 'live' : '');
if (!mode) { console.error('choose --mock, --mock-lazy, --mock-chain or --live <url>'); process.exit(2); }
const lines: string[] = [`Review eval (${mode}${mode === 'live' ? ' ' + arg('--live') : ''}), ${items.length} hands, ${new Date().toISOString()}`];
const all: Checks[] = [], times: number[] = [], byModel = new Map<string, number>();
let free = 0, paid = 0, fallback = 0, cached = 0;
const cap = new DailyCap();
for (const [i, item] of items.entries()) {
  let row: Row;
  if (mode === 'live') {
    if (i > 0) await new Promise(r => setTimeout(r, 13_000)); // stay under 5 requests a minute per IP
    row = await live(arg('--live')!, item);
    times.push(row.ms);
  } else {
    const out = await runChain(mockCall(item, i, mode), item.request, { paidCap: cap });
    const tried = triedText(out.attempts);
    row = out.ok ? { answer: out.review, ms: 0, note: '', model: out.model, paid: out.paid, ...(tried ? { tried } : {}) } : { answer: null, ms: 0, note: 'fallback: ' + out.reason, ...(tried ? { tried } : {}) };
  }
  if (row.model) { byModel.set(row.model, (byModel.get(row.model) ?? 0) + 1); if (row.paid) paid++; else free++; if (row.cached) cached++; } else fallback++;
  const c = scoreOne(row.answer, item.expected);
  all.push(c);
  lines.push(`${item.id.padEnd(16)} expected ${item.expected.grade.padEnd(8)} got ${String((row.answer as { grade?: string } | null)?.grade ?? '-').padEnd(8)} valid=${c.valid} grade±1=${c.gradeClose} mistake=${c.mistakeAgrees} street=${c.streetNamed ?? 'n/a'}${row.ms ? ` ${row.ms}ms` : ''}${row.model ? ` by ${row.model} (${row.paid ? 'paid' : 'free'}${row.cached ? ', cached' : ''})` : ''}${row.note ? ' ' + row.note : ''}${row.tried ? ` [tried ${row.tried}]` : ''}`);
}
const s = summarize(all);
lines.push('', `schema-valid ${s.valid}/${s.n} · grade within one step ${s.gradeClose}/${s.n} · mistake flagged iff the coach found one ${s.mistakeAgrees}/${s.n} · street named ${s.streetNamed}/${s.streetN}`);
lines.push(`overall score (mean of all applicable checks): ${(100 * s.score).toFixed(1)}%`);
lines.push(`answered by: free models ${free}, paid model ${paid}, built-in fallback ${fallback}${cached ? ` (${cached} from the server cache)` : ''}; ${[...byModel].map(([m, n]) => `${m} ${n}`).join(', ') || 'no model'}`);
if (times.length) { const t = times.slice().sort((a, b) => a - b); lines.push(`response time (full stream) median ${t[Math.floor(t.length / 2)]} ms, max ${t[t.length - 1]} ms`); }
console.log(lines.join('\n'));
if (arg('--out')) writeFileSync(arg('--out')!, lines.join('\n') + '\n');
const min = arg('--min');
if (min && s.score < +min) { console.error(`score ${s.score.toFixed(3)} is below --min ${min}`); process.exit(1); }
