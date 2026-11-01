// Browser test for reaching multiplayer from the main game, on desktop and phone sizes:
//  1. the home page's start screen has "Play online with friends", and it opens the
//     multiplayer page;
//  2. the host starts a table there and gets a visible invite link;
//  3. a second browser opens that link: it lands in the join view with the code filled in,
//     joins, and both players see each other at the table;
//  4. "Back to single player" returns to the start screen; no page scrolls sideways.
// Runs twice: desktop host with phone guest, and phone host with desktop guest.
//
// Usage: node tools/ui/mp-entry.mjs <site url, e.g. http://localhost:4177/> [--wait <ms>]
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = (process.argv[2] || 'http://localhost:4177/').replace(/\/?$/, '/');
const WAIT = process.argv.includes('--wait') ? +process.argv[process.argv.indexOf('--wait') + 1] : 30_000;
const SIZES = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
mkdirSync('screenshots', { recursive: true });
const browser = await chromium.launch();
const errors = [];
let failed = false;

async function open(size) {
  const ctx = await browser.newContext({ viewport: SIZES[size], hasTouch: size === 'phone' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${size}: ${e.message}`));
  return { ctx, page };
}
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const [hostSize, guestSize] of [['desktop', 'phone'], ['phone', 'desktop']]) {
  const checks = {};
  const host = await open(hostSize), guest = await open(guestSize);
  // 1. from the main game's start screen
  await host.page.goto(SITE);
  await host.page.waitForSelector('#startOv:not([hidden]) #onlineBtn');
  checks.buttonText = (await host.page.textContent('#onlineBtn')).replace(/\s+/g, ' ').trim();
  checks.buttonVisibleWithoutScroll = await host.page.evaluate(() => { const r = document.getElementById('onlineBtn').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
  await host.page.screenshot({ path: `screenshots/entry-start-${hostSize}.png` });
  await host.page.click('#onlineBtn');
  await host.page.waitForURL(/\/mp\.html/);
  checks.headerLogo = (await host.page.textContent('.top .logo')).trim();
  checks.backLink = (await host.page.textContent('#backLink')).trim();
  checks.hostNoSideScroll = await noSideScroll(host.page);
  // 2. start a table, read the invite link
  await host.page.fill('#name', 'Host');
  await host.page.click('#create');
  await host.page.waitForSelector('#table:not([hidden])', { timeout: WAIT });
  const code = (await host.page.textContent('#tcode')).trim();
  const invite = await host.page.getAttribute('#inviteLink', 'href');
  checks.inviteLink = invite;
  // 3. the guest opens the invite link
  await guest.page.goto(invite);
  checks.guestMode = await guest.page.getAttribute('#lobby', 'data-mode');
  checks.guestCodeFilled = await guest.page.inputValue('#code');
  checks.guestTitle = (await guest.page.textContent('#lobbyTitle')).trim();
  checks.guestCreateHidden = !(await guest.page.isVisible('#create'));
  checks.guestNoSideScroll = await noSideScroll(guest.page);
  await guest.page.screenshot({ path: `screenshots/entry-join-${guestSize}.png` });
  await guest.page.fill('#name', 'Guest');
  await guest.page.click('#join');
  await guest.page.waitForSelector('#table:not([hidden])', { timeout: WAIT });
  // a player who joins mid-hand takes the seat at the next deal, so the host plays on until then
  const seesGuest = () => host.page.evaluate(() => [...document.querySelectorAll('.seat .nm')].some(e => e.textContent.startsWith('Guest')));
  for (const t0 = Date.now(); !(await seesGuest()) && Date.now() - t0 < 90_000;) {
    for (const p of [host.page, guest.page]) {
      if (await p.isVisible('#rebuy')) await p.click('#rebuyYes').catch(() => {});
      if (await p.isVisible('#actions')) await p.click('#call').catch(() => {});
    }
    await host.page.waitForTimeout(200);
  }
  checks.hostSeesGuest = await seesGuest();
  if (!checks.hostSeesGuest) checks.seats = { host: await host.page.$$eval('.seat .nm', e => e.map(x => x.textContent)), guest: await guest.page.$$eval('.seat .nm', e => e.map(x => x.textContent)), hostTurn: await host.page.textContent('#turn') };
  checks.guestSeesHost = await guest.page.evaluate(() => [...document.querySelectorAll('.seat .nm')].some(e => e.textContent.startsWith('Host')));
  checks.sameTable = (await guest.page.textContent('#tcode')).trim() === code;
  await host.page.screenshot({ path: `screenshots/entry-table-${hostSize}.png` });
  // 4. back to single player (after leaving, so the seat goes back to a bot)
  await guest.page.click('#leave');
  await guest.page.waitForSelector('#lobby:not([hidden])');
  await guest.page.click('#backLink');
  await guest.page.waitForSelector('#startOv:not([hidden])');
  checks.backToStart = true;

  const ok = /Play online with friends/.test(checks.buttonText) && checks.buttonVisibleWithoutScroll && checks.headerLogo === 'River Room' && /Back to single player/.test(checks.backLink)
    && invite === `${new URL(SITE).origin}/mp.html?code=${code}` && checks.guestMode === 'join' && checks.guestCodeFilled === code && checks.guestTitle === `Join table ${code}` && checks.guestCreateHidden
    && checks.hostSeesGuest && checks.guestSeesHost && checks.sameTable && checks.backToStart && checks.hostNoSideScroll && checks.guestNoSideScroll;
  console.log(`${hostSize} host, ${guestSize} guest: ${ok ? 'ok' : 'FAIL'} | table ${code} | ${JSON.stringify(checks)}`);
  if (!ok) failed = true;
  await host.ctx.close();
  await guest.ctx.close();
}
await browser.close();
if (errors.length) { console.log('page errors: ' + errors.join(' | ')); failed = true; }
console.log(failed ? 'RESULT: FAIL' : 'RESULT: ok');
process.exit(failed ? 1 : 0);
