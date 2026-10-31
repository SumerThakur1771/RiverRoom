// Computer players: preflop and postflop decisions for every persona, ported from the original.
// All randomness comes from `g.rs.rand`; the driver runs each decision in its own named stream.
import { cr, type Card } from '../engine/cards';
import { DEALER_PICKS, normSplit, VAR_ORDER, type Split, type VariantKey } from '../engine/variants';
import { STRONG_FIRST, options, type Action, type Options } from '../engine/engine';
import { OPEN, PUSH, TYPES } from '../engine/personas';
import { rangeModel } from '../engine/reads';
import type { Game, Persona, Player } from '../engine/state';
import { handPct } from '../engine/strength';
import { clamp, effStack, inPosition, liveList, posInfo, potTotal, roundChips, VAR } from '../engine/table';
import { drawInfo, madeInfo } from './equity';
import { gameEquity, holdEquity, planSplit, useSplit, varRankOf } from './split';

type Kind = 'stab' | 'cbet' | 'value' | 'bigvalue' | 'bluff' | 'odd';

function raiseTo(g: Game, o: Options, toIn: number, fallback?: Action): Action {
  if (!o.canRaise) return fallback || (o.toCall > 0 ? { type: 'call' } : { type: 'check' });
  let to = roundChips(g, toIn);
  to = clamp(to, o.minTo, o.maxTo);
  if (to >= o.maxTo * 0.8) to = o.maxTo;
  return { type: 'raise', to };
}
function sizeFrac(g: Game, pr: Persona, kind: Kind): number {
  const rand = g.rs.rand, r = rand();
  const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)]!;
  if (kind === 'stab') return 0.33 + r * 0.27;
  if (pr.size === 'odd') return pick([0.25, 0.33, 0.5, 0.7, 0.9, 1.1]);
  if (pr.size === 'big') return kind === 'cbet' ? 0.6 + r * 0.3 : 0.8 + r * 0.6;
  if (pr.size === 'small') return 0.3 + r * 0.25;
  if (kind === 'cbet') return 0.33 + r * 0.25;
  if (kind === 'value') return (0.55 + r * 0.25) * (g.street === 3 ? 1.15 : 1);
  return 0.5 + r * 0.2;
}
function betAmount(g: Game, pr: Persona, kind: Kind, pot: number): number {
  const rand = g.rs.rand, pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)]!;
  if (pr.size === 'home') {
    // the house style: 20-30c on the flop, about 50c on the turn, $1 or more on the river
    const st = g.street;
    let a = st === 1 ? pick([20, 30, 30]) : st === 2 ? pick([50, 50, 60]) : pick([100, 100, 150, 200]);
    if (kind === 'value') a = Math.max(a, pot * (st === 3 ? 0.5 : 0.35));
    // Nikhil: with a strong hand he bets more than the usual table amount
    if (kind === 'bigvalue') a = Math.max(st === 1 ? pick([60, 80, 100]) : st === 2 ? pick([100, 150]) : pick([150, 200, 300]), pot * 0.7);
    return a;
  }
  if (pr.size === 'wild') return pot * (0.5 + rand() * (2.2 - 0.5));
  return pot * sizeFrac(g, pr, kind);
}
function raiseAmount(g: Game, pr: Persona, pot: number, toCall: number, f: number): number {
  const rand = g.rs.rand;
  if (pr.size === 'home') return g.currentBet * (2 + rand() * (3 - 2));
  if (pr.size === 'wild') return g.currentBet * (2 + rand() * (5 - 2));
  return g.currentBet + (pot + toCall) * f;
}
function openSize(g: Game, pr: Persona, limpers: number): number {
  const rand = g.rs.rand, pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)]!;
  const bb = g.bb;
  if (pr.size === 'home') return bb * pick([2, 3, 3]);
  if (pr.size === 'wild') return bb * pick([2, 3, 5, 10]);
  const x = pr.size === 'odd' ? pick([2, 2, 3, 4]) : pr.size === 'big' ? 3 + rand() * (4 - 3) : pr === TYPES.rock || pr.label === 'Rock' ? 3 : 2.2 + rand() * (2.6 - 2.2);
  return bb * (x + limpers);
}
function callByEquity(g: Game, p: Player, o: Options, margin: number): Action {
  const opps = liveList(g).filter(x => x !== p).map(x => rangeModel(g, x));
  const eq = VAR(g) ? gameEquity(g, p, opps, 200).eq : holdEquity(g, p, p.cards, opps, 380);
  p._eq = eq;
  const pot = potTotal(g), po = o.toCall / (pot + o.toCall);
  return eq >= po + margin ? { type: 'call' } : o.toCall === 0 ? { type: 'check' } : { type: 'fold' };
}

