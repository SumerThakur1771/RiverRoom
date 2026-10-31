// Golden-trace recorder: plays seeded sessions of the ORIGINAL game (legacy/river-room.html)
// in headless Chromium and saves every hand's history log, coach grades and final stacks.
// The TypeScript port must reproduce these traces exactly (see test/golden.test.ts).
//
// How determinism works (the same scheme is implemented in src/engine/rng.ts):
//  - Math.random is replaced by a seeded generator (mulberry32).
//  - Each random "segment" of the game gets its own stream, seeded by hash(seed + '|' + label):
//      setup, h<N>:start, h<N>:deck, h<N>:variant, h<N>:plans, h<N>:ai:<k>, h<N>:coach:<k>,
//      h<N>:rec:<k>, h<N>:allin:<k>, h<N>:final, h<N>:reveal, h<N>:mood,
//      b2tab:<cards>, h5tab, opp:<variant>
//    so cosmetic randomness (chat lines, sounds) can never shift a card or a decision.
//  - The deck uses the stream instead of crypto.getRandomValues.
//  - The hero is played by a fixed policy keyed on hash(seed + '|' + h<N>:hero:<k>).
//
// Usage: node tools/golden/record.mjs [--check]   (--check records twice and compares)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildRecorderPage } from './legacy-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'test', 'golden');
const CHECK = process.argv.includes('--check');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

export const SESSIONS = [
  { id: 'home-holdem', mode: 'home', force: 'holdem', hands: 40 },
  { id: 'home-std', mode: 'home', force: 'std', hands: 40 },
  { id: 'home-two', mode: 'home', force: 'two', hands: 40 },
  { id: 'home-k8', mode: 'home', force: 'k8', hands: 30 },
  { id: 'home-n7', mode: 'home', force: 'n7', hands: 40 },
  { id: 'home-dealer', mode: 'home', force: null, hands: 40 },
  { id: 'tourney-a', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-b', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-c', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-d', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-e', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-f', mode: 'tourney', force: null, hands: 60 },
];

const page = buildRecorderPage();

async function runSession(browser, cfg) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const seed = 'golden-' + cfg.id;
  await ctx.addInitScript(({ seed, cfg }) => {
    localStorage.setItem('river-room-v2', JSON.stringify({ mode: cfg.mode, games: 'dealer', pace: 'fast', review: 'off', sound: false, timer: 0, holdResult: false, revealAll: true, hints: true, showEq: false, opp: 5, stack: 1500, perLevel: 10 }));
    Object.assign(window, { __seed: seed, __auto: true, __force: cfg.force, __stopAt: cfg.hands, __trace: [] });
  }, { seed, cfg });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
  await pg.goto('file://' + page);
  await pg.click('#startBtn');
  const setup = await pg.evaluate(() => window.__setup);
  const t0 = Date.now();
  await pg.waitForFunction(() => window.__done || window.__crash, null, { timeout: 20 * 60 * 1000, polling: 200 });
  const res = await pg.evaluate(() => ({ trace: window.__trace, crash: window.__crash || null, tableNo: window.__rr().tableNo }));
  await ctx.close();
  return { id: cfg.id, seed, config: cfg, tableNo: res.tableNo, setup, hands: res.trace, crash: res.crash, errors, ms: Date.now() - t0 };
}

const browser = await chromium.launch();
mkdirSync(OUT, { recursive: true });
let failed = false;
const results = await Promise.all(SESSIONS.filter(c => !ONLY.length || ONLY.includes(c.id)).map(async cfg => {
  const a = await runSession(browser, cfg);
  let same = null;
  if (CHECK) { const b = await runSession(browser, cfg); same = JSON.stringify(a.hands) === JSON.stringify(b.hands) && JSON.stringify(a.setup) === JSON.stringify(b.setup);
    if (!same) { const d = join(ROOT, 'tools', 'golden', '.diff'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, cfg.id + '.a.json'), JSON.stringify(a, null, 1)); writeFileSync(join(d, cfg.id + '.b.json'), JSON.stringify(b, null, 1)); } }
  return { a, same };
}));
await browser.close();
for (const { a, same } of results) {
  const { errors, ms, ...rest } = a;
  writeFileSync(join(OUT, a.id + '.json'), JSON.stringify(rest) + '\n');
  const lines = a.hands.reduce((n, h) => n + h.lines.length, 0);
  console.log(`${a.id.padEnd(12)} hands=${String(a.hands.length).padStart(3)} lines=${String(lines).padStart(5)} ${(ms / 1000).toFixed(0)}s` +
    (a.crash ? ' CRASH ' + a.crash.split('\n')[0] : '') + (errors.length ? ` errors=${errors.length}: ${errors[0]}` : '') + (same === null ? '' : same ? ' deterministic=yes' : ' deterministic=NO'));
  if (a.crash || errors.length || same === false) failed = true;
}
process.exit(failed ? 1 : 0);
