// Runs the 20-hand review eval and prints per-check rates and an overall score.
//
//   npx tsx tools/review/eval.ts --mock            a perfect mock (checks the eval pipeline itself)
//   npx tsx tools/review/eval.ts --mock-lazy       a mock that always says "good, no mistake"
//   npx tsx tools/review/eval.ts --live <url>      the deployed endpoint (real model, real key)
//   add --out <file> to save the report, --min <score> to fail below a score.
import { readFileSync, writeFileSync } from 'node:fs';
import { readReviewEvents } from '../../src/review/sse';
import { runReview, type ModelFn } from '../../src/review/review';
import type { EvalItem } from './make-eval-set';
import { scoreOne, summarize, type Checks } from './score';

const args = process.argv.slice(2), arg = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const items = JSON.parse(readFileSync(new URL('../../test/review-eval/hands.json', import.meta.url), 'utf8')) as EvalItem[];
const NAMES = ['', 'flop', 'turn', 'river'];

function mockFor(item: EvalItem, lazy: boolean): ModelFn {
  const e = item.expected;
  const answer = lazy ? { grade: 'good', mistake: null, lesson: 'Keep playing solid hands.' }
    : { grade: e.grade, mistake: e.hasMistake ? `On the ${e.street === 0 ? 'cards before the flop' : e.street === -1 ? 'split' : NAMES[e.street!]} you made a costly choice.` : null, lesson: 'Compare the price with your chance to win.' };
  return async ({ onText }) => { const t = JSON.stringify(answer); onText(t); return { text: t, stopReason: 'end_turn' }; };
}

async function live(url: string, item: EvalItem): Promise<{ answer: unknown; ms: number; note: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = Date.now();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item.request) });
    if (res.status === 429) { const wait = Number(res.headers.get('retry-after') || 30); console.log(`  rate limited, waiting ${wait}s`); await new Promise(r => setTimeout(r, (wait + 1) * 1000)); continue; }
    if (!res.ok) return { answer: null, ms: Date.now() - t0, note: `HTTP ${res.status} ${(await res.text()).slice(0, 120)}` };
    const out = await readReviewEvents(res);
    return { answer: out.review ?? null, ms: Date.now() - t0, note: out.fallback ? `fallback: ${out.fallback}` : '' };
  }
  return { answer: null, ms: 0, note: 'gave up after repeated rate limits' };
}

const mode = args.includes('--mock') ? 'mock' : args.includes('--mock-lazy') ? 'mock-lazy' : arg('--live') ? 'live' : '';
if (!mode) { console.error('choose --mock, --mock-lazy or --live <url>'); process.exit(2); }
const lines: string[] = [`Review eval (${mode}${mode === 'live' ? ' ' + arg('--live') : ''}), ${items.length} hands, ${new Date().toISOString()}`];
const all: Checks[] = [], times: number[] = [];
for (const [i, item] of items.entries()) {
  let answer: unknown, note: string, ms = 0;
  if (mode === 'live') {
    if (i > 0) await new Promise(r => setTimeout(r, 13_000)); // stay under 5 requests a minute per IP
    ({ answer, ms, note } = await live(arg('--live')!, item));
    times.push(ms);
  } else {
    const out = await runReview(mockFor(item, mode === 'mock-lazy'), item.request);
    answer = out.ok ? out.review : null;
    note = out.ok ? '' : 'fallback: ' + out.reason;
  }
  const c = scoreOne(answer, item.expected);
  all.push(c);
  lines.push(`${item.id.padEnd(16)} expected ${item.expected.grade.padEnd(8)} got ${String((answer as { grade?: string } | null)?.grade ?? '-').padEnd(8)} valid=${c.valid} grade±1=${c.gradeClose} mistake=${c.mistakeAgrees} street=${c.streetNamed ?? 'n/a'}${ms ? ` ${ms}ms` : ''}${note ? ' ' + note : ''}`);
}
const s = summarize(all);
lines.push('', `schema-valid ${s.valid}/${s.n} · grade within one step ${s.gradeClose}/${s.n} · mistake flagged iff the coach found one ${s.mistakeAgrees}/${s.n} · street named ${s.streetNamed}/${s.streetN}`);
lines.push(`overall score (mean of all applicable checks): ${(100 * s.score).toFixed(1)}%`);
if (times.length) { const t = times.slice().sort((a, b) => a - b); lines.push(`response time (full stream) median ${t[Math.floor(t.length / 2)]} ms, max ${t[t.length - 1]} ms`); }
console.log(lines.join('\n'));
if (arg('--out')) writeFileSync(arg('--out')!, lines.join('\n') + '\n');
const min = arg('--min');
if (min && s.score < +min) { console.error(`score ${s.score.toFixed(3)} is below --min ${min}`); process.exit(1); }
