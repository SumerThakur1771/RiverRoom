// Browser check for the AI review button, with /api/review answered by Playwright (no API key):
//  1. a streamed review is shown with its grade, mistake and lesson;
//  2. "not configured" (503) shows the built-in review note and hides the button.
//
// Usage: node tools/ui/review-ui.mjs [url=http://localhost:5173/]
import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'http://localhost:5173/';
const SSE = [
  'event: delta\ndata: {"text":"{\\"grade\\":\\"mistake\\","}\n\n',
  'event: delta\ndata: {"text":"\\"mistake\\":\\"On the turn you folded too often.\\",\\"lesson\\":\\"Compare the price with your chances.\\"}"}\n\n',
  'event: result\ndata: {"review":{"grade":"mistake","mistake":"On the turn you folded too often.","lesson":"Compare the price with your chances."}}\n\n',
].join('');

async function openReview(page) {
  await page.click('#startBtn');
  for (let t = 0; t < 600; t++) {
    if (await page.isVisible('#revOv')) return true;
    if (await page.isVisible('#dealOv')) await page.locator('#dealOpts button').nth(1).click();
    if (await page.isVisible('#splitOv')) await page.click('#spLock');
    if (await page.isVisible('#contRow')) await page.click('#contBtn');
    if (await page.isVisible('#act')) await page.click('#bCall').catch(() => {});
    await page.waitForTimeout(100);
  }
  return false;
}

const browser = await chromium.launch();
let failed = false;
for (const scenario of ['stream', 'not_configured']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => localStorage.setItem('river-room-v2', JSON.stringify({ mode: 'home', games: 'holdem', pace: 'fast', review: 'all', sound: false, holdResult: true, hints: true })));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let requestBody = null;
  await page.route('**/api/review', async route => {
    requestBody = route.request().postDataJSON();
    if (scenario === 'stream') await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: SSE });
    else await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ fallback: true, reason: 'not_configured' }) });
  });
  await page.goto(URL_ + '?seed=review-ui');
  if (!(await openReview(page))) { console.log(`${scenario}: FAIL review screen never opened`); failed = true; await ctx.close(); continue; }
  await page.click('#rvAsk');
  await page.waitForTimeout(800);
  const text = await page.textContent('#rvAi');
  const askVisible = await page.isVisible('#rvAsk');
  const sentOk = !!requestBody && typeof requestBody.hand === 'string' && Array.isArray(requestBody.decisions);
  const ok = scenario === 'stream'
    ? /Grade:\s*Mistake/.test(text) && /On the turn you folded too often/.test(text) && /Compare the price/.test(text) && sentOk
    : /not set up on this site yet/.test(text) && !askVisible && sentOk;
  if (scenario === 'stream') await page.screenshot({ path: 'screenshots/review-ai.png' });
  console.log(`${scenario}: ${ok && !errors.length ? 'ok' : 'FAIL'} | shown: ${text.replace(/\s+/g, ' ').slice(0, 140)}${errors.length ? ' | errors: ' + errors.join('; ') : ''}`);
  if (!ok || errors.length) failed = true;
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
