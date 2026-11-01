// Browser test for a sleeping game server (free hosting): the multiplayer page is opened
// while nothing is listening, must say it is waking the server, must hold a "Start a table"
// click until the server answers, and must then open the table.
//
// Usage: node tools/ui/mp-wake.mjs <page url> <server port the page was built for> [delay ms=8000]
// The page must be built with VITE_MP_SERVER_URL=http://localhost:<port>, and server/dist/main.js must exist.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const [PAGE = 'http://localhost:4177/mp.html', PORT = '8099', DELAY = '8000'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(PAGE);
await page.waitForTimeout(2500);
const notice = await page.isVisible('#wake'), status = (await page.textContent('#conn')).trim();
await page.fill('#name', 'Early');
await page.click('#create');
const buttonsHeld = await page.isDisabled('#create');
const t0 = Date.now();
await page.waitForTimeout(+DELAY);
const stillWaiting = !(await page.isVisible('#table')) && (await page.isVisible('#wake'));
// the server "wakes up"
const origin = new URL(PAGE).origin;
const server = spawn(process.execPath, ['server/dist/main.js'], { env: { ...process.env, PORT, TIMING: 'fast', ALLOWED_ORIGINS: origin, DATABASE_URL: '', DIRECT_DATABASE_URL: '' }, stdio: 'ignore' });
let opened = false;
try {
  await page.waitForSelector('#table:not([hidden])', { timeout: 30_000 });
  opened = true;
} catch { /* reported below */ }
const after = { notice: await page.isVisible('#wake'), status: (await page.textContent('#conn')).trim(), code: opened ? (await page.textContent('#tcode')).trim() : '' };
await page.screenshot({ path: 'screenshots/mp-wake-phone.png' });
server.kill();
await browser.close();
console.log(`asleep: notice shown ${notice}, status "${status}", buttons held ${buttonsHeld}, still waiting after ${DELAY} ms ${stillWaiting}`);
console.log(`awake: table opened ${opened} (code ${after.code || '-'}) ${((Date.now() - t0) / 1000).toFixed(1)} s after the click, notice hidden ${!after.notice}, status "${after.status}"; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
const ok = notice && /Waking up/.test(status) && buttonsHeld && stillWaiting && opened && !after.notice && after.status === 'Connected' && /^[A-Z2-9]{6}$/.test(after.code) && !errors.length;
console.log(ok ? 'RESULT: ok' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
