// Checks the review's model chain against OpenRouter's public model list (no key needed):
// every model exists, models marked free cost nothing and the paid one has a price, and
// json_schema is only sent to models that list structured-output support. Prints each model's
// prices and parameters (as GitHub annotations in CI) and fails on any mismatch.
// Usage: npx tsx tools/review/check-models.ts
import { appendFileSync } from 'node:fs';
import { REVIEW_MODELS } from '../../src/review/openrouter';

interface OrModel { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }

const res = await fetch('https://openrouter.ai/api/v1/models');
if (!res.ok) { console.error(`OpenRouter model list: HTTP ${res.status}`); process.exit(1); }
const list = ((await res.json()) as { data: OrModel[] }).data;
const byId = new Map(list.map(m => [m.id, m]));
const problems: string[] = [], rows: string[] = [];
for (const spec of REVIEW_MODELS) {
  const m = byId.get(spec.id);
  if (!m) { problems.push(`${spec.id}: not in OpenRouter's model list`); continue; }
  const pIn = Number(m.pricing?.prompt ?? NaN), pOut = Number(m.pricing?.completion ?? NaN);
  const params = m.supported_parameters ?? [];
  const structured = params.includes('structured_outputs');
  const isFree = pIn === 0 && pOut === 0;
  if (spec.paid === isFree) problems.push(`${spec.id}: marked ${spec.paid ? 'paid' : 'free'} but OpenRouter prices it at ${pIn}/${pOut} per token`);
  if (spec.jsonSchema && !structured) problems.push(`${spec.id}: json_schema is sent, but the model does not list structured_outputs`);
  if (!spec.jsonSchema && structured) problems.push(`${spec.id}: supports structured_outputs, but json_schema is not sent (set jsonSchema: true)`);
  if (spec.reasoning && !params.includes('reasoning')) problems.push(`${spec.id}: reasoning settings are sent, but the model does not list reasoning`);
  const row = `${spec.id}: $${(pIn * 1e6).toFixed(3)} / $${(pOut * 1e6).toFixed(3)} per million input/output tokens; context ${m.context_length}; structured_outputs ${structured ? 'yes' : 'no'}, response_format ${params.includes('response_format') ? 'yes' : 'no'}, reasoning ${params.includes('reasoning') ? 'yes' : 'no'}, max_tokens ${params.includes('max_tokens') ? 'yes' : 'no'}`;
  rows.push(row);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=OpenRouter model ${spec.id}::${row}`);
}
console.log(rows.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Review models on OpenRouter\n\n${rows.map(r => '- ' + r).join('\n')}\n${problems.map(p => '- PROBLEM: ' + p).join('\n')}\n`);
for (const p of problems) console.log(process.env.GITHUB_ACTIONS ? `::error title=Review model check::${p}` : 'PROBLEM: ' + p);
process.exit(problems.length ? 1 : 0);