function botPreHome(g: Game, p: Player, o: Options): Action {
  const rand = g.rs.rand, pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)]!;
  const pr = p.persona!, pos = posInfo(g, p), bb = g.bb, R = rand(), toCall = o.toCall, raises = g.streetRaises;
  let pctv = VAR(g) && p.vrank != null ? p.vrank : handPct(p.cards[0]!, p.cards[1]!);
  if (pr.clueless) pctv = 0.4 * pctv + 0.6 * rand();
  p._eq = 1 - pctv;
  const check: Action = { type: 'check' }, fold: Action = { type: 'fold' }, call: Action = { type: 'call' };
  const playTop = Math.min(0.95, pr.limpTop * (1 + p.tilt * 0.5));
  if (toCall > 0 && toCall >= p.stack * 0.45) return callByEquity(g, p, o, pr.clueless ? -0.1 : 0.05);
  if (raises === 0) {
    if (pr.clueless && R < 0.05) return raiseTo(g, o, bb * pick([3, 5, 10]), call);
    if (pctv <= (pr.bigValue ? 0.08 : 0.05) && R < pr.raisePre!) return raiseTo(g, o, pr.bigValue ? pick([40, 60, 60]) : pick([30, 40]), call);
    if (toCall === 0) return check;
    if (pctv <= playTop || (pos.key === 'sb' && pctv <= playTop * 1.3)) return call;
    return fold;
  }
  const cost = g.currentBet;
  const callTop = cost <= 40 ? playTop * 0.85 : cost <= 100 ? Math.min(playTop, 0.15) * (pr.clueless ? 3 : 1) : 0.06 * (pr.clueless ? 4 : 1);
  if (raises === 1 && pctv <= 0.02 && R < pr.raisePre! * 0.5) return raiseTo(g, o, cost * 2.5, call);
  if (pctv <= callTop) return call;
  return toCall === 0 ? check : fold;
}

