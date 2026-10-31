// Offline test for the installable app: open the production build once (the service worker
// caches the app), cut the network, reload, and play single-player hands with no network.
// Also checks the manifest and that the multiplayer page still opens offline.
//
// Usage: node tools/ui/offline.mjs [url=http://localhost:4173/] [seconds=60]
// Passes when at least one full hand (deal to showdown or fold) finishes with no network.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'http://localhost:4173/';
const SECS = +(process.argv[3] || 60);
mkdirSync('screenshots', { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
await ctx.addInitScript(() => localStorage.setItem('river-room-v2', JSON.stringify({ mode: 'home', games: 'dealer', pace: 'fast', review: 'off', sound: false, timer: 0, holdResult: false, revealAll: true, hints: true })));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

// 1. online visit: wait until the service worker controls the page
await page.goto(URL_);
const manifest = await page.evaluate(async () => {
  const href = document.querySelector('link[rel=manifest]')?.getAttribute('href');
  return href ? (await fetch(href)).json() : null;
});
await page.evaluate(() => navigator.serviceWorker.ready);
if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async k => (await (await caches.open(k)).keys()).length))).reduce((a, b) => a + b, 0));

// 2. no network: reload and play
await ctx.setOffline(true);
await page.reload();
const loaded = await page.isVisible('#startBtn');
await page.click('#startBtn');
const t0 = Date.now();
while (Date.now() - t0 < SECS * 1000) {
  if (await page.isVisible('#dealOv')) await page.locator('#dealOpts button').first().click();
  if (await page.isVisible('#splitOv')) await page.click('#spLock');
  if (await page.isVisible('#rebuyOv')) await page.click('#rebuyYes');
  if (await page.isVisible('#revOv')) await page.click('#rvNext');
  if (await page.isVisible('#contRow')) await page.click('#contBtn');
  if (await page.isVisible('#act')) await page.click('#bCall').catch(() => {});
  await page.waitForTimeout(60);
}
const hand = await page.evaluate(() => +(document.querySelector('#info')?.textContent?.match(/Hand#(\d+)/)?.[1] ?? 0));
await page.screenshot({ path: 'screenshots/offline-phone.png' });
// the multiplayer page is cached too (it needs the network to play, and says so)
await page.goto(URL_ + 'mp.html');
const mpLoaded = await page.isVisible('#lobby');
await ctx.setOffline(false);
await browser.close();

console.log(`manifest: ${manifest ? `${manifest.name}, display ${manifest.display}, ${manifest.icons.length} icons` : 'MISSING'}; service worker controls page: ${controlled}; cached files: ${cached}`);
console.log(`offline: page loaded ${loaded}, played to hand #${hand} in ${SECS}s, multiplayer page loaded ${mpLoaded}; page errors: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`);
const ok = !!manifest && controlled && loaded && hand >= 2 && mpLoaded && !errors.length;
console.log(ok ? 'RESULT: ok' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
