// Browser test for playing online with friends: a waiting room, then the same table as single-player.
//  1. the host opens a table from the home page ("Play online with friends" > "Open my table"):
//     they land at the table in the waiting room, with the table code shown; nothing is dealt;
//     they set the computers to none (Start is then disabled: one player) and the turn timer off;
//  2. guest 1 types the code ("Join with a code"), creates a new player (Asha) and joins; guest 2
//     opens the invite link and picks Rohit (off the table). Guests see no settings controls and
//     no Start button; the host adds one computer and presses Start;
//  3. everyone plays dealer's choice by clicking (game picks, splits, rebuys, actions); with the
//     timer off a guest's turn waits for them (the page does not act for them);
//  4. the host renames the computer in the players list (no browser prompt) and removes guest 2,
//     who is told and lands in the lobby; only the host has edit controls;
//  5. settle up (with --expect-stored: from the database, matching the server's memory);
//  6. guest 1 reloads and gets the same seat back; a second tab in the same browser opens the
//     invite link and gets the join view (it does not take the first tab's seat), with "Rejoin";
//  7. guest 1 leaves; the host sets the computers to none, so the table drops below two players
//     and goes back to the waiting room ("Continue the game");
//  8. an old /mp.html?code= link lands in the join view with the code filled in; no page errors,
//     no sideways scrolling; no WCAG A/AA violations in the lobby, the waiting room and the panel.
// Runs desktop host + phone guests, then phone host + desktop guests.
//
// Usage: node tools/ui/online-ui.mjs <site url> [--expect-stored] [--hands N]
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const axeSrc = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
/** WCAG 2.1 A/AA violations inside one element (axe-core, the engine Lighthouse uses). */
async function axe(p, sel) {
  await p.addScriptTag({ content: axeSrc });
  const r = await p.evaluate(s => window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }), sel);
  return r.violations.map(v => `${v.id} (${v.nodes.length}: ${v.nodes[0]?.target.join(' ')})`);
}

const SITE = (process.argv[2] || 'http://localhost:4177/').replace(/\/?$/, '/');
const STORED = process.argv.includes('--expect-stored');
const HANDS = process.argv.includes('--hands') ? +process.argv[process.argv.indexOf('--hands') + 1] : 3;
const WAIT = STORED ? 180_000 : 30_000; // a sleeping free server takes about a minute to wake
const SIZES = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
mkdirSync('screenshots', { recursive: true });
const browser = await chromium.launch();
const errors = [];
let failed = false;

