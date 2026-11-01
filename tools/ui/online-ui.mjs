// Browser test for playing online with friends, on the same table as single-player:
//  1. the host starts from the home page ("Play online with friends"), keeps their roster and
//     character, and starts a table; the table panel has the invite link;
//  2. a guest (other screen size) opens the invite link: the join view lists the roster with
//     the host's character taken and disabled; the guest picks a free one and joins;
//  3. both play dealer's choice by clicking (game picks, splits, rebuys, actions) for a few hands;
//  4. only the host can edit the players: they add one, and it appears for both;
//  5. settle up (with --expect-stored: from the database, matching the server's memory);
//  6. the guest reloads and gets the same seat back; then leaves: the character is free again;
//  7. an old /mp.html?code= link lands in the join view; no page errors, no sideways scrolling.
// Runs desktop host + phone guest, then phone host + desktop guest.
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
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|_vercel\/insights|ERR_CONNECTION_REFUSED|WebSocket/.test(m.text() + (m.location()?.url ?? ''))) errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
  return { ctx, page };
}
const handNo = p => p.evaluate(() => +(document.querySelector('#info')?.textContent?.match(/Hand#(\d+)/)?.[1] ?? 0));
const noSideScroll = p => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
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
const panelNames = p => p.$$eval('#tpRoster .rp', els => els.map(e => ({ name: e.querySelector('b').textContent, tag: e.querySelector('em')?.textContent ?? '', edit: !!e.querySelector('[data-act]') })));

for (const [hostSize, guestSize] of [['desktop', 'phone'], ['phone', 'desktop']]) {
  const c = {};
  const host = await open('host-' + hostSize, hostSize), guest = await open('guest-' + guestSize, guestSize);
  const H = host.page, G = guest.page;
  // 1. host: home page > Play online > start the table (keeps their roster: Sumer and friends; plays Sumer)
  await H.goto(SITE);
  await H.click('#onlineBtn');
  await H.waitForSelector('#onlineOv:not([hidden]) #olCreateBtn');
  c.lobbyRoster = await H.$$eval('#olRosterHost .rp', els => els.length);
  c.axe = [...await axe(H, '#onlineOv')];
  await H.click('#olCreateBtn');
  await H.waitForSelector('#tableBtn:not([hidden])', { timeout: WAIT });
  await press(H, '#tableBtn');
  await H.waitForSelector('#tableOv:not([hidden]) #tpLink[href*="join="]');
  const invite = await H.getAttribute('#tpLink', 'href'), code = invite.split('join=')[1];
  c.hostCanEdit = (await panelNames(H)).every(r => r.edit);
  c.axe.push(...await axe(H, '#tableOv'));
  await press(H, '#tpClose');
  await H.screenshot({ path: `screenshots/online-host-${hostSize}.png` });
  // 2. guest: the invite link > pick a free character (the host's is taken) > join
  await G.goto(invite);
  await G.waitForSelector('#olPick .rp', { timeout: WAIT });
  const picks = await G.$$eval('#olPick .rp', els => els.map(e => ({ name: e.querySelector('b').textContent, disabled: e.querySelector('input').disabled })));
  c.hostTaken = picks.find(p => p.name === 'Sumer')?.disabled === true && picks.filter(p => p.disabled).length === 1;
  c.axe.push(...await axe(G, '#onlineOv'));
  await G.check('#olPick input[value="rohit"]');
  c.joinLabel = (await G.textContent('#olJoinBtn')).trim();
  await G.screenshot({ path: `screenshots/online-join-${guestSize}.png` });
  await G.click('#olJoinBtn');
  // the guest sits down when the current hand ends; the host plays on meanwhile
  c.waitedForSeat = await G.waitForSelector('#olLede', { timeout: 5000 }).then(() => G.textContent('#olLede')).catch(() => '');
  c.seated = await playUntil([H], async () => G.isVisible('#tableBtn'), WAIT * 2);
  // 3. play a few hands of dealer's choice by clicking
  const start = await handNo(H);
  c.played = await playUntil([H, G], async () => (await handNo(H)) >= start + HANDS, 240_000);
  c.guestSeat = await G.textContent('.seat.hero .nm');
  c.guestSeesHost = await G.$$eval('.seat:not(.empty) .nm', els => els.map(e => e.textContent)).then(n => n.includes('Sumer') || n.some(x => /^(Fold|Check|Call|Raise|Bet|All-in)/.test(x)));
  // 4. roster: the guest cannot edit; the host adds Asha, who shows up for both
  await press(G, '#tableBtn');
  await G.waitForSelector('#tableOv:not([hidden]) #tpRoster .rp');
  c.guestCannotEdit = (await panelNames(G)).every(r => !r.edit) && !(await G.isVisible('#tpAdd'));
  await press(G, '#tpClose');
  await press(H, '#tableBtn');
  await H.waitForSelector('#tableOv:not([hidden]) #tpNewName');
  await H.fill('#tpNewName', 'Asha');
  await H.selectOption('#tpNewStyle', 'krish');
  await press(H, '#tpAddBtn');
  await press(H, '#tpClose');
  c.ashaArrived = await playUntil([H, G], async () => (await G.$$eval('.seat:not(.empty)', els => els.length)) === 6, 120_000);
  // 5. settle up
  await press(H, '#tableBtn');
  await press(H, '#tpSettle');
  await H.waitForSelector('#tpSettleOut table', { timeout: 20_000 });
  const settleText = (await H.textContent('#tpSettleOut')).replace(/\s+/g, ' ');
  c.settle = settleText.slice(0, 160) + '…' + (settleText.match(/Saved for this table:[^.]*\./)?.[0] ?? '');
  c.settleFromDb = STORED ? (/saved buy-in ledger/.test(settleText) && (await H.getAttribute('#tpSettleOut', 'data-matches-memory')) === 'true') : true;
  await press(H, '#tpClose');
  // 6. the guest reloads (same seat, no lobby), then leaves (the character is free again)
  await G.reload();
  c.resumed = await G.waitForSelector('#tableBtn:not([hidden])', { timeout: WAIT }).then(() => true, () => false);
  // the seat shows its name straight away (or the last action's label, which replaces it for a moment)
  await playUntil([H, G], async () => !!(await G.$('.seat.hero')), 30_000);
  c.resumedAs = await G.textContent('.seat.hero .nm').catch(() => '');
  await press(G, '#tableBtn');
  await press(G, '#tpLeave');
  c.backInLobby = await G.waitForSelector('#onlineOv:not([hidden])').then(() => true, () => false);
  c.freedForOthers = await playUntil([H], async () => { await press(H, '#tableBtn'); const n = await panelNames(H); await press(H, '#tpClose'); return n.find(r => r.name === 'Rohit')?.tag === ''; }, 60_000);
  // 7. an old link from the earlier multiplayer page
  await G.goto(SITE + 'mp.html?code=' + code);
  c.oldLink = await G.waitForSelector('#olJoin:not([hidden])', { timeout: 15_000 }).then(() => G.url().includes('join=' + code), () => false);
  c.noSideScroll = (await noSideScroll(H)) && (await noSideScroll(G));

  const ok = c.axe.length === 0 && c.seated && c.lobbyRoster >= 2 && c.hostCanEdit && c.hostTaken && /^Join as Rohit$/.test(c.joinLabel) && c.played && c.guestSeat === 'Rohit' && c.guestCannotEdit && c.ashaArrived
    && c.settleFromDb && /Sumer/.test(c.settle) && c.resumed && /Rohit|Fold|Check|Call|Raise|Bet|All-in/.test(c.resumedAs) && c.backInLobby && c.freedForOthers && c.oldLink && c.noSideScroll;
  console.log(`${hostSize} host, ${guestSize} guest: ${ok ? 'ok' : 'FAIL'} | table ${code} | ${JSON.stringify(c)}`);
  if (!ok) failed = true;
  await host.ctx.close();
  await guest.ctx.close();
}
await browser.close();
if (errors.length) { console.log('page errors: ' + errors.slice(0, 6).join(' | ')); failed = true; }
console.log(failed ? 'RESULT: FAIL' : 'RESULT: ok');
process.exit(failed ? 1 : 0);
