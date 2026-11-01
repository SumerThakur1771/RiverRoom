// Checks Vercel Web Analytics on the live site: the script loads, a page view is sent, and
// the page view carries no query string (the multiplayer page's ?code= is a private invite).
// Prints GitHub annotations in CI. Usage: node tools/ui/analytics-check.mjs <site url>
import { chromium } from 'playwright';

const SITE = (process.argv[2] || 'https://sumer-riverroom.vercel.app').replace(/\/$/, '');
// The analytics script ignores automated and headless browsers (navigator.webdriver, a
// "HeadlessChrome" user agent), so this check presents itself as a normal desktop Chrome to see
// what a real visitor's page sends. Page views may go out as beacons, so requests are watched
// (and matched with their responses when there is one).
const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
const ua = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const results = [];
for (const path of ['/?seed=analytics-check', '/mp.html?code=ABCDEF']) {
  const ctx = await browser.newContext({ userAgent: ua });
  const page = await ctx.newPage();
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const seen = [];
  page.on('request', r => {
    if (!r.url().includes('/_vercel/insights/')) return;
    const entry = { url: r.url().replace(SITE, ''), status: 0, body: r.postData() ?? '' };
    seen.push(entry);
    r.response().then(res => { if (res) entry.status = res.status(); }).catch(() => {});
  });
  await page.goto(SITE + path, { waitUntil: 'load' });
  await page.waitForTimeout(8000);
  const script = seen.find(s => s.url.includes('script.js'));
  const views = seen.filter(s => s.url.includes('/view'));
  const leaked = views.some(v => v.body.includes('?') || v.body.includes('ABCDEF') || v.body.includes('analytics-check'));
  // a beacon has no readable response (status 0); a fetch should not be an error
  const ok = !!script && script.status === 200 && views.length > 0 && views.every(v => v.status < 400) && !leaked;
  results.push(ok);
  const line = `${path}: script ${script ? script.status : 'not requested'}; page views sent ${views.length} (status ${views.map(v => v.status).join(', ') || '-'}); query string in page view: ${leaked ? 'YES' : 'no'}${views[0] ? `; payload ${views[0].body.slice(0, 160)}` : ''}`;
  console.log(line);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Web Analytics ${ok ? 'ok' : 'FAIL'}::${line}`);
  await ctx.close();
}
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
