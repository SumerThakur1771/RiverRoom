// Small helpers over the game state (same names as the original).
import type { Game, GameEvent, Player } from './state';
import { VARIANTS, type Variant } from './variants';

export const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));

/** Money format: cents as dollars in the home game, plain chips in tournaments. */
export function fmt(g: Pick<Game, 'money'>, n: number): string {
  return g.money ? (n < 0 ? '-$' : '$') + (Math.abs(Math.round(n)) / 100).toFixed(2) : Math.round(n).toLocaleString('en-US');
}

/** The split variant being played, or null for plain hold'em. */
export const VAR = (g: Game): Variant | null => (g.variant && g.variant !== 'holdem' ? VARIANTS[g.variant] : null);
export const liveList = (g: Game): Player[] => g.players.filter(p => !p.out && !p.folded);
export const ableList = (g: Game): Player[] => liveList(g).filter(p => !p.allIn);
export const heroP = (g: Game): Player => g.players.find(p => p.isHuman) as Player;
export const potTotal = (g: Game): number => g.pot + g.players.reduce((a, p) => a + p.bet, 0);
export const needsAction = (g: Game, p: Player): boolean => !p.out && !p.folded && !p.allIn && (!p.acted || p.bet < g.currentBet);
export const nm = (p: Player): string => (p.isHuman ? 'You' : p.name);
export const ordinal = (n: number): string => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th');

export function nextAlive(g: Game, i: number): number {
  const n = g.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (i + k) % n;
    if (!g.players[j]!.out) return j;
  }
  return i;
}
export function roundChips(g: Game, x: number): number {
  const u = g.money ? 10 : g.bb >= 400 ? 50 : g.bb >= 100 ? 25 : 5;
  return Math.max(u, Math.round(x / u) * u);
}
export function lg(g: Game, t: string): void { g.hist.push(t); }
export function ev(g: Game, e: GameEvent): void { e.st = g.street; g.ev.push(e); }

/* ---- positions ---- */
export function seatOrder(g: Game): Player[] {
  const out: Player[] = [], n = g.players.filter(p => !p.out).length;
  let k = nextAlive(g, g.button);
  for (let j = 0; j < n; j++) {
    out.push(g.players[k]!);
    k = nextAlive(g, k);
  }
  return out;
}
export interface Pos { label: string; key: 'hu' | 'sb' | 'bb' | 'btn' | 'co' | 'hj' | 'ep'; name: string }
export function posInfo(g: Game, p: Player): Pos {
  const ord = seatOrder(g), n = ord.length, i = ord.indexOf(p);
  if (n === 2) return p.i === g.button ? { label: 'BTN', key: 'hu', name: 'on the button (small blind)' } : { label: 'BB', key: 'bb', name: 'in the big blind' };
  if (i === 0) return { label: 'SB', key: 'sb', name: 'in the small blind' };
  if (i === 1) return { label: 'BB', key: 'bb', name: 'in the big blind' };
  const fromBtn = n - 1 - i;
  if (fromBtn === 0) return { label: 'BTN', key: 'btn', name: 'on the button (best seat)' };
  if (fromBtn === 1) return { label: 'CO', key: 'co', name: 'in the cutoff (one before the button)' };
  if (fromBtn === 2) return { label: 'HJ', key: 'hj', name: 'in the hijack (middle position)' };
  return { label: 'UTG', key: 'ep', name: 'under the gun (first to act)' };
}
export function inPosition(g: Game, p: Player): boolean {
  const n = g.players.length, live = liveList(g).filter(x => x !== p && !x.allIn);
  const d = (x: Player): number => (x.i - g.button - 1 + n) % n;
  return live.every(x => d(x) < d(p));
}
export function effStack(g: Game, p: Player): number {
  const opp = liveList(g).filter(x => x !== p);
  if (!opp.length) return p.stack + p.bet;
  return Math.min(p.stack + p.bet, Math.max(...opp.map(x => x.stack + x.bet)));
}
