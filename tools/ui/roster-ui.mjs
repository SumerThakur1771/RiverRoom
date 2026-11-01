// Browser test for the home game roster on the start screen (desktop and phone):
// pick who you play, rename (and refuse a duplicate name), remove, add up to six, start a game
// with that table, play a few hands of dealer's choice at six players, reload (the roster is
// remembered), and reset to the original five. Checks for page errors, sideways scrolling and
// accessibility (axe-core, WCAG 2.1 A/AA) on the editor.
//
// Usage: node tools/ui/roster-ui.mjs [url=http://localhost:4173/]
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'http://localhost:4173/';
const axeSrc = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
mkdirSync('screenshots', { recursive: true });
const browser = await chromium.launch();
let failed = false;

for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, hasTouch: label === 'phone' });
  await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('river-room-v2', JSON.stringify({ mode: 'home', games: 'dealer', pace: 'fast', review: 'off', sound: false, timer: 0, holdResult: false, revealAll: true, hints: false })); } });
  const page = await ctx.newPage();
  const errors = [], checks = {};
  page.on('pageerror', e => errors.push(e.message));
  const rows = () => page.$$eval('#homeRoster .rp', els => els.map(e => ({ id: e.dataset.id, name: e.querySelector('b').textContent, me: e.classList.contains('me') })));
  const you = async () => (await rows()).find(r => r.me)?.name;
  const err = async () => (await page.textContent('#rosterErr')).trim();

  await page.goto(URL_ + '?seed=roster-ui');
  await page.waitForSelector('#homeRoster .rp');
  checks.start = (await rows()).map(r => r.name).join(',') + ' you=' + (await you());
  checks.nameFieldHidden = !(await page.isVisible('#nameIn'));
  // pick Rohit
  await page.check('#homeRoster input[value="rohit"]');
  checks.picked = await you();
  // rename Krish to KK; a duplicate name is refused
  await page.click('.rp[data-id="krish"] [data-act="rename"]');
  await page.fill('.rp-name', 'KK');
  await page.press('.rp-name', 'Enter');
  checks.renamed = (await rows()).find(r => r.id === 'krish')?.name;
  await page.click('.rp[data-id="nikhil"] [data-act="rename"]');
  await page.fill('.rp-name', 'rohit');
  await page.click('.rp[data-id="nikhil"] [data-act="save"]');
  checks.duplicateRefused = await err();
  await page.click('.rp[data-id="nikhil"] [data-act="cancel"]');
  // remove Venky; add Asha and Bo (six seats); the add row is replaced by "the table is full"
  await page.click('.rp[data-id="venky"] [data-act="remove"]');
  for (const [name, style] of [['Asha', 'nikhil'], ['Bo', 'krish']]) {
    await page.fill('#rpNewName', name);
    await page.selectOption('#rpNewStyle', style);
    await page.click('#rpAdd');
  }
  checks.afterEdits = (await rows()).map(r => r.name).join(',');
  checks.full = (await page.isVisible('.rp-note')) && !(await page.isVisible('#rpAdd'));
  checks.noSideScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.addScriptTag({ content: axeSrc });
  const axe = await page.evaluate(() => window.axe.run(document.getElementById('startOv'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  checks.axeViolations = axe.violations.map(v => `${v.id} (${v.nodes.length})`).join(', ') || 'none';
  await page.screenshot({ path: `screenshots/roster-${label}.png`, fullPage: true });
  // start: the seats are this roster, with you as Rohit
  await page.click('#startBtn');
  await page.waitForSelector('.seat.hero');
  await page.waitForTimeout(500);
  checks.seats = (await page.$$eval('.seat:not(.empty) .nm', els => els.map(e => e.textContent))).join(',');
  checks.heroSeat = await page.textContent('.seat.hero .nm');
  // a few hands of dealer's choice at six players
  const t0 = Date.now();
  let hands = 0;
  while (Date.now() - t0 < 75_000) {
    if (await page.isVisible('#dealOv')) await page.locator('#dealOpts button').first().click();
    if (await page.isVisible('#splitOv')) await page.click('#spLock');
    if (await page.isVisible('#rebuyOv')) await page.click('#rebuyYes');
    if (await page.isVisible('#contRow')) await page.click('#contBtn');
    if (await page.isVisible('#act')) await page.click('#bCall').catch(() => {});
    hands = await page.evaluate(() => +(document.querySelector('#info')?.textContent?.match(/Hand#(\d+)/)?.[1] ?? 0));
    await page.waitForTimeout(60);
  }
  checks.handsReached = hands;
  // reload: the roster and your pick are remembered; reset brings back the original five
  await page.goto(URL_ + '?seed=roster-ui-2');
  await page.waitForSelector('#homeRoster .rp');
  checks.remembered = (await rows()).map(r => r.name).join(',') + ' you=' + (await you());
  await page.click('#rpReset');
  checks.reset = (await rows()).map(r => r.name).join(',') + ' you=' + (await you());

  const ok = checks.start === 'Sumer,Rohit,Krish,Nikhil,Venky you=Sumer' && checks.nameFieldHidden && checks.picked === 'Rohit' && checks.renamed === 'KK'
    && checks.duplicateRefused === 'rohit is already at the table.' && checks.afterEdits === 'Sumer,Rohit,KK,Nikhil,Asha,Bo' && checks.full && checks.noSideScroll
    && checks.axeViolations === 'none' && checks.seats.split(',').sort().join(',') === 'Asha,Bo,KK,Nikhil,Rohit,Sumer' && checks.heroSeat === 'Rohit'
    && checks.handsReached >= 2 && checks.remembered === 'Sumer,Rohit,KK,Nikhil,Asha,Bo you=Rohit' && checks.reset === 'Sumer,Rohit,Krish,Nikhil,Venky you=Sumer' && !errors.length;
  console.log(`${label}: ${ok ? 'ok' : 'FAIL'} | ${JSON.stringify(checks)}${errors.length ? ' | errors: ' + errors.join(' | ') : ''}`);
  if (!ok) failed = true;
  await ctx.close();
}
await browser.close();
console.log(failed ? 'RESULT: FAIL' : 'RESULT: ok');
process.exit(failed ? 1 : 0);
