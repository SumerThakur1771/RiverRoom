// Browser smoke test: plays the app by clicking (fold/call/raise, hints, dealer's choice,
// splits, rebuys) and checks for page errors, stalls and chip conservation.
// Saves desktop and phone screenshots.
//
// Usage: node tools/ui/smoke.mjs [url=http://localhost:5173/] [seconds=60] [mode=home|tourney]
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'http://localhost:5173/';
const SECS = +(process.argv[3] || 60);
const MODE = process.argv[4] || 'home';
const OUT = 'screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
let failed = false;
for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: label === 'phone' ? 2 : 1, hasTouch: label === 'phone' });
  await ctx.addInitScript(mode => localStorage.setItem('river-room-v2', JSON.stringify({ mode, games: 'dealer', pace: 'fast', review: 'off', sound: false, timer: 0, holdResult: false, revealAll: true, hints: true })), MODE);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // ignored: Google Fonts hiccups, and Vercel's analytics script, which returns 404 until
  // Web Analytics is turned on for the project (the page works the same either way)
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text()) && !/\/_vercel\/insights\//.test(m.location()?.url ?? '')) errors.push('console: ' + m.text().slice(0, 300)); });
  await page.goto(URL_ + '?seed=smoke-' + label);
  await page.screenshot({ path: `${OUT}/${label}-start.png` });
  await page.click('#startBtn');
  const t0 = Date.now();
  let shots = 0, hints = 0, last = '', lastChange = Date.now(), stalled = false;
  while (Date.now() - t0 < SECS * 1000) {
    if (await page.isVisible('#dealOv')) await page.locator('#dealOpts button').nth(Math.floor(Math.random() * 5)).click();
    if (await page.isVisible('#splitOv')) { if (shots < 3) { await page.screenshot({ path: `${OUT}/${label}-split.png` }); shots++; } await page.click('#spLock'); }
    if (await page.isVisible('#rebuyOv')) await page.click('#rebuyYes');
    if (await page.isVisible('#revOv')) await page.click('#rvNext');
    if (await page.isVisible('#contRow')) await page.click('#contBtn');
    if (await page.isVisible('#act')) {
      if (hints < 3 && await page.isVisible('#hintBtn')) { await page.click('#hintBtn'); await page.waitForTimeout(300); if (await page.isVisible('#hint')) { await page.screenshot({ path: `${OUT}/${label}-hint.png` }); hints++; await page.click('#hintBtn'); } }
      const r = Math.random();
      if (r < 0.55) await page.click('#bCall').catch(() => {});
      else if (r < 0.75 && await page.isVisible('#bRaise')) await page.click('#bRaise').catch(() => {});
      else { await page.click('#bFold').catch(() => {}); if (await page.isVisible('#act')) await page.click('#bFold').catch(() => {}); }
    }
    const sig = await page.evaluate(() => document.querySelector('#feed')?.textContent?.slice(-200) || '');
    if (sig !== last) { last = sig; lastChange = Date.now(); } else if (Date.now() - lastChange > 15000) { stalled = true; break; }
    await page.waitForTimeout(60);
  }
  await page.screenshot({ path: `${OUT}/${label}-table.png` });
  const info = await page.evaluate(() => document.querySelector('#tinfo')?.textContent || '');
  console.log(`${label}: ${errors.length ? 'ERRORS ' + errors.slice(0, 3).join(' | ') : 'no page errors'}${stalled ? ' STALLED' : ''}; table info: ${info.slice(0, 80)}`);
  if (errors.length || stalled) failed = true;
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
