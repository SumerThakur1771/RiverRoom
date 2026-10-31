// Split games: how players value and choose ways to split their cards, and whole-game equity.
// Ported line by line from the original (see equity.ts for why exactness matters).
import { catOf, describe, evaluate, holeName, kAt, randCards, type Card } from '../engine/cards';
import type { Game, Player } from '../engine/state';
import { sortedPct, tpTab } from '../engine/strength';
import { clamp, VAR } from '../engine/table';
import { tpName, tpScore } from '../engine/teenpatti';
import { splitsOf, type PartKind, type Split, type Variant } from '../engine/variants';
import { CATN, drawInfo, equityVs, equityVsMulti, type RangeModel } from './equity';

const CATP = [0.12, 0.45, 0.74, 0.85, 0.91, 0.95, 0.985, 0.998, 1];
const handProxy = (v: number): number => {
  const c = catOf(v);
  return CATP[c]! + (c < 8 ? (CATP[c + 1]! - CATP[c]!) * kAt(v, 0) / 15 : 0);
};

interface IdxPart { g: number[]; mask: number }
/** Every way to split N cards, as card positions, worked out once per game type. */
const SPLIT_IDX: Record<string, IdxPart[][]> = {};
function splitIdx(V: Variant): IdxPart[][] {
  const key = V.deal + ':' + V.parts.map(x => x.k + x.n).join();
  if (!SPLIT_IDX[key]) SPLIT_IDX[key] = splitsOf(V, [...Array(V.deal).keys()], true).map(s => s.map(g => ({ g, mask: g.reduce((a, i) => a | (1 << i), 0) })));
  return SPLIT_IDX[key]!;
}

export type Scores = number[] & { total: number };

/**
 * How a player would sensibly split these cards once the table is out. Each part is judged
 * against what the others usually keep, and the split with the biggest expected share of the
 * pot wins (2-of-3 rule included). Returns each part's raw score plus the split's value.
 */
export function quickSplitScores(g: Game, V: Variant, cards: readonly Card[], board: readonly Card[], board2: readonly Card[], kIn: number): Scores {
  const k = Math.max(1, kIn || 1);
  const memo: Partial<Record<PartKind, Map<number, [number, number]>>> = {}, key = g.variant!, hx = 1 + V.deal * 0.4;
  let best: IdxPart[] | null = null, bv = -1;
  const val = (kind: PartKind, part: IdxPart): [number, number] => {
    const m = memo[kind] || (memo[kind] = new Map());
    let e = m.get(part.mask);
    if (!e) {
      const h = part.g.map(i => cards[i]!);
      let raw: number, x: number;
      if (kind === 'hold') { raw = evaluate(h.concat(board)); x = Math.pow(handProxy(raw), hx); }
      else if (kind === 'b2') { raw = evaluate(h.concat(board2)); x = Math.pow(handProxy(raw), 3); }
      else if (kind === 'h5') { raw = evaluate(h); x = g.tables.oppCdf(key, 1, sortedPct(g.tables.h5Tab(), raw)); }
      else { raw = tpScore(h); x = g.tables.oppCdf(key, 1, sortedPct(tpTab(), raw)); }
      e = [raw, Math.pow(x, k)];
      m.set(part.mask, e);
    }
    return e;
  };
  const n = V.parts.length, k0 = V.parts[0]!.k, k1 = n > 1 ? V.parts[1]!.k : null, k2 = n > 2 ? V.parts[2]!.k : null, q = k > 1 ? (1 - 1 / k) / 3 : 0;
  for (const s of splitIdx(V)) {
    const w0 = val(k0, s[0]!)[1], w1 = n > 1 ? val(k1!, s[1]!)[1] : 0;
    let v: number;
    if (n === 3) {
      const w2 = val(k2!, s[2]!)[1];
      v = w0 * w1 + w0 * w2 + w1 * w2 - 2 * w0 * w1 * w2 + (w0 * (1 - w1) * (1 - w2) + w1 * (1 - w0) * (1 - w2) + w2 * (1 - w0) * (1 - w1)) * q;
    } else v = n === 2 ? (w0 + w1) / 2 : w0;
    if (v > bv) { bv = v; best = s; }
  }
  const out = best!.map((part, j) => val(V.parts[j]!.k, part)[0]) as Scores;
  out.total = bv;
  return out;
}

