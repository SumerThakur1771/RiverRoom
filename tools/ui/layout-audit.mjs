// Layout audit: does the table read cleanly at every screen size, in every game, from every seat?
// Plays the app and, at each decision point, resizes the page through phone, tablet and desktop
// sizes and measures what overlaps what on the table (your cards over the board, seats over
// seats, other players' cards over seats, the pot, labels), what is cut off at the screen edge,
// clipped text, and how big cards and buttons are. Saves a screenshot for each case.
//
//  single: single-player home game, dealer's choice, until every game type has come up (you sit
//          at the bottom seat);
//  online: an online table where you play a side seat (a friend's table, as Krish).
//
// Usage: node tools/ui/layout-audit.mjs <site url> [single|online|both=both] [--shots dir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = (process.argv[2] || 'http://localhost:4177/').replace(/\/?$/, '/');
const WHICH = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'both';
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : 'screenshots/layout';
mkdirSync(SHOTS, { recursive: true });

// CSS pixel viewports. "safari" heights are what a phone shows with the browser's own bars.
export const SIZES = [
  ['phone-se-safari', 375, 553], ['phone-se', 375, 667], ['phone-small', 320, 568], ['android-small', 360, 640],
  ['iphone-safari', 390, 664], ['iphone', 390, 844], ['pixel', 412, 915], ['iphone-max-safari', 430, 740], ['iphone-max', 430, 932],
  ['phone-land', 844, 390], ['phone-land-small', 667, 375], ['phone-land-max', 932, 430],
  ['ipad-mini', 768, 1024], ['ipad-land', 1024, 768], ['ipad-air', 820, 1180], ['ipad-air-land', 1180, 820],
  ['laptop-small', 1024, 640], ['laptop', 1280, 800], ['desktop', 1440, 900], ['desktop-wide', 1920, 1080],
];

