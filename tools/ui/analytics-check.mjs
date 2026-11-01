// Checks Vercel Web Analytics on the live site: the script loads, a page view is sent, and
// the page view carries no query string (the multiplayer page's ?code= is a private invite).
// Prints GitHub annotations in CI. Usage: node tools/ui/analytics-check.mjs <site url>
import { chromium } from 'playwright';

const SITE = (process.argv[2] || 'https://sumer-riverroom.vercel.app').replace(/\/$/, '');
const browser = await chromium.launch();
const results = [];
for (const path of ['/?seed=analytics-check', '/mp.html?code=ABCDEF']) {
  const page = await browser.newPage();
  const seen = [];
  page.on('response', async r => {
    if (!r.url().includes('/_vercel/insights/')) return;
    seen.push({ url: r.url().replace(SITE, ''), status: r.status(), body: r.request().postData() ?? '' });
  });
  await page.goto(SITE + path, { waitUntil: 'load' });
  await page.waitForTimeout(5000);
  const script = seen.find(s => s.url.includes('script.js'));
  const views = seen.filter(s => s.url.includes('/view'));
  const leaked = views.some(v => v.body.includes('?') || v.body.includes('ABCDEF') || v.body.includes('analytics-check'));
  const ok = !!script && script.status === 200 && views.length > 0 && views.every(v => v.status < 400) && !leaked;
  results.push(ok);
  const line = `${path}: script ${script ? script.status : 'not requested'}; page views sent ${views.length} (status ${views.map(v => v.status).join(', ') || '-'}); query string in page view: ${leaked ? 'YES' : 'no'}${views[0] ? `; payload ${views[0].body.slice(0, 160)}` : ''}`;
  console.log(line);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Web Analytics ${ok ? 'ok' : 'FAIL'}::${line}`);
  await page.close();
}
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
