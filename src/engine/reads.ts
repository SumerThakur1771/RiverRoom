// What each player's actions reveal. The engine updates these after every action; bots and
// the coach read them to model opponents' likely cards.
import type { RangeModel } from '../ai/equity';
import { OPEN } from './personas';
import type { Game, Persona, Player } from './state';
import { clamp, effStack, posInfo, potTotal } from './table';

/** A style is known in your own home game, or once you have a read on a tournament player. */
export function knownStyle(g: Game, p: Player | null | undefined): Persona | null {
  return !p || p.isHuman || !p.persona ? null : g.money || p.read ? p.persona : null;
}
export function estOpen(g: Game, p: Player): number {
  const ks = knownStyle(g, p);
  if (ks) return ks.home ? (ks.clueless ? 0.9 : 0.06) : clamp(OPEN[posInfo(g, p).key] * ks.open, 0.04, 0.9);
  const h = p.hud;
  if (h.hands >= 12) return clamp((h.pfr / h.hands) * 1.25, 0.04, 0.9);
  return 0.22;
}
export function estVpip(g: Game, p: Player): number {
  const ks = knownStyle(g, p);
  if (ks && ks.home) return clamp(ks.limpTop * 1.1, 0.1, 0.95);
  const h = p.hud;
  if (h.hands >= 12) return clamp((h.vpip / h.hands) * 1.1, 0.08, 0.95);
  return 0.42;
}
export function est3b(p: Player): number {
  const h = p.hud;
  if (h.threeOpp >= 6) return clamp((h.three / h.threeOpp) * 1.2, 0.02, 0.3);
  return 0.07;
}
export function bluffEst(g: Game, p: Player): number {
  const ks = knownStyle(g, p);
  if (ks) return ks.clueless ? 0.6 : clamp(ks.bluff * 0.9 + 0.04, 0.04, 0.55);
  const h = p.hud, n = h.agg + h.calls;
  if (n >= 15) {
    const af = h.agg / Math.max(1, h.calls);
    return clamp(0.12 + 0.08 * af, 0.1, 0.55);
  }
  return 0.3;
}
/** Tight players and Nikhil's big bets: a big bet after betting before means two pair or better. */
export function rangeModel(g: Game, p: Player): RangeModel {
  const ks = knownStyle(g, p);
  return { top: p.rg.top, low: p.rg.low, agg: p.rg.agg, raised: p.rg.raised, calls: p.rg.calls, big: p.rg.big || 0, bluff: bluffEst(g, p), tight: !!(ks && (ks.bigFold || ks.bigValue || ks.label === 'Rock')) };
}
export function updateRange(g: Game, p: Player, kind: string, preRaises: number): void {
  const r = p.rg;
  if (g.street === 0) {
    if (kind === 'raise') {
      if (preRaises === 0) r.top = Math.min(r.top, p.allIn && effStack(g, p) / g.bb <= 15 ? Math.max(estOpen(g, p), 0.3) : estOpen(g, p));
      else if (preRaises === 1) r.top = Math.min(r.top, p.allIn ? Math.max(est3b(p), 0.12) : est3b(p));
      else r.top = Math.min(r.top, p.allIn ? 0.08 : 0.035);
      r.low = 0;
    } else if (kind === 'call') {
      if (preRaises === 0) { r.top = Math.min(r.top, estVpip(g, p)); r.low = Math.max(r.low, 0.03); }
      else if (preRaises === 1) { r.top = Math.min(r.top, clamp(estVpip(g, p) * 0.55, 0.06, 0.5)); r.low = Math.max(r.low, est3b(p) * 0.5); }
      else { r.top = Math.min(r.top, 0.08); r.low = Math.max(r.low, 0.01); }
    }
    if (r.low >= r.top) r.low = r.top * 0.3;
  } else {
    if (kind === 'raise' || kind === 'bet') {
      r.agg++;
      if (kind === 'raise' || (g.money && p.bet >= 100 && !(p.persona && p.persona.clueless))) r.raised = true;
      const bigBet = g.money ? p.bet >= 200 || (p.bet >= 100 && g.street === 3) : p.bet >= potTotal(g) * 0.45 && g.street === 3;
      if (bigBet && !(p.persona && p.persona.clueless)) r.big = (r.big || 0) + 1;
    } else if (kind === 'call') r.calls++;
  }
}
