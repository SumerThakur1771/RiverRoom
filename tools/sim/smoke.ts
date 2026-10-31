import { newGame } from '../../src/engine/engine';
import { runSession, scriptedHero } from '../../src/sim/driver';
for (const [mode, games] of [['home', 'holdem'], ['home', 'dealer'], ['tourney', 'dealer']] as const) {
  const g = newGame({ mode, seed: 'smoke-' + mode + games, settings: { name: '', opp: 5, stack: 1500, perLevel: 10, revealAll: true, games } });
  const t0 = performance.now(); const n = runSession(g, scriptedHero, 60);
  const chips = g.players.reduce((a, p) => a + p.stack, 0), buyins = g.players.reduce((a, p) => a + p.buyins, 0);
  console.log(mode, games, 'hands', n, 'ms', Math.round(performance.now() - t0), 'chips', chips, mode === 'home' ? 'expected ' + buyins * 1000 : '');
}