/** How strong (as a percentile of random hands on this table) a player's whole hand probably is. */
function wholeHandBar(m: RangeModel): number {
  if (m.tight && m.big >= 1 && m.agg >= 2) return 0.85;
  if (m.big >= 1 || m.agg >= 3) return 0.75;
  if (m.raised || m.agg >= 2) return 0.6;
  if (m.agg === 1) return 0.45;
  if (m.calls >= 1) return 0.3;
  return 0;
}

function sampleWhole(g: Game, m: RangeModel, deck: readonly Card[], used: Set<Card>, V: Variant, board: readonly Card[], b2: readonly Card[], qTab: Float64Array, kOpp: number): Card[] {
  const rand = g.rs.rand, bar = wholeHandBar(m);
  let hand: Card[] = [];
  const tries = V.deal >= 8 ? 10 : 20;
  for (let t = 0; t <= tries; t++) {
    hand = [];
    let n = 0;
    while (hand.length < V.deal && n++ < 400) {
      const c = deck[(rand() * deck.length) | 0]!;
      if (!used.has(c) && !hand.includes(c)) hand.push(c);
    }
    if (!bar || t >= tries) return hand;
    // a bluff, or a passive caller who just likes to see cards
    if (rand() < (m.calls && !m.agg ? 0.4 : m.bluff * 0.5)) return hand;
    if (sortedPct(qTab, quickSplitScores(g, V, hand, board, b2, kOpp).total) >= bar) return hand;
  }
  return hand;
}

/**
 * Whole-game equity in a split game: play the hand out many times, everyone splits sensibly,
 * every part is scored and the house rules decide the pot. Your chance = your average share.
 */
export function gameEquity(g: Game, p: Player, models: readonly RangeModel[], itersIn: number, withThreat?: boolean): { eq: number; parts: number[] } {
  const rand = g.rs.rand;
  const V = VAR(g)!, m = V.parts.length, board = g.board.slice(0, g.boardVis), b2 = g.board2.slice(0, g.boardVis2);
  tpTab();
  g.tables.h5Tab();
  let iters = itersIn;
  if (V.parts.length === 3) iters = Math.round(iters * (withThreat ? 1.1 : 0.5)); // the coach gets more runs for steadier advice
  const known = new Set(p.all.concat(board, b2)), deck: Card[] = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  // what random hands look like on this table, to judge how strong a bet makes someone
  const kOpp = models.length;
  const qa: number[] = [];
  for (let i = 0; i < 80; i++) {
    const h: Card[] = [];
    while (h.length < V.deal) {
      const c = deck[(rand() * deck.length) | 0]!;
      if (!h.includes(c)) h.push(c);
    }
    qa.push(quickSplitScores(g, V, h, board, b2, kOpp).total);
  }
  const qTab = Float64Array.from(qa).sort();
  const wins: number[] = Array(m).fill(0), beat: Record<string, number> = {}, threat = !!withThreat && board.length >= 3;
  const myNow = threat ? quickSplitScores(g, V, p.all, board, b2, models.length)[0]! : 0;
  let share = 0, behind = 0;
  for (let it = 0; it < iters; it++) {
    const used = new Set<Card>(), hands = models.map(md => {
      const h = sampleWhole(g, md, deck, used, V, board, b2, qTab, kOpp);
      h.forEach(c => used.add(c));
      return h;
    });
    // does someone, splitting sensibly, already beat the poker part you would play now?
    if (threat) {
      let top = -1;
      for (const h of hands) {
        const v = quickSplitScores(g, V, h, board, b2, kOpp)[0]!;
        if (v > top) top = v;
      }
      if (top > myNow) {
        behind++;
        const kk = CATN[catOf(top)]!;
        beat[kk] = (beat[kk] || 0) + 1;
      }
    }
    const draw = (): Card => {
      for (;;) {
        const c = deck[(rand() * deck.length) | 0]!;
        if (!used.has(c)) {
          used.add(c);
          return c;
        }
      }
    };
    const fb = board.slice();
    while (fb.length < 5) fb.push(draw());
    const fb2 = b2.slice();
    while (fb2.length < (V.board2 || 0)) fb2.push(draw());
    const sc = [p.all as readonly Card[]].concat(hands).map((cards, i) => {
      const s = quickSplitScores(g, V, cards, fb, fb2, kOpp);
      if (m === 3) {
        let a = s[1]!, b = s[2]!;
        if (a < b) [a, b] = [b, a];
        if (i > 0 && rand() < 0.4) [a, b] = [b, a];
        return [s[0]!, a, b];
      }
      return s as number[];
    });
    const W: number[][] = [], cnt: number[] = new Array(sc.length).fill(0);
    for (let j = 0; j < m; j++) {
      let top = -Infinity;
      for (const s of sc) if (s[j]! > top) top = s[j]!;
      const ws: number[] = [];
      sc.forEach((s, i) => {
        if (s[j] === top) {
          ws.push(i);
          cnt[i]!++;
        }
      });
      W.push(ws);
      if (ws.includes(0)) wins[j]! += 1 / ws.length;
    }
    const maj: number[] = [];
    cnt.forEach((c, i) => {
      if (c * 2 > m) maj.push(i);
    });
    share += maj.length === 1 ? (maj[0] === 0 ? 1 : 0) : W.reduce((a, ws) => a + (ws.includes(0) ? 1 / ws.length : 0), 0) / m;
  }
  g.lastThreat = threat ? { behind: behind / iters, top: Object.entries(beat).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => [k, n / iters] as [string, number]) } : null;
  return { eq: share / iters, parts: wins.map(w => w / iters) };
}

