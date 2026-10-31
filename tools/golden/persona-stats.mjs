// Per-persona play statistics from the ORIGINAL game, for the bot parity test.
// Plays long seeded sessions in headless Chromium (same instrumented page and scripted hero
// as record.mjs) and sums each bot's HUD counters by persona type and game.
// Output: test/parity/legacy-stats.json
//
// Usage: node tools/golden/persona-stats.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildRecorderPage } from './legacy-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page = buildRecorderPage();

// [group, mode, forced variant, seeds, hands per session]
const PLAN = [
  ['home-holdem', 'home', 'holdem', 8, 250],
  ['home-std', 'home', 'std', 4, 100],
  ['tourney', 'tourney', null, 4, 250], // tournaments end when the hero busts: keep starting new ones
];

async function session(browser, mode, force, seed, hands) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript(({ seed, mode, force, hands }) => {
    localStorage.setItem('river-room-v2', JSON.stringify({ mode, games: 'dealer', pace: 'fast', review: 'off', sound: false, timer: 0, holdResult: false, revealAll: true, hints: true, showEq: false, opp: 5, stack: 1500, perLevel: 10 }));
    Object.assign(window, { __seed: seed, __auto: true, __force: force, __stopAt: hands });
  }, { seed, mode, force, hands });
  const pg = await ctx.newPage();
  await pg.goto('file://' + page);
  await pg.click('#startBtn');
  await pg.waitForFunction(() => window.__done || window.__crash, null, { timeout: 60 * 60 * 1000, polling: 500 });
  const res = await pg.evaluate(() => ({ crash: window.__crash || null, handNo: window.__rr().handNo, players: window.__rr().players.filter(p => !p.isHuman).map(p => ({ type: p.type, hud: p.hud })) }));
  await ctx.close();
  return res;
}

const browser = await chromium.launch();
const totals = {};
const add = (group, players) => {
  for (const p of players) {
    const t = ((totals[group] ||= {})[p.type] ||= { hands: 0, vpip: 0, pfr: 0, agg: 0, calls: 0, sawFlop: 0, wtsd: 0 });
    for (const k of Object.keys(t)) t[k] += p.hud[k];
  }
};
let handsPlayed = 0;
const t0 = Date.now();
await Promise.all(PLAN.flatMap(([group, mode, force, seeds, hands]) => Array.from({ length: seeds }, async (_, i) => {
  if (mode === 'tourney') {
    let done = 0, k = 0;
    while (done < hands) {
      const r = await session(browser, mode, force, `stats-${group}-${i}-${k++}`, 60);
      if (r.crash) throw new Error(r.crash);
      add(group, r.players); done += r.handNo; handsPlayed += r.handNo;
    }
  } else {
    const r = await session(browser, mode, force, `stats-${group}-${i}`, hands);
    if (r.crash) throw new Error(r.crash);
    add(group, r.players); handsPlayed += r.handNo;
  }
})));
await browser.close();
mkdirSync(join(ROOT, 'test', 'parity'), { recursive: true });
writeFileSync(join(ROOT, 'test', 'parity', 'legacy-stats.json'), JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), handsPlayed, totals }, null, 1) + '\n');
console.log(`hands played: ${handsPlayed} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
for (const [g, types] of Object.entries(totals)) for (const [t, s] of Object.entries(types))
  console.log(`${g.padEnd(12)} ${t.padEnd(8)} hands=${String(s.hands).padStart(5)} VPIP=${(100 * s.vpip / s.hands).toFixed(1)}% PFR=${(100 * s.pfr / s.hands).toFixed(1)}% AF=${(s.agg / Math.max(1, s.calls)).toFixed(2)}`);
