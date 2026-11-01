// Browser test for a sleeping game server (free hosting): the online lobby is opened while
// nothing is listening. It must say it is waking the server, hold a "Start the table" click
// until the server answers, and then open the table.
//
// Usage: node tools/ui/online-wake.mjs <site url> <server port the page was built for> [delay ms=8000]
// The page must be built with VITE_MP_SERVER_URL=http://localhost:<port>, and server/dist/main.js must exist.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const [SITE = 'http://localhost:4177/', PORT = '8099', DELAY = '8000'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(SITE);
await page.click('#onlineBtn');
await page.waitForTimeout(2500);
const notice = await page.isVisible('#olWake'), status = (await page.textContent('#olConn')).trim();
await page.click('#olCreateBtn');
const held = await page.isDisabled('#olCreateBtn');
const t0 = Date.now();
await page.waitForTimeout(+DELAY);
const stillWaiting = (await page.isVisible('#onlineOv')) && !(await page.isVisible('#tableBtn'));
// the server "wakes up"
const server = spawn(process.execPath, ['server/dist/main.js'], { env: { ...process.env, PORT, TIMING: 'fast', ALLOWED_ORIGINS: new URL(SITE).origin, DATABASE_URL: '', DIRECT_DATABASE_URL: '' }, stdio: 'ignore' });
const opened = await page.waitForSelector('#tableBtn:not([hidden])', { timeout: 30_000 }).then(() => true, () => false);
const after = { notice: await page.isVisible('#olWake'), lobby: await page.isVisible('#onlineOv') };
await page.screenshot({ path: 'screenshots/online-wake-phone.png' });
server.kill();
await browser.close();
console.log(`asleep: notice shown ${notice}, status "${status}", click held ${held}, still waiting after ${DELAY} ms ${stillWaiting}`);
console.log(`awake: table opened ${opened} ${((Date.now() - t0) / 1000).toFixed(1)} s after the click, notice hidden ${!after.notice}, lobby closed ${!after.lobby}; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
const ok = notice && /Waking up/.test(status) && held && stillWaiting && opened && !after.notice && !after.lobby && !errors.length;
console.log(ok ? 'RESULT: ok' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