async function open(label, size) {
  const ctx = await browser.newContext({ viewport: SIZES[size], hasTouch: size === 'phone' });
  await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('river-room-v2', JSON.stringify({ mode: 'home', games: 'dealer', pace: 'fast', review: 'off', sound: false, timer: 0, holdResult: false, hints: true })); } });
  const page = await ctx.newPage();
  watch(page, label);
  page.on('dialog', d => { errors.push(`${label}: browser dialog "${d.message()}"`); void d.dismiss(); });
  return { ctx, page };
}
function watch(page, label) {
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|_vercel\/insights|ERR_CONNECTION_REFUSED|WebSocket/.test(m.text() + (m.location()?.url ?? ''))) errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
}
const handNo = p => p.evaluate(() => +(document.querySelector('#info')?.textContent?.match(/Hand#(\d+)/)?.[1] ?? 0));
/** Elements sticking out past the right edge, if the page scrolls sideways (empty = fine). */
const sideScroll = p => p.evaluate(() => {
  const W = window.innerWidth;
  if (document.documentElement.scrollWidth <= W) return [];
  return [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > W + 1; }).slice(0, 4).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className).split(' ')[0]}`);
});
const seats = p => p.$$eval('.seat:not(.empty)', els => els.length);
/** Click whatever the table asks of this player: game pick, split, rebuy, action. */
async function play(p) {
  if (await p.isVisible('#dealOv')) await p.locator('#dealOpts button').first().click().catch(() => {});
  if (await p.isVisible('#splitOv')) await p.click('#spLock').catch(() => {});
  if (await p.isVisible('#rebuyOv')) await p.click('#rebuyYes').catch(() => {});
  if (await p.isVisible('#act')) await p.click('#bCall').catch(() => {});
}
/** Click a control, first answering anything the table is asking (a modal dialog may be up). */
async function press(p, sel, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    await play(p);
    try { await p.click(sel, { timeout: 1500 }); return; } catch (e) { if (Date.now() - t0 > ms) throw e; }
  }
}
async function playUntil(pages, cond, ms) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) return false;
    for (const p of pages) await play(p);
    await pages[0].waitForTimeout(120);
  }
  return true;
}
const until = async (cond, ms) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 120)); } return true; };
const panelRows = p => p.$$eval('#tpRoster .rp', els => els.map(e => ({ name: e.querySelector('b')?.textContent ?? '', tag: e.querySelector('em')?.textContent ?? '', edit: !!e.querySelector('[data-act]') })));
const computers = p => p.evaluate(() => +(document.querySelector('#wrSettings output')?.textContent ?? -1));

for (const [hostSize, guestSize] of [['desktop', 'phone'], ['phone', 'desktop']]) {
  const c = {};
  const host = await open('host-' + hostSize, hostSize), g1 = await open('guest1-' + guestSize, guestSize), g2 = await open('guest2-' + guestSize, guestSize);
  const H = host.page, G = g1.page, G2 = g2.page;
  // 1. host: home page > Play online > Open my table (plays Sumer) > the waiting room
  await H.goto(SITE);
  await H.click('#onlineBtn');
  await H.waitForSelector('#onlineOv:not([hidden]) #olCreateBtn');
  c.mePick = await H.$$eval('#olMe input', els => els.filter(e => e.checked).map(e => e.value).join());
  c.axe = [...await axe(H, '#onlineOv')];
  await H.click('#olCreateBtn');
  await H.waitForSelector('#wroom:not([hidden])', { timeout: WAIT });
  const code = (await H.textContent('#wrCode')).trim();
  c.codeShown = /^[A-Z2-9]{6}$/.test(code);
  c.notDealt = (await handNo(H)) === 0 && !(await H.isVisible('#act'));
  c.hostControls = (await H.isVisible('#wrStart')) && (await H.isVisible('#wrSettings .stepper'));
  // computers down to none: one player, so Start is disabled
  for (let k = await computers(H); k > 0; k--) { await H.click('#wrSettings [data-set="comp-1"]'); await until(async () => (await computers(H)) === k - 1, 10_000); }
  c.zeroComputers = (await seats(H)) === 1 && (await H.isDisabled('#wrStart'));
  await H.click('#wrSettings [data-timer="0"]');
  c.timerOff = await until(async () => (await H.getAttribute('#wrSettings [data-timer="0"]', 'aria-pressed')) === 'true', 10_000);
  c.axe.push(...await axe(H, '#wroom'));
  await H.screenshot({ path: `screenshots/online-waiting-${hostSize}.png` });
  // 2. guest 1: Join with a code > types it > creates a new player
  await G.goto(SITE);
  await G.click('#onlineBtn');
  await G.click('#olModeSeg [data-v="join"]');
  await G.fill('#olCode', code.toLowerCase().slice(0, 3) + '-' + code.toLowerCase().slice(3)); // typed loosely: lower case, a dash
  await G.click('#olFind');
  await G.waitForSelector('#olPick:not([hidden]) .rp', { timeout: WAIT });
  const picks = await G.$$eval('#olPick input', els => els.map(e => e.value));
  c.pickList = !picks.includes('sumer') && picks.includes('rohit') && picks.includes('__new');
  await G.check('#olPick input[value="__new"]');
  await G.fill('#olNewName', 'Asha');
  c.joinLabel = (await G.textContent('#olJoinBtn')).trim();
  c.axe.push(...await axe(G, '#onlineOv'));
  await G.screenshot({ path: `screenshots/online-join-${guestSize}.png` });
  await G.click('#olJoinBtn');
  await G.waitForSelector('#wroom:not([hidden])', { timeout: WAIT });
  c.guestNoControls = !(await G.isVisible('#wrStart')) && !(await G.isVisible('#wrSettings .stepper')) && /Waiting for Sumer to start/.test(await G.textContent('#wrStatus'));
  // guest 2: the invite link > picks Rohit (not at the table yet)
  await G2.goto(SITE + '?join=' + code);
  await G2.waitForSelector('#olPick:not([hidden]) .rp', { timeout: WAIT });
  await G2.check('#olPick input[value="rohit"]');
  await G2.click('#olJoinBtn');
  await G2.waitForSelector('#wroom:not([hidden])', { timeout: WAIT });
  c.hostSeesThree = await until(async () => (await seats(H)) === 3 && /Asha/.test(await H.textContent('#wrStatus')) && /Rohit/.test(await H.textContent('#wrStatus')), 10_000);
  await H.click('#wrSettings [data-set="comp+1"]');
  c.oneComputer = await until(async () => (await seats(H)) === 4, 10_000);
  await H.screenshot({ path: `screenshots/online-ready-${hostSize}.png` });
  await H.click('#wrStart');
  c.started = await until(async () => (await G.isHidden('#wroom')) && (await handNo(G)) >= 1, WAIT);
  // 3. play: with no timer, the guest's turn waits for them
  c.noTimerWaits = false;
  const start = await handNo(H);
  c.played = await playUntil([H, G2], async () => {
    if (!c.noTimerWaits && await G.isVisible('#act')) { await G.waitForTimeout(2500); c.noTimerWaits = await G.isVisible('#act'); }
    await play(G);
    return c.noTimerWaits && (await handNo(H)) >= start + HANDS;
  }, 240_000);
  c.guestSeat = await G.textContent('.seat.hero .nm');
  // 4. host: rename the computer inline; remove guest 2 (two taps)
  await press(G, '#tableBtn');
  await G.waitForSelector('#tableOv:not([hidden]) #tpRoster .rp');
  c.guestCannotEdit = (await panelRows(G)).every(r => !r.edit) && !(await G.isVisible('#tpAdd')) && !(await G.isVisible('#tpSettings .stepper'));
  c.axe.push(...await axe(G, '#tableOv'));
  await press(G, '#tpClose');
  await press(H, '#tableBtn');
  await H.waitForSelector('#tableOv:not([hidden]) #tpRoster .rp');
  const bot = (await panelRows(H)).find(r => !r.tag);
  await H.click(`#tpRoster .rp:has(b:text-is("${bot.name}")) [data-act="rename"]`);
  await H.fill('#tpRenameIn', 'Robo');
  await H.press('#tpRenameIn', 'Enter');
  // a rename made during a hand shows when it ends; close the panel so the host can play on
  await H.waitForSelector('#tpRenameIn', { state: 'detached' });
  await H.click('#tpClose');
  c.renamed = await playUntil([H, G, G2], async () => (await G.$$eval('.seat .nm', els => els.map(e => e.textContent))).includes('Robo'), 120_000);
  await press(H, '#tableBtn');
  await H.waitForSelector('#tableOv:not([hidden]) #tpRoster .rp');
  await H.click('#tpRoster .rp:has(b:text-is("Rohit")) [data-act="kick"]');
  await H.click('#tpRoster .rp:has(b:text-is("Rohit")) [data-act="kick"]');
  c.kicked = await G2.waitForSelector('#onlineOv:not([hidden])', { timeout: 20_000 }).then(async () => /removed you/.test(await G2.textContent('#olErr')), () => false);
  await press(H, '#tpClose');
  // 5. settle up
  await press(H, '#tableBtn');
  await press(H, '#tpSettle');
  await H.waitForSelector('#tpSettleOut table', { timeout: 20_000 });
  const settleText = (await H.textContent('#tpSettleOut')).replace(/\s+/g, ' ');
  c.settle = settleText.slice(0, 120) + '…' + (settleText.match(/Saved for this table:[^.]*\./)?.[0] ?? '');
  c.settleFromDb = STORED ? (/saved buy-in ledger/.test(settleText) && (await H.getAttribute('#tpSettleOut', 'data-matches-memory')) === 'true') : true;
  await press(H, '#tpClose');
  // 6. guest 1 reloads (same seat); a second tab in the same browser does not take that seat
  await G.reload();
  c.resumed = await G.waitForSelector('#tableBtn:not([hidden])', { timeout: WAIT }).then(() => true, () => false);
  await playUntil([H, G], async () => !!(await G.$('.seat.hero')), 30_000);
  c.resumedAs = await G.textContent('.seat.hero .nm').catch(() => '');
  const tab2 = await g1.ctx.newPage();
  watch(tab2, 'guest1-tab2');
  await tab2.goto(SITE + '?join=' + code);
  c.secondTab = await tab2.waitForSelector('#olJoin:not([hidden])', { timeout: 15_000 }).then(async () => (await tab2.isVisible('#olRejoin')) && /Rejoin table/.test(await tab2.textContent('#olRejoin')) && !(await tab2.isVisible('#tableBtn')), () => false);
  await tab2.close();
  // 7. guest 1 leaves; with no computers the table drops below two players: back to the waiting room
  await press(G, '#tableBtn');
  await press(G, '#tpLeave');
  c.backInLobby = await G.waitForSelector('#onlineOv:not([hidden])').then(() => true, () => false);
  await press(H, '#tableBtn');
  const panelComputers = () => H.evaluate(() => +(document.querySelector('#tpSettings output')?.textContent ?? -1));
  for (let k = await panelComputers(); k > 0; k--) { await press(H, '#tpSettings [data-set="comp-1"]'); await until(async () => (await panelComputers()) < k, 10_000); }
  await press(H, '#tpClose');
  c.paused = await playUntil([H], async () => (await H.isVisible('#wroom')) && /Continue the game/.test(await H.textContent('#wrStart')), STORED ? 240_000 : 60_000);
  await H.screenshot({ path: `screenshots/online-paused-${hostSize}.png` });
  // 8. an old link from the earlier multiplayer page
  await G.goto(SITE + 'mp.html?code=' + code);
  c.oldLink = await G.waitForSelector('#olJoin:not([hidden])', { timeout: 15_000 }).then(async () => G.url().includes('join=' + code) && (await G.inputValue('#olCode')) === code, () => false);
  c.sideScroll = [...await sideScroll(H), ...await sideScroll(G)];

  const ok = c.axe.length === 0 && c.mePick === 'sumer' && c.codeShown && c.notDealt && c.hostControls && c.zeroComputers && c.timerOff && c.pickList && /^Join as Asha$/.test(c.joinLabel)
    && c.guestNoControls && c.hostSeesThree && c.oneComputer && c.started && c.played && c.guestSeat === 'Asha' && c.guestCannotEdit && c.renamed && c.kicked
    && c.settleFromDb && /Sumer/.test(c.settle) && c.resumed && /Asha|Fold|Check|Call|Raise|Bet|All-in/.test(c.resumedAs) && c.secondTab && c.backInLobby && c.paused && c.oldLink && !c.sideScroll.length;
  console.log(`${hostSize} host, ${guestSize} guests: ${ok ? 'ok' : 'FAIL'} | table ${code} | ${JSON.stringify(c)}`);
  if (!ok) failed = true;
  for (const x of [host, g1, g2]) await x.ctx.close();
}
await browser.close();
if (errors.length) { console.log('page errors: ' + errors.slice(0, 6).join(' | ')); failed = true; }
console.log(failed ? 'RESULT: FAIL' : 'RESULT: ok');
process.exit(failed ? 1 : 0);
