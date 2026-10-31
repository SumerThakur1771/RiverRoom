// Lighthouse (mobile, default throttling) on both pages, several runs each. Saves every JSON
// report, prints a table (also to the GitHub step summary in CI) and fails if any
// accessibility score is below the minimum.
//
// Usage: node tools/measure/lighthouse.mjs <base url> <output dir> [runs=3] [min accessibility=95]
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const [base = 'http://localhost:4173/', out = 'lighthouse', runs = '3', min = '95'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const env = { ...process.env, CHROME_PATH: process.env.CHROME_PATH || chromium.executablePath() };
const rows = [];
let low = false;
for (const page of ['', 'mp.html']) {
  const name = page.replace('.html', '') || 'index';
  for (let i = 1; i <= +runs; i++) {
    const file = `${out}/${name}-${i}.json`;
    const r = spawnSync('npx', ['lighthouse', base + page, '--quiet', '--chrome-flags=--headless=new --no-sandbox',
      '--only-categories=performance,accessibility,best-practices,seo', '--output=json', `--output-path=${file}`], { env, stdio: 'inherit' });
    if (r.status !== 0) { console.error(`lighthouse failed on ${base + page}`); process.exit(1); }
    const rep = JSON.parse(readFileSync(file, 'utf8'));
    const s = k => Math.round(rep.categories[k].score * 100);
    if (s('accessibility') < +min) low = true;
    rows.push(`| ${base + page} | ${i} | ${s('performance')} | ${s('accessibility')} | ${s('best-practices')} | ${s('seo')} | ${rep.lighthouseVersion} |`);
  }
}
const table = ['| Page | Run | Performance | Accessibility | Best practices | SEO | Lighthouse |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Lighthouse (mobile)\n\n${table}\n`);
if (low) { console.error(`accessibility below ${min} on at least one run`); process.exit(1); }