function botPre(g: Game, p: Player, o: Options): Action {
  if (p.persona!.home) return botPreHome(g, p, o);
  const rand = g.rs.rand;
  const pr = p.persona!, pos = posInfo(g, p), bb = g.bb, R = rand();
  let pctv = handPct(p.cards[0]!, p.cards[1]!);
  if (pr.clueless) pctv = 0.4 * pctv + 0.6 * rand();
  const loose = (x: number): number => Math.min(0.95, x * (1 + p.tilt * 0.7));
  const toCall = o.toCall, raises = g.streetRaises, effBB = effStack(g, p) / bb;
  const check: Action = { type: 'check' }, fold: Action = { type: 'fold' }, call: Action = { type: 'call' };
  const ag = g.lastAggressor;
  const facingBig = toCall > 0 && (toCall >= p.stack * 0.45 || !!(ag && ag.allIn));
  p._eq = 1 - pctv;
  if (facingBig) return callByEquity(g, p, o, 0.04 - pr.sticky * 0.08 - p.tilt * 0.05);
  if (effBB <= 12 && raises === 0) {
    const push = loose(PUSH[pos.key] * Math.pow(10 / Math.max(3, effBB), 0.6) * Math.sqrt(pr.open));
    if (pctv <= push) return raiseTo(g, o, o.maxTo);
    if (toCall === 0) return check;
    if (toCall <= bb / 2 && pctv <= push * 1.6) return call;
    return fold;
  }
  if (raises === 0) {
    const limpers = g.players.filter(x => x !== p && x.i !== g.bbIdx && !x.folded && !x.out && x.bet >= bb).length;
    const openP = loose(OPEN[pos.key] * pr.open), thr = limpers ? openP * 0.7 : openP;
    if (toCall === 0) { if (pctv <= thr * 0.5 || R < pr.bluff * 0.12) return raiseTo(g, o, bb * (3 + limpers)); return check; }
    if (pctv <= thr && R > pr.limp * 0.5) return raiseTo(g, o, openSize(g, pr, limpers));
    if (pr.limp > 0 && pctv <= loose(Math.max(pr.limpTop, thr)) && R < pr.limp + (limpers ? 0.2 : 0)) return call;
    if (pctv <= thr) return raiseTo(g, o, openSize(g, pr, limpers));
    if (pos.key === 'sb' && toCall <= bb / 2 && limpers && pctv <= loose(OPEN.sb * pr.open * 1.4)) return call;
    if (R < pr.noise * 0.25) return call;
    return fold;
  }
  const Rtop = ag ? ag.rg.top : 0.2;
  if (raises === 1) {
    const raiseBB = g.currentBet / bb, sizeF = Math.min(1, 3.2 / Math.max(2, raiseBB)), ip = !['sb', 'bb'].includes(pos.key);
    const tb = clamp(Rtop * 0.2 * pr.three * (1 + p.tilt * 0.5), 0.015, 0.25);
    const cw = clamp(Rtop * 0.55 * pr.call * (pos.key === 'bb' ? 1.5 : ip ? 1 : 0.75) * sizeF * (1 + p.tilt * 0.4), 0.02, 0.6);
    if (pctv <= tb || (R < pr.bluff * 0.12 && pctv <= 0.5 && pos.key !== 'bb')) return raiseTo(g, o, g.currentBet * (ip ? 3 : 3.6), call);
    // home-game habit: small raises get called by most hands people would have limped
    const homeCall = (pr.size === 'home' || pr.size === 'wild') && g.currentBet <= bb * 4 ? pr.limpTop * 0.85 : 0;
    if (pctv <= Math.max(tb + cw, homeCall)) return call;
    if (R < pr.noise * 0.5 && toCall <= bb * 3) return call;
    return fold;
  }
  const four = clamp(Rtop * 0.3 * pr.three, 0.01, 0.05), cont = clamp(Rtop * 0.7 * pr.call, 0.02, 0.14);
  if (pctv <= four) return raiseTo(g, o, effBB < 40 ? o.maxTo : g.currentBet * 2.3, call);
  if (pctv <= four + cont) return call;
  return fold;
}

/** Bots who pay attention adjust to how you play (from your HUD numbers). */
function adaptVs(p: Player, opps: Player[]): { bluff: number; call: number; value: number } {
  const res = { bluff: 1, call: 0, value: 0 };
  const hero = opps.find(x => x.isHuman);
  if (!hero || p.persona!.adapt <= 0) return res;
  const h = hero.hud, a = p.persona!.adapt;
  if (h.fcbOpp >= 4) { const fr = h.fcb / h.fcbOpp; res.bluff *= 1 + (fr - 0.45) * 1.6 * a; }
  if (h.sawFlop >= 8) { const wt = h.wtsd / h.sawFlop; if (wt > 0.38) { res.bluff *= 1 - 0.45 * a; res.value += 0.05 * a; } }
  if (h.agg + h.calls >= 12) { const af = h.agg / Math.max(1, h.calls); if (af > 2.5) res.call -= 0.05 * a; if (af < 0.8) res.call += 0.04 * a; }
  res.bluff = clamp(res.bluff, 0.3, 2);
  return res;
}