/** Chance to win the poker part (split games use the many-card model after the flop). */
export function holdEquity(g: Game, p: Player, hold: readonly Card[], models: readonly RangeModel[], iters: number): number {
  const V = VAR(g);
  if (V && g.board.length >= 3) {
    const r = equityVsMulti(g.rs.rand, hold, g.board, models, Math.round(iters * 0.6), p.all, V.deal);
    g.lastThreat = r.threat;
    return r.eq;
  }
  g.lastThreat = null;
  return equityVs(g.rs.rand, hold, g.board, models, iters, p.all);
}

/* ---- strength of a part against the cards that are out now ---- */
function holdTab(g: Game, vis: readonly Card[]): Float64Array {
  const key = 'h' + vis.join(',');
  let t = g.btab.get(key);
  if (!t) {
    const dead = new Set(vis), d: Card[] = [], a: number[] = [];
    for (let c = 0; c < 52; c++) if (!dead.has(c)) d.push(c);
    for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) a.push(evaluate([d[i]!, d[j]!].concat(vis)));
    t = Float64Array.from(a).sort();
    g.btab.set(key, t);
  }
  return t;
}
function b2Tab(g: Game, vis2: readonly Card[]): Float64Array {
  const key = 'b' + vis2.join(',');
  let t = g.btab.get(key);
  if (!t) {
    t = g.rs.seg('b2tab:' + key, () => {
      const dead = new Set(vis2), a = new Float64Array(3000);
      for (let i = 0; i < a.length; i++) a[i] = evaluate(randCards(g.rs.rand, 3, dead).concat(vis2));
      return a.sort();
    });
    g.btab.set(key, t);
  }
  return t;
}
/** On the river: can any two cards the others might hold beat this? (your own cards cannot be theirs) */
const NUTC = new Map<string, boolean>();
function isNut(h: readonly Card[], vis: readonly Card[], dead?: readonly Card[]): boolean {
  const v = evaluate(h.concat(vis)), key = vis.join(',') + '|' + h.join(',') + '|' + (dead || []).join(',');
  const hit = NUTC.get(key);
  if (hit !== undefined) return hit;
  const out = new Set(vis.concat(h, dead || [])), d: Card[] = [];
  for (let c = 0; c < 52; c++) if (!out.has(c)) d.push(c);
  let nut = true;
  for (let i = 0; i < d.length && nut; i++)
    for (let j = i + 1; j < d.length; j++)
      if (evaluate([d[i]!, d[j]!].concat(vis)) > v) {
        nut = false;
        break;
      }
  NUTC.set(key, nut);
  return nut;
}
/** Chance a 2-card draw comes in by the river. */
function drawHit(h: readonly Card[], vis: readonly Card[]): number {
  if (vis.length >= 5) return 0;
  const d = drawInfo(h, vis), two = vis.length === 3;
  if (d.fd && d.sd === 'oesd') return two ? 0.54 : 0.33;
  if (d.fd) return two ? 0.35 : 0.2;
  if (d.sd === 'oesd') return two ? 0.32 : 0.17;
  if (d.sd === 'gut') return two ? 0.17 : 0.09;
  return 0;
}

