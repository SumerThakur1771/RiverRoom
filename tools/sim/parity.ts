// Bot parity: do the TypeScript bots play like the original ones?
// Plays the same session plan as tools/golden/persona-stats.mjs (same scripted hero, same
// games, same number of hands) and compares each persona's VPIP, PFR and postflop
// aggression factor with the original's numbers in test/parity/legacy-stats.json.
//
// Usage: npx tsx tools/sim/parity.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { newGame } from '../../src/engine/engine';
import type { Mode } from '../../src/engine/state';
import type { VariantKey } from '../../src/engine/variants';
import { runSession, scriptedHero } from '../../src/sim/driver';

type Tot = { hands: number; vpip: number; pfr: number; agg: number; calls: number; sawFlop: number; wtsd: number };
const PLAN: Array<[string, Mode, VariantKey | null, number, number]> = [
  ['home-holdem', 'home', 'holdem', 8, 250],
  ['home-std', 'home', 'std', 4, 100],
  ['tourney', 'tourney', null, 4, 250],
];

const totals: Record<string, Record<string, Tot>> = {};
const add = (group: string, type: string, hud: Tot): void => {
  const t = ((totals[group] ||= {})[type] ||= { hands: 0, vpip: 0, pfr: 0, agg: 0, calls: 0, sawFlop: 0, wtsd: 0 });
  for (const k of Object.keys(t) as Array<keyof Tot>) t[k] += hud[k];
};
const t0 = performance.now();
let handsPlayed = 0;
for (const [group, mode, force, seeds, hands] of PLAN) {
  for (let i = 0; i < seeds; i++) {
    let done = 0, k = 0;
    while (done < hands) {
      const g = newGame({ mode, seed: `parity-${group}-${i}-${k++}`, settings: { name: '', opp: 5, stack: 1500, perLevel: 10, revealAll: true, games: 'dealer' } });
      const n = runSession(g, scriptedHero, mode === 'tourney' ? Math.min(60, hands - done) : hands, force ? { forceVariant: force } : {});
      for (const p of g.players) if (!p.isHuman) add(group, p.type!, p.hud);
      done += n; handsPlayed += n;
    }
  }
}
const secs = (performance.now() - t0) / 1000;

const legacy = JSON.parse(readFileSync(new URL('../../test/parity/legacy-stats.json', import.meta.url), 'utf8')) as { handsPlayed: number; totals: typeof totals };
writeFileSync(new URL('../../test/parity/ts-stats.json', import.meta.url), JSON.stringify({ handsPlayed, seconds: +secs.toFixed(1), totals }, null, 1) + '\n');

// Tolerance: VPIP and PFR within 3 standard errors of the difference (binomial, both samples),
// with a floor of 3 percentage points; aggression factor within 30% (it is a ratio of counts).
let bad = 0;
const pct = (x: number): string => (100 * x).toFixed(1).padStart(5) + '%';
console.log(`TS: ${handsPlayed} hands in ${secs.toFixed(0)} s.  Original: ${legacy.handsPlayed} hands.`);
console.log('group        persona   hands(orig/ts)    VPIP orig/ts        PFR orig/ts         AF orig/ts');
for (const [group, types] of Object.entries(legacy.totals)) {
  for (const [type, a] of Object.entries(types)) {
    const b = totals[group]?.[type];
    if (!b) { console.log(`${group} ${type}: missing in TS run`); bad++; continue; }
    const tolP = (x: number, y: number): number => Math.max(0.03, 3 * Math.sqrt(x * (1 - x) / a.hands + y * (1 - y) / b.hands));
    const v1 = a.vpip / a.hands, v2 = b.vpip / b.hands, p1 = a.pfr / a.hands, p2 = b.pfr / b.hands;
    const af1 = a.agg / Math.max(1, a.calls), af2 = b.agg / Math.max(1, b.calls);
    const okV = Math.abs(v1 - v2) <= tolP(v1, v2), okP = Math.abs(p1 - p2) <= tolP(p1, p2), okA = Math.abs(af1 - af2) <= 0.3 * Math.max(af1, af2, 0.2);
    if (!okV || !okP || !okA) bad++;
    console.log(`${group.padEnd(12)} ${type.padEnd(8)} ${String(a.hands).padStart(5)}/${String(b.hands).padEnd(5)}   ${pct(v1)}/${pct(v2)} ${okV ? 'ok ' : 'OFF'}   ${pct(p1)}/${pct(p2)} ${okP ? 'ok ' : 'OFF'}   ${af1.toFixed(2)}/${af2.toFixed(2)} ${okA ? 'ok' : 'OFF'}`);
  }
}
console.log(bad ? `RESULT: ${bad} persona/game rows outside tolerance` : 'RESULT: all personas within tolerance');
process.exit(bad ? 1 : 0);