function botPost(g: Game, p: Player, o: Options): Action {
  const rand = g.rs.rand;
  const pr = p.persona!, opps = liveList(g).filter(x => x !== p), k = opps.length;
  let eq: number, xs: number[] = [];
  if (VAR(g)) { const r = gameEquity(g, p, opps.map(x => rangeModel(g, x)), k >= 3 ? 160 : 220); eq = r.eq; xs = r.parts.slice(1); }
  else eq = holdEquity(g, p, p.cards, opps.map(x => rangeModel(g, x)), k >= 3 ? 220 : 320);
  const strongOther = xs.some(x => x >= 0.6);
  if (pr.clueless) eq = 0.35 * eq + 0.65 * rand();
  p._eq = eq;
  const pot = potTotal(g), toCall = o.toCall, po = toCall / (pot + toCall);
  const di = drawInfo(p.cards, g.board), draw = di.fd || di.sd === 'oesd';
  if (draw) p.hf.hadDraw = g.street;
  const mi = madeInfo(p.cards, g.board);
  const ip = inPosition(g, p), R = rand(), ad = adaptVs(p, opps), tilt = p.tilt;
  const bluffy = pr.bluff * ad.bluff * (1 + tilt * 0.5);
  const valueTh = (VAR(g) ? Math.max(1 / (k + 1) + 0.08, 0.3) : clamp(1.6 / (k + 1), 0.36, 0.6)) - pr.aggr * 0.04 - ad.value;
  const check: Action = { type: 'check' }, fold: Action = { type: 'fold' }, call: Action = { type: 'call' };
  const betK = (kind: Kind): Action => raiseTo(g, o, betAmount(g, pr, kind, pot));
  const rz = (f: number, fb: Action): Action => raiseTo(g, o, raiseAmount(g, pr, pot, toCall, f), fb);
  const barrel = p.hf.lastAggSt === g.street - 1 && g.street >= 2;
  const missedDraw = g.street === 3 && p.hf.hadDraw && eq < 0.3;
  if (toCall === 0) {
    if (eq >= 0.8 && g.street < 3 && R < pr.trap) return check;
    if (pr.clueless && R < 0.03) return raiseTo(g, o, o.maxTo);
    if (eq >= valueTh && R < 0.55 + pr.aggr * 0.4) return betK(pr.bigValue && eq >= Math.max(0.68, valueTh + 0.2) && rand() < pr.bigValue ? 'bigvalue' : 'value');
    if (pr.overplay && mi.cat === 1 && mi.improves && R < pr.overplay) return betK('value');
    if (p === g.pfAggressor && g.street === 1 && R < pr.cbet * (k === 1 ? 1 : 0.55) * Math.sqrt(ad.bluff)) return betK('cbet');
    // keep firing after betting the last street: with draws, decent hands and some pure bluffs
    if (barrel && R < (draw ? pr.aggr * 0.75 : eq > 0.4 ? 0.25 + pr.aggr * 0.3 : bluffy * 1.4) * (k === 1 ? 1 : 0.5)) return betK(draw ? 'bluff' : 'value');
    if (draw && R < pr.aggr * 0.5) return betK('bluff');
    // the draw missed: some players turn it into a bluff on the river
    if (missedDraw && k === 1 && R < bluffy * 2.2) return betK('bluff');
    // everyone checked to me: take a stab at the pot
    if (ip && R < (0.12 + pr.aggr * 0.3 + bluffy * 0.6) * (k === 1 ? 1 : 0.5) * (pr.stab || 1)) return betK('stab');
    if (p !== g.pfAggressor && !ip && eq > 0.35 && R < pr.donk) return betK('odd');
    if (R < bluffy * (k === 1 ? 0.6 : 0.2) * (ip ? 1.2 : 0.8) * (pr.stab || 1)) return betK('bluff');
    return check;
  }
  const raiseTh = VAR(g) ? 1 / (k + 1) + 0.2 : Math.max(valueTh + 0.16, 0.66 - (k - 1) * 0.08);
  const crSpot = p.hf[`checked${g.street}`];
  if (pr.bigFold && toCall >= Math.max(pot * 0.45, g.bb * 3) && !mi.improves && !draw && !strongOther) return fold;
  if (pr.home && toCall >= 100) {
    // at this table $1 is a lot: people need a strong hand to continue
    if (pr.clueless) return (mi.improves && R < 0.7) || R < 0.12 ? call : fold;
    const strong = (mi.cat >= 2 && mi.improves) || (mi.topPair && eq > 0.6) || eq > 0.75 || (strongOther && eq > 0.5);
    if (!strong) return fold;
    if (pr.overplay && (mi.cat >= 3 || eq > 0.82) && R < 0.65) return rz(0.8, call);
    return call;
  }
  if (eq >= raiseTh && R < pr.aggr * (crSpot ? 0.5 + pr.cr : 0.75)) return rz(0.7 + rand() * (1.05 - 0.7), call);
  if (pr.overplay && mi.cat === 1 && mi.improves && k === 1 && R < pr.overplay * 0.25) return rz(0.8, call);
  if (draw && k === 1 && g.street < 3 && R < pr.aggr * pr.bluff * 1.6) return rz(0.8, call);
  // check-raise or raise as a bluff
  if (k === 1 && g.street < 3 && R < (crSpot ? pr.cr * 0.35 : 0.1) * bluffy * 2) return rz(0.75, fold);
  const implied = draw && g.street < 3 ? 0.07 : di.sd === 'gut' && g.street < 3 ? 0.03 : 0;
  const margin = 0.03 + (1 - pr.sticky) * 0.05 - pr.sticky * 0.1 - tilt * 0.05 + ad.call - implied + (toCall > p.stack * 0.5 ? 0.05 : 0) + (pr.home && !pr.clueless ? (toCall / 100) * 0.06 : 0);
  if (eq >= po + margin) return call;
  // "float": call a flop bet with little, planning to take the pot away later
  if (g.street === 1 && ip && k === 1 && toCall <= pot * 0.6 && R < pr.aggr * 0.2 + pr.bluff * 0.25) return call;
  // curiosity: small bets get called by a pair or an ace
  if (toCall <= pot * 0.4 && toCall < p.stack * 0.15 && (mi.improves || p.cards.some((c: Card) => cr(c) === 14)) && R < 0.08 + pr.sticky * 0.6) return call;
  if (pr.sticky > 0.6 && mi.improves && R < pr.sticky * 0.5 && toCall < p.stack * 0.4) return call;
  return fold;
}

