// Browser test for play-with-friends: two players (desktop and phone sizes) at one table,
// against a running server. One creates a table, the other joins with the code, both play by
// clicking; then the first reloads the page mid-game and must get the same seat back.
//
// Usage: node tools/ui/mp-smoke.mjs <page url, e.g. http://localhost:4173/mp.html> [hands=3]
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'http://localhost:4173/mp.html';
const HANDS = +(process.argv[3] || 3);
mkdirSync('screenshots', { recursive: true });
const browser = await chromium.launch();
const errors = [];
async function player(label, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: label === 'phone' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
  return page;
}
const a = await player('desktop', { width: 1100, height: 800 }), b = await player('phone', { width: 390, height: 844 });
await a.goto(URL_);
await a.fill('#name', 'Ana');
await a.click('#create');
await a.waitForSelector('#table:not([hidden])');
const code = (await a.textContent('#tcode')).trim();
await b.goto(URL_ + '?code=' + code);
await b.fill('#name', 'Ben');
await b.click('#join');
await b.waitForSelector('#table:not([hidden])');

async function playUntil(n) {
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < 120_000) {
    for (const p of [a, b]) {
      if (await p.isVisible('#rebuy')) await p.click('#rebuyYes');
      if (await p.isVisible('#actions')) await p.click(Math.random() < 0.7 ? '#call' : '#fold').catch(() => {});
    }
    seen = await a.evaluate(() => document.querySelectorAll('#log li').length);
    const hands = await a.evaluate(() => new Set([...document.querySelectorAll('#log li')].filter(li => /posts \$0\.10/.test(li.textContent)).map((_, i) => i)).size);
    if (hands >= n) return hands;
    await a.waitForTimeout(150);
  }
  throw new Error('hands did not progress; log lines: ' + seen);
}
const played = await playUntil(HANDS);
const mine = async p => (await p.$$eval('#mine .card', els => els.map(e => e.getAttribute('aria-label'))));
await a.screenshot({ path: 'screenshots/mp-desktop.png' });
await b.screenshot({ path: 'screenshots/mp-phone.png' });
// reload mid-game: the saved session token puts Ana back in her seat
const before = await a.evaluate(() => document.querySelector('.seat .nm')?.textContent);
await a.reload();
await a.waitForSelector('#table:not([hidden])', { timeout: 10_000 });
const after = await a.evaluate(() => document.querySelector('.seat .nm')?.textContent);
const sameCode = (await a.textContent('#tcode')).trim() === code;
const seatsSeen = await b.$$eval('.seat .nm', els => els.map(e => e.textContent));
console.log(`table ${code}: ${played} hands played; Ana after reload: "${after}" (before "${before}"), same table: ${sameCode}; Ben sees seats: ${seatsSeen.join(' | ')}; Ben's own cards now: ${(await mine(b)).join(', ') || '(between hands)'}`);
const ok = !errors.length && sameCode && after === before && seatsSeen.some(s => s.startsWith('Ana')) && seatsSeen.some(s => s.startsWith('Ben (you)'));
console.log(ok ? 'RESULT: ok' : 'RESULT: FAIL ' + errors.slice(0, 5).join(' | '));
await browser.close();
process.exit(ok ? 0 : 1);