/** Chance this part beats one other player's part (they pick their best cards for it too). */
export function vsOne(g: Game, j: number, kind: PartKind, h: readonly Card[], dead?: readonly Card[]): number {
  if (kind === 'hold' && g.boardVis >= 3) {
    const vis = g.board.slice(0, g.boardVis), tab = holdTab(g, vis), v = evaluate(h.concat(vis));
    // on the river: if no two cards can beat it, it is the best possible hand ("the nuts")
    if (g.boardVis === 5 && v >= tab[Math.max(0, tab.length - 40)]! && isNut(h, vis, dead)) return 1;
    let pctv = sortedPct(tab, v);
    const hit = drawHit(h, vis);
    if (hit) pctv = pctv + (1 - pctv) * hit * 0.92;
    return Math.pow(pctv, 1 + (VAR(g) || { deal: 3 }).deal * 0.4);
  }
  if (kind === 'b2' && g.boardVis2 >= 2) {
    const v2 = g.board2.slice(0, 2), tab = b2Tab(g, v2), v = evaluate(h.concat(v2));
    if (v >= tab[tab.length - 1]! && catOf(v) >= 4) return 1;
    return Math.pow(sortedPct(tab, v), 4);
  }
  return g.tables.oppCdf(g.variant!, j, g.tables.partStr(kind, h));
}

/** Expected share of the pot from each part's win chance (2-of-3 rule for three parts). */
export function comboEq(holdEq: number, xs: readonly number[], k: number): number {
  if (!xs.length) return holdEq;
  const w = [holdEq].concat(xs);
  if (w.length !== 3) return w.reduce((a, b) => a + b, 0) / w.length;
  // 3 parts: win 2 or 3 and you take it all; win 1 and you get a third only if the other two parts go to different players
  const [a, b, c] = w as [number, number, number], p2 = a * b + a * c + b * c - 2 * a * b * c, p1 = a * (1 - b) * (1 - c) + b * (1 - a) * (1 - c) + c * (1 - a) * (1 - b);
  return p2 + p1 * (k > 1 ? 1 - 1 / k : 0) / 3;
}

/** How good a split is: your expected share of the pot with it. */
export function splitValue(g: Game, s: Split, k: number, dead?: readonly Card[]): number {
  const V = VAR(g)!, pw = Math.max(1, k), w = s.map((h, j) => Math.pow(vsOne(g, j, V.parts[j]!.k, h, dead), pw));
  return comboEq(w[0]!, w.slice(1), k);
}

