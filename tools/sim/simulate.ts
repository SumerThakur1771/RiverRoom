// Headless simulator: per-persona statistics for every game.
//
// For each game it first times a short pilot, then picks a hand count that fits the time
// budget (so the slow 8-card game gets fewer hands than Hold'em), and reports per persona:
// VPIP, PFR, postflop aggression frequency, went-to-showdown, and win rate in big blinds per
// 100 hands with a 95% confidence interval. The hero seat is the scripted hero used in the
// golden and parity runs (it plays loose and raises a lot, which the win rates reflect).
//
// Usage: npx tsx tools/sim/simulate.ts [secondsPerGame=90]
import { writeFileSync } from 'node:fs';
import { newGame } from '../../src/engine/engine';
import type { Mode } from '../../src/engine/state';
import type { VariantKey } from '../../src/engine/variants';
import { runHand, scriptedHero } from '../../src/sim/driver';

const BUDGET = +(process.argv[2] || 90);
const GAMES: Array<[string, Mode, VariantKey | null]> = [
  ['holdem', 'home', 'holdem'], ['std', 'home', 'std'], ['two', 'home', 'two'], ['n7', 'home', 'n7'], ['k8', 'home', 'k8'], ['tourney', 'tourney', null],
];
const settings = { name: '', opp: 5, stack: 1500, perLevel: 10, revealAll: false, games: 'dealer' as const };

interface Acc { hands: number; vpip: number; pfr: number; agg: number; calls: number; sawFlop: number; wtsd: number; net: number[] }
function play(mode: Mode, force: VariantKey | null, hands: number, seedBase: string): { per: Record<string, Acc>; played: number; ms: number } {
  const per: Record<string, Acc> = {};
  const t0 = performance.now();
  let played = 0, session = 0;
  while (played < hands) {
    const g = newGame({ mode, seed: `${seedBase}-${session++}`, settings });
    const sessionHands = mode === 'tourney' ? 60 : Math.min(500, hands - played);
    for (let h = 0; h < sessionHands && played < hands; h++) {
      if (mode === 'tourney' && (g.players[0]!.out || g.players.filter(p => !p.out).length === 1)) break;
      const before = new Map(g.players.map(p => [p, { stack: p.stack, buyins: p.buyins }]));
      runHand(g, scriptedHero, force ? { forceVariant: force } : {});
      played++;
      for (const p of g.players) {
        if (p.isHuman || !p.persona) continue;
        const a = (per[p.type!] ||= { hands: 0, vpip: 0, pfr: 0, agg: 0, calls: 0, sawFlop: 0, wtsd: 0, net: [] });
        // a bot that went broke rebuys for 1000 at the end of the hand: that is not winnings
        const b = before.get(p)!;
        a.net.push((p.stack - b.stack - 1000 * (p.buyins - b.buyins)) / g.bb);
      }
    }
    for (const p of g.players) {
      if (p.isHuman || !p.persona) continue;
      const a = per[p.type!]!;
      a.hands += p.hud.hands; a.vpip += p.hud.vpip; a.pfr += p.hud.pfr; a.agg += p.hud.agg; a.calls += p.hud.calls; a.sawFlop += p.hud.sawFlop; a.wtsd += p.hud.wtsd;
    }
  }
  return { per, played, ms: performance.now() - t0 };
}

const out: string[] = [];
const log = (s: string): void => { console.log(s); out.push(s); };
log(`Simulator, ${BUDGET}s budget per game, Node ${process.version}, ${new Date().toISOString().slice(0, 10)}`);
for (const [name, mode, force] of GAMES) {
  const pilot = play(mode, force, 20, `sim-pilot-${name}`);
  const perHand = pilot.ms / pilot.played;
  const hands = Math.max(50, Math.floor((BUDGET * 1000) / perHand / 50) * 50);
  const r = play(mode, force, hands, `sim-${name}`);
  log(`\n${name}: ${r.played} hands in ${(r.ms / 1000).toFixed(1)} s (${(r.ms / r.played).toFixed(1)} ms/hand; pilot ${perHand.toFixed(1)} ms/hand)`);
  log('  persona   hands   VPIP    PFR   aggr  WTSD    bb/100 (95% CI)');
  for (const [type, a] of Object.entries(r.per).sort()) {
    const n = a.net.length, mean = a.net.reduce((x, y) => x + y, 0) / n, sd = Math.sqrt(a.net.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, n - 1));
    const half = 1.96 * sd / Math.sqrt(n);
    const pc = (x: number): string => (100 * x).toFixed(1).padStart(5) + '%';
    log(`  ${type.padEnd(8)} ${String(a.hands).padStart(6)} ${pc(a.vpip / a.hands)} ${pc(a.pfr / a.hands)} ${pc(a.agg / Math.max(1, a.agg + a.calls))} ${pc(a.wtsd / Math.max(1, a.sawFlop))}   ${(100 * mean).toFixed(1).padStart(7)} (${(100 * (mean - half)).toFixed(1)} to ${(100 * (mean + half)).toFixed(1)})`);
  }
}
writeFileSync(new URL(`../measure/results/${new Date().toISOString().slice(0, 10)}-simulator.txt`, import.meta.url), out.join('\n') + '\n');