/** A bot's decision (the original aiAction, without the thinking-time delay and chat). */
export function botAction(g: Game, p: Player, label?: string): Action {
  return g.rs.seg(label ?? g.rs.label(g.handNo, 'ai'), () => {
    if (VAR(g) && !p.splitDone) useSplit(p, planSplit(g, p, liveList(g).length - 1));
    const o = options(g, p);
    let a = g.street === 0 ? botPre(g, p, o) : botPost(g, p, o);
    if (g.rs.rand() < p.persona!.noise * 0.35) {
      if (a.type === 'fold' && o.toCall <= Math.max(g.bb * 2, p.stack * 0.08)) a = { type: 'call' };
      else if (a.type === 'check' && o.canRaise && g.street > 0) a = raiseTo(g, o, potTotal(g) * 0.5);
    }
    if (a.type === 'check' && g.street > 0) p.hf[`checked${g.street}`] = true;
    return a;
  });
}

/** After the deal in a split game: every player plans a split (you keep your dealt order). */
export function initPlans(g: Game, order: Player[]): void {
  g.rs.seg('h' + g.handNo + ':plans', () => {
    const k = order.length - 1, V = VAR(g)!;
    for (const p of order) {
      const sp = planSplit(g, p, k);
      useSplit(p, sp);
      p.vrank = varRankOf(g, sp);
      if (p.isHuman) {
        let i = 0;
        p.plan = V.parts.map(pt => { const grp = p.all.slice(i, i + pt.n); i += pt.n; return grp; });
        useSplit(p, p.plan);
      }
    }
  });
}

/** Dealer's choice: what each friend usually deals. */
export function pickVariantFor(g: Game, d: Player): VariantKey {
  return g.rs.seg('h' + g.handNo + ':variant', () => {
    const picks = DEALER_PICKS[d.type ?? ''] || [['std', 1]];
    let r = g.rs.rand();
    for (const [k, w] of picks) { r -= w; if (r <= 0) return k; }
    return picks[0]![0];
  });
}

/** A bot's final split at the showdown; the order of two 3 Patti hands follows each friend's habit. */
export function botFinalSplit(g: Game, p: Player, k: number): Split {
  return g.rs.seg(g.rs.label(g.handNo, 'final'), () => {
    const V = VAR(g)!;
    let sp = planSplit(g, p, k);
    if (V.parts.length === 3) { sp = normSplit(V, sp); if (g.rs.rand() > (STRONG_FIRST[p.type ?? ''] ?? 0.65)) sp = [sp[0]!, sp[2]!, sp[1]!]; }
    return sp;
  });
}

/** Practice view in split games: players who never split get their best split shown. */
export function practiceSplits(g: Game): void {
  g.rs.seg('h' + g.handNo + ':reveal', () => {
    for (const p of g.players)
      if (p.all && p.all.length && !p.splitDone && !p.out) {
        const s = p.isHuman && p.plan ? p.plan : planSplit(g, p, Math.max(1, liveList(g).length - 1));
        p.parts = s.map(x => x.slice()); p.cards = s[0]!.slice(); p.extra = s.slice(1).map(x => x.slice()); p.splitDone = true;
      }
  });
}

export { VAR_ORDER };
