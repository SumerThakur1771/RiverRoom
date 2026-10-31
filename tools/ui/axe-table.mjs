// Accessibility check of the game screens Lighthouse does not see: Lighthouse audits the page
// as first loaded (the start screen); this runs axe-core (the engine Lighthouse uses) on the
// table during a hand, on the hint panel, and on the end-of-hand review.
//
// Usage: node tools/ui/axe-table.mjs [url=http://localhost:4173/]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'http://localhost:4173/';
const axeSrc = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const browser = await chromium.launch();
const results = [];
for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => localStorage.setItem('river-room-v2', JSON.stringify({ mode: 'home', games: 'holdem', pace: 'fast', review: 'on', sound: false, timer: 0, holdResult: true, revealAll: false, hints: true })));
  const page = await ctx.newPage();
  await page.goto(URL_ + '?seed=axe');
  const audit = async (state) => {
    await page.addScriptTag({ content: axeSrc });
    const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
    results.push({ label, state, violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, example: v.nodes[0]?.target.join(' ') })) , passes: r.passes.length });
  };
  await page.click('#startBtn');
  await page.waitForSelector('#act:not([hidden])', { timeout: 60_000 });
  await audit('table, your turn');
  await page.click('#hintBtn');
  await page.waitForSelector('#hint:not([hidden])', { timeout: 20_000 });
  await audit('hint open');
  await page.click('#hintBtn');
  // play on (check or call) until the end-of-hand review appears
  for (let i = 0; i < 400 && !(await page.isVisible('#revOv')); i++) {
    if (await page.isVisible('#act')) await page.click('#bCall').catch(() => {});
    if (await page.isVisible('#contRow')) await page.click('#contBtn').catch(() => {});
    await page.waitForTimeout(150);
  }
  if (await page.isVisible('#revOv')) await audit('hand review');
  await ctx.close();
}
await browser.close();
let total = 0;
for (const r of results) {
  total += r.violations.length;
  console.log(`${r.label} / ${r.state}: ${r.passes} rules passed, ${r.violations.length} violations${r.violations.map(v => `\n  ${v.id} (${v.impact}, ${v.nodes} elements, e.g. ${v.example})`).join('')}`);
}
console.log(`screens audited: ${results.length}; violations: ${total}`);
process.exit(total ? 1 : 0);