/** The strongest way to split these cards with what is on the table right now. */
export function planSplit(g: Game, p: Player, k: number): Split {
  const V = VAR(g)!, sk = g.handNo + ':' + g.boardVis + ':' + g.boardVis2 + ':' + k;
  if (p._plan && p._planKey === sk) return p._plan;
  const pw = Math.max(1, k), memo = V.parts.map(() => new Map<number, number>());
  const val = (j: number, h: Card[]): number => {
    const m = memo[j]!, key = h.reduce((a, c) => a + 2 ** c, 0);
    let v = m.get(key);
    if (v === undefined) {
      v = Math.pow(vsOne(g, j, V.parts[j]!.k, h, p.all), pw);
      m.set(key, v);
    }
    return v;
  };
  let best: Split | null = null, bv = -1;
  for (const s of splitsOf(V, p.all)) {
    const w = s.map((h, j) => val(j, h)), v = comboEq(w[0]!, w.slice(1), k);
    if (v > bv) {
      bv = v;
      best = s;
    }
  }
  p._plan = best;
  p._planKey = sk;
  return best!;
}

function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const pr = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - pr : pr;
}
/** Overall starting strength in a split game, on the same scale as handPct (0 = best). */
export function varRankOf(g: Game, s: Split): number {
  const V = VAR(g)!, cdfs = V.parts.map((pt, j) => vsOne(g, j, pt.k, s[j]!));
  const m = cdfs.length, mean = cdfs.reduce((a, b) => a + b, 0) / m;
  return clamp(1 - normCdf((mean - 0.5) / Math.sqrt(1 / (12 * m))), 0.001, 0.999);
}

/** Board 2 after some of its cards are out: play it out against random hands. */
export function b2Win(g: Game, h: readonly Card[], vis: readonly Card[], k: number, p?: Player): number {
  const rand = g.rs.rand;
  const dead = new Set((p && p.all && p.all.length ? p.all : (h as Card[])).concat(g.board.slice(0, g.boardVis), vis)), deck: Card[] = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) deck.push(c);
  const need = 2 - vis.length + 3, it = 200;
  let w = 0;
  for (let t = 0; t < it; t++) {
    for (let i = 0; i < need; i++) {
      const j = i + ((rand() * (deck.length - i)) | 0);
      const x = deck[i]!;
      deck[i] = deck[j]!;
      deck[j] = x;
    }
    const b2 = vis.concat(deck.slice(0, 2 - vis.length)), opp = deck.slice(2 - vis.length, need);
    const mine = evaluate(h.concat(b2)), o = evaluate(opp.concat(b2));
    w += mine > o ? 1 : mine === o ? 0.5 : 0;
  }
  return Math.pow(w / it, Math.max(1, k) * 1.25);
}

/** Chance to win each extra part against k players. */
export function extraWins(g: Game, p: Player, k: number, exIn?: Card[][] | null): number[] {
  const V = VAR(g), ex = exIn || p.extra;
  if (!V || !ex) return [];
  return ex.map((h, i) => {
    const pt = V.parts[i + 1]!;
    if (pt.k === 'b2' && g.boardVis2 > 0) return b2Win(g, h, g.board2.slice(0, g.boardVis2), k, p);
    return Math.pow(vsOne(g, i + 1, pt.k, h), Math.max(1, k));
  });
}

export function partName(g: Game, kind: PartKind, h: readonly Card[]): string {
  if (kind === 'hold') return g.boardVis >= 3 ? describe(evaluate(h.concat(g.board.slice(0, g.boardVis)))) : holeName(h[0]!, h[1]!);
  if (kind === 'b2') return describe(evaluate(h.concat(g.board2.slice(0, g.boardVis2))));
  if (kind === 'h5') return describe(evaluate(h));
  return tpName(h);
}
export function partScore(g: Game, kind: PartKind, h: readonly Card[]): number {
  return kind === 'hold' ? evaluate(h.concat(g.board)) : kind === 'b2' ? evaluate(h.concat(g.board2)) : kind === 'h5' ? evaluate(h) : tpScore(h);
}
/** useSplit: how a player is thinking of splitting (still private). applySplit: the final split. */
export function useSplit(p: Player, s: Split): void {
  p.parts = s.map(x => x.slice());
  p.cards = s[0]!.slice();
  p.extra = s.slice(1).map(x => x.slice());
}
export function applySplit(p: Player, s: Split): void {
  useSplit(p, s);
  p.splitDone = true;
}
export const splitKey = (s: Split): string => s.map(x => x.slice().sort((a, b) => a - b).join('.')).join('|');