/** Measured in the page: pairs of table elements that overlap, things off screen, sizes. */
function measure() {
  const vis = e => { if (!e || e.closest('[hidden]')) return false; const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05; };
  const box = e => e.getBoundingClientRect();
  const union = els => { const rs = els.filter(vis).map(box).filter(r => r.width && r.height); if (!rs.length) return null; return { left: Math.min(...rs.map(r => r.left)), top: Math.min(...rs.map(r => r.top)), right: Math.max(...rs.map(r => r.right)), bottom: Math.max(...rs.map(r => r.bottom)) }; };
  const area = r => (r.right - r.left) * (r.bottom - r.top);
  const over = (a, b) => { const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return w > 0 && h > 0 ? (w * h) / Math.min(area(a), area(b)) : 0; };
  const items = [];
  const add = (kind, name, r, seat) => { if (r && r.right - r.left > 1) items.push({ kind, name, r, seat }); };
  for (const s of document.querySelectorAll('#arena .seat')) {
    const seat = s.dataset.seat, nm = s.querySelector('.nm')?.textContent || 'seat', hero = s.classList.contains('hero'), empty = s.classList.contains('empty');
    const plate = s.querySelector('.plate');
    if (plate && vis(plate)) add(empty ? 'open seat' : hero ? 'your seat' : 'seat', empty ? 'open seat ' + seat : nm, box(plate), seat);
    add(hero ? 'your cards' : 'cards', (hero ? 'your cards' : nm + "'s cards"), union([...s.querySelectorAll('.hole .card')]), seat);
    const hn = s.querySelector('.hn');
    if (hn && vis(hn)) add('label', (hero ? 'your hand name' : nm + ' hand name'), box(hn), seat);
  }
  add('board', 'board', union([...document.querySelectorAll('#board .slot')]), null);
  if (vis(document.querySelector('#board2'))) add('board', 'board 2', union([...document.querySelectorAll('#board2 .slot')]), null);
  const pot = document.querySelector('#pot'); if (vis(pot)) add('pot', 'pot', box(pot), null);
  for (const b of document.querySelectorAll('#arena .bet')) if (vis(b)) add('bet', 'bet ' + b.textContent.trim(), box(b), b.dataset.seat ?? null); // a seat's own bet sits by it
  // overlaps that hide something; things in one seat belong together, open seats only matter a little
  const bad = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.seat !== null && a.seat === b.seat) continue;
    if ((a.kind === 'open seat' && b.kind === 'open seat')) continue;
    const f = over(a.r, b.r);
    const min = a.kind === 'open seat' || b.kind === 'open seat' ? 0.25 : 0.08;
    if (f > min) bad.push(`${a.name} over ${b.name} ${Math.round(f * 100)}%`);
  }
  const W = innerWidth, H = innerHeight;
  const off = items.filter(x => x.r.left < -1 || x.r.right > W + 1 || x.r.top < -1).map(x => `${x.name} off screen`);
  const clipped = [...document.querySelectorAll('#feed span, .seat .nm, .seat .stk, #tinfo .ti, .hn')].filter(e => vis(e) && e.scrollWidth > e.clientWidth + 1).map(e => `clipped "${e.textContent.trim().slice(0, 28)}"`);
  const heroCard = document.querySelector('.seat.hero .hole .card'), boardSlot = document.querySelector('#board .slot');
  const btns = [...document.querySelectorAll('#act button, #pre button, .ibtn')].filter(vis).map(box).filter(r => r.width);
  const arena = box(document.querySelector('#arena'));
  return {
    overlaps: [...new Set(bad)], off: [...new Set(off)], clipped: [...new Set(clipped)].slice(0, 6),
    sideScroll: document.documentElement.scrollWidth > W,
    table: `${Math.round(arena.width)}x${Math.round(arena.height)} (${Math.round((arena.width * arena.height) / (W * H) * 100)}% of screen)`,
    heroCardPx: heroCard && vis(heroCard) ? Math.round(box(heroCard).height) : null,
    boardCardPx: boardSlot ? Math.round(box(boardSlot).height) : null,
    smallestButton: btns.length ? Math.round(Math.min(...btns.map(r => Math.min(r.width, r.height)))) : null,
    heroCards: document.querySelectorAll('.seat.hero .hole .card').length,
    variant: (document.querySelector('#info')?.textContent.match(/Game\s*([A-Za-z0-9' ]+?)(?:Your|Blinds|Buy|$)/) || [])[1]?.trim() || '',
  };
}

const browser = await chromium.launch();
const rows = [];
async function sweep(page, label) {
  for (const [name, w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    const m = await page.evaluate(measure);
    const file = `${SHOTS}/${label}-${name}.png`;
    await page.screenshot({ path: file });
    rows.push({ label, size: `${name} ${w}x${h}`, ...m });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}
async function answer(p) {
  if (await p.isVisible('#dealOv')) return 'deal';
  if (await p.isVisible('#splitOv')) { await p.click('#spLock').catch(() => {}); return 'split'; }
  if (await p.isVisible('#rebuyOv')) { await p.click('#rebuyYes').catch(() => {}); return 'rebuy'; }
  if (await p.isVisible('#revOv')) { await p.click('#rvNext').catch(() => {}); return 'review'; }
  if (await p.isVisible('#contRow')) { await p.click('#contBtn').catch(() => {}); return 'cont'; }
  return (await p.isVisible('#act')) ? 'act' : null;
}
const want = ['Simple', 'Standard', 'Two boards', '7 cards', '8 cards'];

if (WHICH === 'single' || WHICH === 'both') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.addInitScript(() => localStorage.setItem('river-room-v2', JSON.stringify({ mode: 'home', games: 'dealer', pace: 'fast', review: 'off', sound: false, timer: 0, holdResult: false, revealAll: false, hints: true })));
  const page = await ctx.newPage();
  await page.goto(SITE + '?seed=layout-audit');
  await page.click('#startBtn');
  const seen = new Set(), t0 = Date.now();
  while (seen.size < want.length && Date.now() - t0 < 300_000) {
    const a = await answer(page);
    if (a === 'deal') { // you deal: pick a game not seen yet
      const keys = await page.$$eval('#dealOpts button', bs => bs.map(b => b.textContent));
      const pick = keys.findIndex(t => want.some(w => !seen.has(w) && t.includes(w === 'Simple' ? 'Simple' : w)));
      await page.locator('#dealOpts button').nth(pick >= 0 ? pick : 0).click().catch(() => {});
    } else if (a === 'act') {
      const v = await page.evaluate(() => (document.querySelector('#info')?.textContent.match(/Game\s*(Simple|Standard|Two boards|7 cards|8 cards)/) || [])[1] || 'Simple');
      // the flop is out (board cards on the table) so overlaps with the board count
      const flop = await page.evaluate(() => document.querySelectorAll('#board .slot .card').length >= 3);
      if (!seen.has(v) && flop) { seen.add(v); await sweep(page, `single-${v.replace(/\s+/g, '').toLowerCase()}`); console.log(`single: ${v} measured`); }
      await page.click('#bCall').catch(() => {});
    }
    await page.waitForTimeout(80);
  }
  await ctx.close();
}

if (WHICH === 'online' || WHICH === 'both') {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  for (const c of [host.context(), ctx]) await c.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('river-room-v2', JSON.stringify({ mode: 'home', games: 'dealer', pace: 'fast', review: 'off', sound: false, timer: 0, holdResult: false, hints: true })); } });
  const me = await ctx.newPage();
  await host.goto(SITE); await host.click('#onlineBtn'); await host.click('#olCreateBtn');
  await host.waitForSelector('#wroom:not([hidden])', { timeout: 180_000 });
  const code = (await host.textContent('#wrCode')).trim();
  await me.goto(SITE + '?join=' + code);
  await me.waitForSelector('#olPick:not([hidden]) .rp', { timeout: 60_000 });
  await me.check('#olPick input[value="krish"]');
  await me.click('#olJoinBtn');
  await me.waitForSelector('#wroom:not([hidden])');
  await host.click('#wrStart');
  const seen = new Set(), t0 = Date.now();
  while (seen.size < 3 && Date.now() - t0 < 300_000) {
    for (const p of [host]) { const a = await answer(p); if (a === 'deal') await p.locator('#dealOpts button').first().click().catch(() => {}); if (a === 'act') await p.click('#bCall').catch(() => {}); }
    const a = await answer(me);
    if (a === 'deal') await me.locator('#dealOpts button').nth(seen.size % 3).click().catch(() => {});
    else if (a === 'act') {
      const v = await me.evaluate(() => (document.querySelector('#info')?.textContent.match(/Game\s*(Simple|Standard|Two boards|7 cards|8 cards)/) || [])[1] || 'Simple');
      const flop = await me.evaluate(() => document.querySelectorAll('#board .slot .card').length >= 3);
      if (!seen.has(v) && flop) { seen.add(v); await sweep(me, `online-krish-${v.replace(/\s+/g, '').toLowerCase()}`); console.log(`online (Krish): ${v} measured`); }
      await me.click('#bCall').catch(() => {});
    }
    await me.waitForTimeout(80);
  }
}
await browser.close();

writeFileSync(`${SHOTS}/audit.json`, JSON.stringify(rows, null, 1));
let problems = 0;
for (const r of rows) {
  const issues = [...r.overlaps, ...r.off, ...r.clipped, ...(r.sideScroll ? ['page scrolls sideways'] : [])];
  problems += issues.length ? 1 : 0;
  console.log(`${issues.length ? 'ISSUES' : 'ok    '} ${r.label.padEnd(24)} ${r.size.padEnd(28)} table ${r.table.padEnd(20)} your card ${String(r.heroCardPx).padStart(3)}px board ${String(r.boardCardPx).padStart(3)}px smallest button ${r.smallestButton}px${issues.length ? '\n         ' + issues.join('; ') : ''}`);
}
console.log(`${rows.length} cases measured, ${problems} with issues`);
