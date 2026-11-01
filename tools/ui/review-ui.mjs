// Browser check for the AI review button, with /api/review answered by Playwright (no API key):
//  1. a streamed review is shown with its grade, mistake, lesson and the model that wrote it;
//  2. the same hand after a reload is answered from this device's cache (no second request);
//  3. "not configured" (503) shows the built-in review note and hides the button.
//
// Usage: node tools/ui/review-ui.mjs [url=http://localhost:5173/]
import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'http://localhost:5173/';
const MODEL = 'google/gemma-4-26b-a4b-it:free';
const SSE = [
  `event: attempt\ndata: {"model":"${MODEL}","paid":false}\n\n`,
  'event: delta\ndata: {"text":"{\\"grade\\":\\"mistake\\","}\n\n',
  'event: delta\ndata: {"text":"\\"mistake\\":\\"On the turn you folded too often.\\",\\"lesson\\":\\"Compare the price with your chances.\\"}"}\n\n',
  `event: result\ndata: {"review":{"grade":"mistake","mistake":"On the turn you folded too often.","lesson":"Compare the price with your chances."},"model":"${MODEL}","paid":false,"cached":false}\n\n`,
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
  const label = scenario;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => localStorage.setItem('river-room-v2', JSON.stringify({ mode: 'home', games: 'holdem', pace: 'fast', review: 'all', sound: false, holdResult: true, hints: true })));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let requestBody = null, requests = 0;
  await page.route('**/api/review', async route => {
    requests++;
    requestBody = route.request().postDataJSON();
    if (scenario === 'stream') await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: SSE });
    else await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ fallback: true, reason: 'not_configured' }) });
  });
  await page.goto(URL_ + '?seed=review-ui');
  if (!(await openReview(page))) { console.log(`${scenario}: FAIL review screen never opened`); failed = true; await ctx.close(); continue; }
  const buttonLabel = (await page.textContent('#rvAsk')).trim();
  await page.click('#rvAsk');
  await page.waitForTimeout(800);
  const text = await page.textContent('#rvAi');
  const modelLine = (await page.isVisible('#rvAiModel')) ? await page.textContent('#rvAiModel') : '';
  const askVisible = await page.isVisible('#rvAsk');
  const sentOk = !!requestBody && typeof requestBody.hand === 'string' && Array.isArray(requestBody.decisions);
  let ok = buttonLabel === 'Ask the AI coach' && sentOk && (scenario === 'stream'
    ? /Grade:\s*Mistake/.test(text) && /On the turn you folded too often/.test(text) && /Compare the price/.test(text) && modelLine === `Reviewed by ${MODEL} (free model)` && !askVisible
    : /not set up on this site yet/.test(text) && !askVisible);
  if (scenario === 'stream') await page.screenshot({ path: 'screenshots/review-ai.png' });
  console.log(`${label}: ${ok && !errors.length ? 'ok' : 'FAIL'} | button "${buttonLabel}" | shown: ${text.replace(/\s+/g, ' ').slice(0, 120)}${modelLine ? ' | ' + modelLine : ''}${errors.length ? ' | errors: ' + errors.join('; ') : ''}`);
  if (scenario === 'stream') {
    // same seed, same first hand: the review comes from this device's cache, with no request
    requests = 0;
    await page.goto(URL_ + '?seed=review-ui');
    if (await openReview(page)) {
      await page.click('#rvAsk');
      await page.waitForTimeout(500);
      const again = await page.textContent('#rvAi'), line = await page.textContent('#rvAiModel');
      const cachedOk = requests === 0 && /On the turn you folded too often/.test(again) && /saved on this device/.test(line);
      console.log(`cached: ${cachedOk ? 'ok' : 'FAIL'} | requests to /api/review: ${requests} | ${line}`);
      if (!cachedOk) ok = false;
    } else { console.log('cached: FAIL review screen never opened'); ok = false; }
  }
  if (!ok || errors.length) failed = true;
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
