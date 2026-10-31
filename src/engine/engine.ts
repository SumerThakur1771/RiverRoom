// The game engine: table setup, betting, pots, showdowns and the hand flow.
//
// `playHand` is a generator. It runs the rules and stops ("yields") whenever something
// outside the rules is needed: a player's decision, a dealer's game choice, a final split,
// a rebuy answer, or a moment the UI may want to animate. Whoever drives the generator
// (the browser UI, the headless simulator, or a replay test) answers those requests.
// No DOM, no timers: the same code runs in the browser, in Node and in a Web Worker.
import { drawInfo, equityKnown, madeInfo } from '../ai/equity';
import { partName, partScore } from '../ai/split';
import { bestFive, cardTxt, catOf, cr, describe, evaluate, holeName, kAt, PNAME, RNAME, shuffled, type Card } from './cards';
import { HOME_FRIENDS, jitter, NAMES, TYPES, type Friend } from './personas';
import { updateRange } from './reads';
import { Streams } from './rng';
import { newHud, type Game, type GameEvent, type Mode, type Persona, type Player, type Pot, type Settings } from './state';
import { Tables } from './strength';
import { ableList, ev, fmt, heroP, liveList, lg, needsAction, nextAlive, nm, potTotal, VAR } from './table';
import { VARIANTS, type Split, type VariantKey } from './variants';

export const LEVELS: Array<[number, number, number]> = [[10, 20, 0], [15, 30, 0], [25, 50, 0], [50, 100, 10], [75, 150, 15], [100, 200, 25], [150, 300, 40], [200, 400, 50], [300, 600, 75], [400, 800, 100], [600, 1200, 150], [800, 1600, 200], [1000, 2000, 250], [1500, 3000, 400], [2000, 4000, 500], [3000, 6000, 750], [5000, 10000, 1000], [8000, 16000, 1600]];
export const SEATMAP: Record<number, number[]> = { 1: [0, 3], 2: [0, 2, 4], 3: [0, 1, 3, 5], 4: [0, 1, 2, 4, 5], 5: [0, 1, 2, 3, 4, 5] };
export const HOME_BUY = 1000;
export const HOME_BLINDS: [number, number, number] = [10, 20, 0];
export const STRONG_FIRST: Record<string, number> = { rohit: 0.75, nikhil: 0.6, krish: 0.3, venky: 0.5 };

export type ActionType = 'fold' | 'check' | 'call' | 'raise';
export interface Action { type: ActionType; to?: number }
export interface ActionResult { type: ActionType; kind: string; amt: number; to: number }
export interface Options { toCall: number; canCheck: boolean; canRaise: boolean; minTo: number; maxTo: number; isBet: boolean }

/** What the flow needs from outside. The driver answers with `gen.next(answer)`. */
export type Step =
  | { kind: 'act'; p: Player }
  | { kind: 'variant'; p: Player }
  | { kind: 'plans'; order: Player[] }
  | { kind: 'split'; p: Player; k: number }
  | { kind: 'practiceView' }
  | { kind: 'rebuy'; p: Player }
  | { kind: 'pause'; what: string; ms: number; data?: unknown };
export type HandFlow = Generator<Step, void, unknown>;

/* ================= setup ================= */
/** Unbiased in-place Fisher-Yates shuffle. (The original used sort(() => random - 0.5), which is biased.) */
export function shuffle<T>(rand: () => number, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]!; a[i] = a[j]!; a[j] = t;
  }
  return a;
}

export function makePlayer(rs: Streams, settings: Settings, seat: number, bot: { name: string; type: string; color: string; avatar?: string | null } | null, stack: number): Player {
  const tkey = bot ? bot.type : null, base = tkey ? TYPES[tkey]! : null;
  const persona: Persona | null = base ? jitter(rs.rand, base) : null;
  return {
    i: 0, seat, name: bot ? bot.name : settings.name || 'You', isHuman: !bot, type: tkey, persona, color: bot ? bot.color : '#b8902f', avatar: bot ? bot.avatar ?? null : null,
    stack, out: false, place: 0, buyins: 1, start: stack, cards: [], all: [], extra: null, parts: null, plan: null, splitDone: false, vrank: null, _plan: null,
    vis: 0, folded: false, allIn: false, bet: 0, total: 0, acted: false, raiseLocked: false, label: '', shown: false, justShown: false, mucked: false, revealed: false,
    score: 0, handName: '', pscore: null, pname: null, partWin: null, won: 0, winner: false, eq: null, eqAtReveal: null, _eq: null,
    hud: newHud(), hf: {}, rg: { top: 1, low: 0, agg: 0, raised: false, calls: 0, big: 0 }, tilt: 0, read: false, mem: null,
  };
}

export interface Snapshot {
  mode: Mode; handNo: number; button: number; tableNo: number; stats: Game['stats'];
  players: Array<{ seat: number; name: string; type: string | null; color: string; stack: number; out: boolean; place: number; buyins: number; avatar: string | null; hud: Player['hud']; read: boolean; mem: Player['mem'] }>;
}

/** A new table (or a resumed one from a snapshot). `seed` null = production randomness. */
export function newGame(opts: { mode: Mode; settings: Settings; seed: string | null; snap?: Snapshot | null }): Game {
  const rs = new Streams(opts.seed);
  const g = {
    rs, tables: new Tables(rs), settings: opts.settings, mode: opts.mode, money: opts.mode === 'home',
    players: [], handNo: 0, button: -1, sbIdx: 0, bbIdx: 0, level: 0, sb: 10, bb: 20, ante: 0,
    deck: [], nextDeck: null, board: [], boardVis: 0, board2: [], boardVis2: 0, variant: null,
    pot: 0, street: 0, currentBet: 0, minRaise: 20, toAct: -1, lastAggressor: null, pfAggressor: null, cbetMade: false, streetRaises: 0, revealed: false,
    hist: [], ev: [], tableNo: 0, entrants: 0, stats: { hands: 0, won: 0, vpip: 0, pfr: 0, biggest: 0, sd: 0, sdWon: 0 }, handActive: false,
    vpip: false, pfr: false, cashOutReq: false, msg: '', explain: '', sideInfo: '', highlight: null, btab: new Map(), lastThreat: null,
  } as Game;
  rs.seg('setup', () => setupTable(g, opts.snap ?? null));
  return g;
}

function setupTable(g: Game, snap: Snapshot | null): void {
  const rs = g.rs, rand = rs.rand, st = g.settings;
  g.tableNo = 4000 + Math.floor(rand() * 5000);
  if (snap) {
    g.players = snap.players.map(sp => {
      const p = makePlayer(rs, st, sp.seat, sp.type ? { name: sp.name, type: sp.type, color: sp.color, avatar: sp.avatar } : null, sp.stack);
      if (!sp.type && sp.avatar) p.avatar = sp.avatar;
      if (!sp.type) p.name = sp.name;
      p.out = sp.out; p.place = sp.place; p.buyins = sp.buyins || 1;
      if (sp.hud) p.hud = Object.assign(newHud(), sp.hud);
      p.read = !!sp.read; p.mem = sp.mem || null;
      return p;
    });
    Object.assign(g, { handNo: snap.handNo, button: snap.button, tableNo: snap.tableNo, stats: snap.stats, entrants: snap.players.length });
  } else if (g.mode === 'home') {
    const seats = SEATMAP[HOME_FRIENDS.length]!, friends: Friend[] = shuffle(rand, HOME_FRIENDS.slice());
    g.players = seats.map((seat, k) => (k === 0 ? makePlayer(rs, st, seat, null, HOME_BUY) : makePlayer(rs, st, seat, friends[k - 1]!, HOME_BUY)));
    g.players[0]!.name = !st.name || st.name === 'You' ? 'Sumer' : st.name;
    g.players[0]!.avatar = 'sumer';
    g.entrants = g.players.length;
  } else {
    const seats = SEATMAP[st.opp] || SEATMAP[5]!;
    const names = shuffle(rand, NAMES.slice());
    const types = shuffle(rand, Object.keys(TYPES).filter(k => !TYPES[k]!.home));
    g.players = seats.map((seat, k) => (k === 0 ? makePlayer(rs, st, seat, null, st.stack) : makePlayer(rs, st, seat, { name: names[k - 1]![0], color: names[k - 1]![1], type: types[(k - 1) % types.length]! }, st.stack)));
    g.entrants = g.players.length;
  }
  g.players.forEach((p, i) => { p.i = i; if (!p.buyins) p.buyins = 1; if (g.money && !p.isHuman) p.read = true; });
  if (g.money) { [g.sb, g.bb, g.ante] = HOME_BLINDS; g.level = 0; g.minRaise = g.bb; }
  else { const lvl = Math.min(LEVELS.length - 1, Math.floor(Math.max(0, g.handNo) / st.perLevel)); [g.sb, g.bb, g.ante] = LEVELS[lvl]!; g.level = lvl; }
}

export function makeSnap(g: Game): Snapshot {
  return {
    mode: g.mode, handNo: g.handNo, button: g.button, tableNo: g.tableNo, stats: Object.assign({}, g.stats),
    players: g.players.map(p => ({ seat: p.seat, name: p.name, type: p.type, color: p.color, stack: p.stack, out: p.out, place: p.place, buyins: p.buyins, avatar: p.avatar, hud: Object.assign({}, p.hud), read: !!p.read, mem: p.mem || null })),
  };
}

/* ================= actions ================= */
export function options(g: Game, p: Player): Options {
  const toCall = Math.max(0, g.currentBet - p.bet);
  const others = g.players.filter(o => o !== p && !o.out && !o.folded && !o.allIn);
  const canRaise = !p.raiseLocked && p.stack > toCall && others.length > 0;
  const maxTo = p.bet + p.stack, minTo = Math.min(g.currentBet + g.minRaise, maxTo);
  return { toCall: Math.min(toCall, p.stack), canCheck: toCall === 0, canRaise, minTo, maxTo, isBet: g.currentBet === 0 };
}
export function putIn(p: Player, amount: number): void {
  const amt = Math.max(0, Math.min(amount, p.stack));
  p.stack -= amt; p.bet += amt; p.total += amt;
  if (p.stack <= 0) { p.stack = 0; p.allIn = true; }
}
function hudOnAction(g: Game, p: Player, t: string, preRaises: number, preBet: number): void {
  const hf = p.hf;
  if (g.street === 0) {
    if (!hf.preActed) { hf.preActed = true; if (preRaises === 1) hf.threeOpp = true; }
    if (t === 'call' || t === 'raise') hf.vpip = true;
    if (t === 'raise') { hf.pfr = true; if (preRaises === 1 && hf.threeOpp) hf.three = true; }
  } else {
    if (g.street === 1 && p === g.pfAggressor && !hf.flopActed && preBet === 0) { hf.cbetOpp = true; if (t === 'raise') hf.cbet = true; }
    if (g.street === 1 && g.cbetMade && p !== g.pfAggressor && !hf.fcbSeen && preBet > 0) { hf.fcbSeen = true; p.hud.fcbOpp++; if (t === 'fold') { p.hud.fcb++; hf.fcbFold = true; } }
    if (g.street === 1) hf.flopActed = true;
    if (t === 'raise') p.hud.agg++;
    else if (t === 'call') p.hud.calls++;
  }
  if (t === 'raise') hf.lastAggSt = g.street;
}

/** Apply a player's action. Illegal requests are converted to the nearest legal action. */
export function applyAction(g: Game, p: Player, a: Action): ActionResult {
  const o = options(g, p);
  let t: ActionType = a.type;
  if (t === 'raise' && (!o.canRaise || !((a.to ?? 0) > g.currentBet))) t = o.toCall > 0 ? 'call' : 'check';
  if (t === 'check' && o.toCall > 0) t = 'fold';
  if (t === 'call' && o.toCall === 0) t = 'check';
  const preRaises = g.streetRaises, preBet = g.currentBet;
  hudOnAction(g, p, t, preRaises, preBet);
  if (g.street === 0 && p.isHuman && (t === 'call' || t === 'raise')) { g.vpip = true; if (t === 'raise') g.pfr = true; }
  let res: ActionResult = { type: t, amt: 0, to: 0, kind: t };
  if (t === 'fold') {
    p.folded = true; p.label = 'Fold'; lg(g, `${p.name}: folds`); ev(g, { t: 'fold', p });
  } else if (t === 'check') {
    p.acted = true; p.label = 'Check'; lg(g, `${p.name}: checks`); ev(g, { t: 'check', p });
  } else if (t === 'call') {
    const amt = Math.min(o.toCall, p.stack);
    putIn(p, amt); p.acted = true; p.label = p.allIn ? 'All-in' : 'Call';
    lg(g, `${p.name}: calls ${fmt(g, amt)}${p.allIn ? ' and is all-in' : ''}`);
    ev(g, { t: 'call', p, amt, allIn: p.allIn });
    updateRange(g, p, 'call', preRaises);
    res.amt = amt;
  } else {
    const to = Math.min(Math.round(a.to ?? 0), p.bet + p.stack), prev = g.currentBet, add = to - p.bet, size = to - prev;
    putIn(p, add);
    if (size >= g.minRaise) {
      g.minRaise = size;
      for (const x of g.players) if (x !== p && !x.folded && !x.out && !x.allIn) { x.acted = false; x.raiseLocked = false; }
    } else {
      for (const x of g.players) if (x !== p && !x.folded && !x.out && !x.allIn && x.acted) { x.acted = false; x.raiseLocked = true; }
    }
    g.currentBet = to; p.acted = true; p.raiseLocked = false; g.lastAggressor = p; g.streetRaises++;
    if (g.street === 0) g.pfAggressor = p;
    if (g.street === 1 && p === g.pfAggressor && prev === 0) g.cbetMade = true;
    const kind = prev === 0 ? 'bet' : 'raise';
    p.label = p.allIn ? 'All-in' : kind === 'bet' ? 'Bet' : 'Raise';
    lg(g, kind === 'bet' ? `${p.name}: bets ${fmt(g, add)}${p.allIn ? ' and is all-in' : ''}` : `${p.name}: raises ${fmt(g, size)} to ${fmt(g, to)}${p.allIn ? ' and is all-in' : ''}`);
    ev(g, { t: kind, p, amt: add, to, allIn: p.allIn });
    updateRange(g, p, g.street === 0 ? 'raise' : kind, preRaises);
    res = { type: 'raise', kind, amt: add, to };
  }
  return res;
}

function post(g: Game, p: Player, amt: number, what: string): void {
  const a = Math.min(amt, p.stack);
  putIn(p, a);
  lg(g, `${p.name}: posts ${what} ${fmt(g, a)}${p.allIn ? ' and is all-in' : ''}`);
  ev(g, { t: 'post', p, amt: a, what });
}

/** Main pot and side pots from everyone's total contribution this hand. */
export function buildPots(g: Game): Pot[] {
  const c = g.players.map(p => ({ p, amt: p.total })), pots: Pot[] = [];
  for (;;) {
    const live = c.filter(x => x.amt > 0 && !x.p.folded && !x.p.out);
    if (!live.length) {
      const rest = c.reduce((a, x) => a + x.amt, 0);
      if (rest > 0 && pots.length) pots[pots.length - 1]!.amount += rest;
      break;
    }
    const m = Math.min(...live.map(x => x.amt));
    let amount = 0;
    for (const x of c) { const t = Math.min(x.amt, m); amount += t; x.amt -= t; }
    const elig = live.map(x => x.p), last = pots[pots.length - 1];
    if (last && last.eligible.length === elig.length && last.eligible.every(q => elig.includes(q))) last.amount += amount;
    else pots.push({ amount, eligible: elig });
  }
  return pots;
}

/* ================= streets ================= */
function* bettingRound(g: Game): Generator<Step, void, unknown> {
  const n = g.players.length;
  let i = g.street === 0 ? (g.bbIdx + 1) % n : (g.button + 1) % n, safety = 0;
  for (;;) {
    const live = liveList(g);
    if (live.length <= 1) break;
    if (!g.players.some(p => needsAction(g, p))) break;
    const able = live.filter(p => !p.allIn);
    if (able.length === 1 && able[0]!.bet >= g.currentBet) break;
    const p = g.players[i]!;
    if (needsAction(g, p)) {
      g.toAct = i;
      const a = (yield { kind: 'act', p }) as Action;
      g.toAct = -1;
      const res = applyAction(g, p, a);
      yield { kind: 'pause', what: 'action', ms: p.isHuman ? 250 : 700, data: { p, res } };
    }
    i = (i + 1) % n;
    if (++safety > 600) break;
  }
  g.toAct = -1;
}

function endStreet(g: Game): void {
  const bettors = g.players.filter(p => p.bet > 0).sort((a, b) => b.bet - a.bet);
  if (bettors.length) {
    const top = bettors[0]!, second = bettors[1] ? bettors[1].bet : 0;
    if (top.bet > second) {
      const d = top.bet - second;
      top.bet -= d; top.total -= d; top.stack += d;
      if (top.stack > 0) top.allIn = false;
      lg(g, `Uncalled bet (${fmt(g, d)}) returned to ${top.name}`);
      ev(g, { t: 'ret', p: top, amt: d });
    }
  }
  let sum = 0;
  for (const p of g.players) if (p.bet > 0) { sum += p.bet; p.bet = 0; }
  g.pot += sum;
  g.sideInfo = '';
  if (liveList(g).some(p => p.allIn)) {
    const pots = buildPots(g);
    if (pots.length > 1) g.sideInfo = pots.map((pt, i) => `${i === 0 ? 'Main' : 'Side ' + i} ${fmt(g, pt.amount)}`).join(' · ');
  }
}

/** Equity of face-up all-in hands (display, and how much a bad beat tilts a bot). */
function updateAllInEquity(g: Game): void {
  g.rs.seg(g.rs.label(g.handNo, 'allin'), () => {
    const live = liveList(g);
    if (VAR(g)) { live.forEach(p => (p.eq = null)); return; }
    if (g.board.length >= 5) { live.forEach(p => (p.eq = null)); return; }
    const eqs = equityKnown(g.rs.rand, live.map(p => p.cards), g.board, 1500);
    live.forEach((p, i) => { p.eq = eqs[i]!; if (p.eqAtReveal == null) p.eqAtReveal = eqs[i]!; });
  });
}

function revealAll(g: Game): void {
  if (VAR(g)) {
    lg(g, '*** ALL-IN *** ' + liveList(g).map(p => `${p.name} [${p.all.map(cardTxt).join(' ')}]`).join(', '));
    ev(g, { t: 'reveal' });
    return;
  }
  for (const p of liveList(g)) if (!p.shown) { p.shown = true; p.justShown = true; }
  lg(g, '*** ALL-IN *** ' + liveList(g).map(p => `${p.name} [${p.cards.map(cardTxt).join(' ')}]`).join(', '));
  ev(g, { t: 'reveal' });
  updateAllInEquity(g);
}

function winWithoutShowdown(g: Game): void {
  const w = liveList(g)[0]!, amt = g.pot;
  g.msg = `${nm(w)} ${w.isHuman ? 'win' : 'wins'} ${fmt(g, amt)}. Everyone else folded.`;
  g.pot = 0; w.stack += amt; w.won += amt; w.winner = true;
  lg(g, `${w.name} collected ${fmt(g, amt)} from pot`);
  lg(g, `${w.name}: doesn't show hand`);
  ev(g, { t: 'win', p: w, amt, noShow: true });
}

const poss = (p: Player): string => (p.isHuman ? 'your' : p.name + "'s");
function beatText(w: Player, l: Player | null | undefined): string {
  if (!l || w.score === l.score) return '';
  const wc = catOf(w.score), lc = catOf(l.score);
  if (wc !== lc) return `${w.handName} beats ${poss(l)} ${l.handName}`;
  for (let i = 0; i < 5; i++) {
    const a = kAt(w.score, i), b = kAt(l.score, i);
    if (a === b) continue;
    if (i === 0) return `${w.handName} beats ${poss(l)} ${l.handName}`;
    if (wc === 2 && i === 1) return `both had two pair with ${PNAME(kAt(w.score, 0))}, but ${PNAME(a)} beat ${PNAME(b)} as the second pair`;
    if (wc === 6 && i === 1) return `both had a full house of ${PNAME(kAt(w.score, 0))}, but ${PNAME(a)} beat ${PNAME(b)}`;
    return `both had ${w.handName}, but ${nm(w)} had the higher side card (the "kicker"): ${RNAME[a]} vs ${RNAME[b]}`;
  }
  return '';
}

/** Showdown order: the last aggressor first, otherwise the first live player left of the button. */
function showOrder(g: Game, live: Player[]): Player[] {
  const n = g.players.length;
  let startI = 0;
  if (g.lastAggressor && !g.lastAggressor.folded) startI = g.lastAggressor.i;
  else {
    for (let k = 1; k <= n; k++) {
      const j = (g.button + k) % n;
      if (!g.players[j]!.out && !g.players[j]!.folded) { startI = j; break; }
    }
  }
  return live.slice().sort((a, b) => ((a.i - startI + n) % n) - ((b.i - startI + n) % n));
}

function* showdown(g: Game): Generator<Step, void, unknown> {
  g.street = 4; g.toAct = -1;
  lg(g, '*** SHOW DOWN ***');
  const live = liveList(g), n = g.players.length;
  live.forEach(p => { p.eq = null; p.score = evaluate(p.cards.concat(g.board)); p.handName = describe(p.score); p.label = ''; p.hf.sd = true; });
  const everyone = g.revealed || live.some(p => p.allIn);
  const order = showOrder(g, live);
  let best = -1;
  const hero = heroP(g);
  if (live.includes(hero)) g.stats.sd++;
  for (const p of order) {
    if (everyone || p.score >= best || p.isHuman) {
      if (!p.shown) { p.shown = true; p.justShown = true; }
      lg(g, `${p.name}: shows [${p.cards.map(cardTxt).join(' ')}] (${p.handName})`);
      ev(g, { t: 'show', p, name: p.handName, cards: p.cards.slice() });
      best = Math.max(best, p.score);
      yield { kind: 'pause', what: 'show', ms: everyone ? 500 : 1100, data: { p } };
    } else {
      p.mucked = true; p.label = 'Muck'; p.handName = '';
      lg(g, `${p.name}: mucks hand`);
      ev(g, { t: 'muck', p });
      yield { kind: 'pause', what: 'muck', ms: 700, data: { p } };
    }
  }
  const pots = buildPots(g), dist = (p: Player): number => (p.i - g.button - 1 + n) % n;
  let mainWinners: Player[] | null = null, mainName = '';
  for (let k = pots.length - 1; k >= 0; k--) {
    const pot = pots[k]!, elig = pot.eligible.filter(p => !p.mucked);
    if (!elig.length) continue;
    const top = Math.max(...elig.map(p => p.score));
    const winners = elig.filter(p => p.score === top).sort((a, b) => dist(a) - dist(b));
    const unit = g.money ? 10 : 1, share = Math.floor(pot.amount / winners.length / unit) * unit;
    let rem = pot.amount - share * winners.length;
    const label = pots.length === 1 ? 'pot' : k === 0 ? 'main pot' : `side pot ${k}`;
    for (const w of winners) {
      const extra = Math.min(rem, unit);
      rem -= extra;
      const amt = share + extra;
      w.stack += amt; w.won += amt; w.winner = true; w.hf.wsd = true;
      lg(g, `${w.name} collected ${fmt(g, amt)} from ${label}`);
      ev(g, { t: 'win', p: w, amt, label, name: w.handName });
    }
    g.pot = Math.max(0, g.pot - pot.amount);
    yield { kind: 'pause', what: 'pay', ms: k > 0 ? 900 : 650, data: { winners, label } };
    if (k === 0) { mainWinners = winners; mainName = winners[0]!.handName; }
  }
  if (mainWinners) {
    const mw = mainWinners;
    g.highlight = new Set(bestFive(mw[0]!.cards.concat(g.board)));
    const tot = mw.reduce((a, w) => a + w.won, 0);
    const losers = live.filter(p => !mw.includes(p) && !p.mucked).sort((a, b) => b.score - a.score);
    const bestLoser = losers[0] || (g.settings.revealAll ? live.filter(p => !mw.includes(p)).sort((a, b) => b.score - a.score)[0] : null);
    g.explain = mw.length > 1 ? 'They had exactly the same five-card hand, so the pot was split' : beatText(mw[0]!, bestLoser);
    g.msg = mw.length > 1 ? `Split pot: ${mw.map(nm).join(' & ')} · ${mainName}` : `${nm(mw[0]!)} ${mw[0]!.isHuman ? 'win' : 'wins'} ${fmt(g, tot)} with ${mainName}` + (g.explain ? `. ${g.explain[0]!.toUpperCase() + g.explain.slice(1)}.` : '');
  }
  if (hero.won > 0 && live.includes(hero)) g.stats.sdWon++;
}

const partsText = (g: Game, p: Player): string => {
  const V = VAR(g);
  return V && p.parts ? V.parts.map((pt, j) => `${pt.label} [${p.parts![j]!.map(cardTxt).join(' ')}]`).join(' | ') : `[${p.cards.map(cardTxt).join(' ')}]`;
};
function applySplitTo(p: Player, s: Split): void {
  p.parts = s.map(x => x.slice()); p.cards = s[0]!.slice(); p.extra = s.slice(1).map(x => x.slice()); p.splitDone = true;
}

/** Split games: everyone makes their final split (bots first, then you), then everyone shows. */
function* finalSplits(g: Game): Generator<Step, void, unknown> {
  const live = liveList(g), k = live.length - 1;
  for (const p of live) {
    if (p.isHuman) continue;
    applySplitTo(p, (yield { kind: 'split', p, k }) as Split);
  }
  const hero = live.find(p => p.isHuman);
  if (hero) {
    const sp = (yield { kind: 'split', p: hero, k }) as Split;
    applySplitTo(hero, sp);
    hero.plan = sp.map(x => x.slice());
    lg(g, `${hero.name} splits: ${partsText(g, hero)}`);
  }
}

function* showdownMulti(g: Game): Generator<Step, void, unknown> {
  const V = VAR(g)!;
  g.street = 4; g.toAct = -1;
  lg(g, '*** SHOW DOWN ***');
  const live = liveList(g), n = g.players.length, m = V.parts.length;
  for (const p of live) {
    p.eq = null; p.label = ''; p.hf.sd = true;
    p.pscore = V.parts.map((pt, j) => partScore(g, pt.k, j === 0 ? p.cards : p.extra![j - 1]!));
    p.pname = V.parts.map((pt, j) => partName(g, pt.k, j === 0 ? p.cards : p.extra![j - 1]!));
    p.score = p.pscore[0]!; p.handName = p.pname[0]!;
  }
  const order = showOrder(g, live);
  const hero = heroP(g);
  if (live.includes(hero)) g.stats.sd++;
  for (const p of order) {
    if (!p.shown) { p.shown = true; p.justShown = true; }
    lg(g, `${p.name}: shows ${V.parts.map((pt, j) => `${pt.label} [${p.parts![j]!.map(cardTxt).join(' ')}] (${p.pname![j]})`).join(' | ')}`);
    ev(g, { t: 'show', p, name: p.handName, cards: p.cards.slice(), parts: V.parts.map((pt, j) => ({ label: pt.label, cards: p.parts![j]!.slice(), name: p.pname![j] })) });
    yield { kind: 'pause', what: 'show', ms: 1000, data: { p } };
  }
  const pots = buildPots(g), dist = (p: Player): number => (p.i - g.button - 1 + n) % n, unit = 10, got = new Map<Player, number>(), mainW: Player[][] = [];
  let mainMaj: { w: Player; c: number } | null = null;
  const give = (w: Player, amt: number, potLabel: string, what: string): void => {
    got.set(w, (got.get(w) || 0) + amt);
    lg(g, `${w.name} collected ${fmt(g, amt)} from ${potLabel} (${what})`);
  };
  for (let k = pots.length - 1; k >= 0; k--) {
    const pot = pots[k]!, elig = pot.eligible.filter(p => !p.folded);
    if (!elig.length) continue;
    const potLabel = pots.length === 1 ? 'pot' : k === 0 ? 'main pot' : `side pot ${k}`;
    // who wins each part of this pot
    const W = V.parts.map((_pt, j) => { const top = Math.max(...elig.map(p => p.pscore![j]!)); return elig.filter(p => p.pscore![j] === top).sort((a, b) => dist(a) - dist(b)); });
    W.forEach((ws, j) => ws.forEach(w => { w.partWin = w.partWin || []; w.partWin[j] = true; }));
    if (k === 0) W.forEach((ws, j) => (mainW[j] = ws));
    // house rule: win most of the parts (2 of 3, or both of 2) and you take the whole pot
    const count = new Map<Player, number>();
    W.forEach(ws => ws.forEach(w => count.set(w, (count.get(w) || 0) + 1)));
    const maj = elig.filter(p => (count.get(p) || 0) * 2 > m);
    if (maj.length === 1) {
      const w = maj[0]!, c = count.get(w)!;
      give(w, pot.amount, potLabel, c === m ? 'won every part' : `won ${c} of ${m} parts: ${V.parts.filter((_pt, j) => W[j]!.includes(w)).map(pt => pt.label).join(' and ')}`);
      ev(g, { t: 'win', p: w, amt: pot.amount, label: potLabel, part: c === m ? 'every part' : `${c} of ${m} parts`, name: V.parts.map((_pt, j) => (W[j]!.includes(w) ? w.pname![j] : '')).filter(Boolean).join(' + ') });
      if (k === 0) mainMaj = { w, c };
      continue;
    }
    const base = Math.floor(pot.amount / m / unit) * unit, rem = pot.amount - base * m;
    for (let j = 0; j < m; j++) {
      const share = base + (j === 0 ? rem : 0), ws = W[j]!;
      if (share <= 0) continue;
      const each = Math.floor(share / ws.length / unit) * unit, amts = ws.map(() => each);
      let r2 = share - each * ws.length, q = 0;
      while (r2 >= unit) { amts[q % ws.length]! += unit; r2 -= unit; q++; }
      amts[0]! += r2;
      ws.forEach((w, x) => { give(w, amts[x]!, potLabel, `${V.parts[j]!.label}: ${w.pname![j]}`); ev(g, { t: 'win', p: w, amt: amts[x], label: potLabel, part: V.parts[j]!.label, name: w.pname![j] }); });
    }
  }
  for (const [w, amt] of got) { w.stack += amt; w.won += amt; w.winner = true; w.hf.wsd = true; }
  g.pot = 0;
  yield { kind: 'pause', what: 'pay', ms: 650, data: { winners: [...got.keys()] } };
  if (mainW[0] && mainW[0].length) g.highlight = new Set(bestFive(mainW[0][0]!.cards.concat(g.board)));
  const partsMsg = V.parts.map((pt, j) => (mainW[j] ? `${pt.label}: ${mainW[j]!.map(nm).join(' & ')} (${mainW[j]![0]!.pname![j]})` : '')).filter(Boolean);
  const mw = mainMaj && mainMaj.w;
  const head = mw && mainMaj ? `${nm(mw)} ${mw.isHuman ? 'win' : 'wins'} ${mainMaj.c === m ? 'every part' : `${mainMaj.c} of ${m} parts`} and ${mw.isHuman ? 'take' : 'takes'} the whole pot: ${fmt(g, mw.won)}! ` : '';
  g.msg = head + partsMsg.join(' · ');
  g.explain = (mw && mainMaj && mainMaj.c < m ? `winning ${mainMaj.c} of ${m} parts takes the whole pot. ` : '') + partsMsg.join('; ');
  if (hero.won > 0 && live.includes(hero)) g.stats.sdWon++;
}

/** Practice view: everyone's cards face up after the hand (folded players' splits come from the driver). */
function* revealEveryone(g: Game): Generator<Step, void, unknown> {
  if (VAR(g)) yield { kind: 'practiceView' };
  const all = g.players.filter(p => p.cards.length === 2);
  const board = g.board.slice(0, g.boardVis);
  for (const p of all) {
    if (!p.handName || p.folded || p.mucked) {
      const what = board.length >= 3 ? describe(evaluate(p.cards.concat(board))) : holeName(p.cards[0]!, p.cards[1]!);
      p.handName = (p.folded ? 'Folded · would have had ' : p.mucked ? 'Mucked · ' : '') + what;
    }
  }
  for (const p of all) { if (!p.isHuman && !p.shown) { p.shown = true; p.justShown = true; } p.revealed = true; p.vis = 2; }
  lg(g, '*** ALL CARDS (practice view) ***');
  for (const p of all) lg(g, `${p.name}: ${partsText(g, p)}${p.folded ? ' (folded)' : p.mucked ? ' (mucked)' : ''}`);
  const V = VAR(g);
  ev(g, { t: 'all', list: all.map(p => ({ p, cards: p.cards.slice(), folded: p.folded, mucked: p.mucked, name: p.handName.replace(/^(Folded · would have had |Mucked · )/, ''), extra: V && p.extra ? p.extra.map((h, i) => ({ label: V.parts[i + 1]!.label, cards: h.slice(), name: partName(g, V.parts[i + 1]!.k, h) })) : null })) });
  yield { kind: 'pause', what: 'practiceView', ms: 700 };
}

/* ================= after the hand ================= */
function rememberPlays(g: Game): void {
  for (const p of g.players) {
    if (p.isHuman || !p.cards.length || !(p.shown || p.revealed)) continue;
    const bets = g.ev.filter(e => e.p === p && (e.t === 'bet' || e.t === 'raise') && (e.st ?? 0) >= 1);
    if (!bets.length) continue;
    const last = bets[bets.length - 1]!, b = g.ev.filter(x => x.t === 'board' && (x.st ?? 0) <= (last.st ?? 0)).pop();
    if (!b) continue;
    const bc = b.cards as Card[];
    const mi = madeInfo(p.cards, bc), d = drawInfo(p.cards, bc);
    p.mem = p.mem || { bluffs: 0, strong: 0, seen: 0 };
    p.mem.seen++;
    if (!mi.improves && !d.fd && d.sd !== 'oesd') p.mem.bluffs++;
    else if ((mi.cat >= 2 && mi.improves) || mi.topPair || (mi.cat === 1 && mi.improves && kAt(mi.v, 0) > Math.max(...bc.map(cr)))) p.mem.strong++;
  }
}

function finishHud(g: Game): string[] {
  const reads: string[] = [];
  for (const p of g.players) {
    if (p.out || !p.cards.length) continue;
    const h = p.hud, f = p.hf;
    h.hands++;
    if (f.vpip) h.vpip++; if (f.pfr) h.pfr++; if (f.threeOpp) h.threeOpp++; if (f.three) h.three++;
    if (f.cbetOpp) h.cbetOpp++; if (f.cbet) h.cbet++; if (f.sawFlop) h.sawFlop++; if (f.sawFlop && f.sd) h.wtsd++; if (f.wsd) h.wsd++;
    if (!p.isHuman && !p.read && h.hands >= 15) { p.read = true; reads.push(p.name); }
  }
  return reads;
}

/** Bots tilt after big losses and bad beats, and calm down otherwise. */
function updateMood(g: Game): void {
  for (const p of g.players) {
    if (p.isHuman || p.out || !p.cards.length) continue;
    const lost = p.start - p.stack, pr = p.persona!;
    const badBeat = p.eqAtReveal != null && p.eqAtReveal >= 0.65 && p.won === 0;
    if ((lost >= p.start * 0.35 && lost >= g.bb * 10) || badBeat) p.tilt = Math.min(1, p.tilt + pr.tiltProne * (badBeat ? 0.9 : 0.6));
    else p.tilt *= 0.8;
  }
}

export interface HandSummary { handNo: number; totalPot: number; heroNet: number | null; busted: Player[]; rebought: Player[]; newReads: string[]; lines: string[] }

/* ================= one hand ================= */
export function* playHand(g: Game): Generator<Step, HandSummary, unknown> {
  const rs = g.rs, alive = g.players.filter(p => !p.out);
  const startHandNo = g.handNo + 1;
  rs.seg('h' + startHandNo + ':start', () => {
    g.handNo++;
    const lvl = g.money ? 0 : Math.min(LEVELS.length - 1, Math.floor((g.handNo - 1) / g.settings.perLevel));
    g.level = lvl;
    [g.sb, g.bb, g.ante] = g.money ? HOME_BLINDS : LEVELS[lvl]!;
    for (const p of g.players) Object.assign(p, { cards: [], vis: 0, folded: p.out, allIn: false, bet: 0, total: 0, acted: false, raiseLocked: false, label: '', shown: false, justShown: false, mucked: false, score: 0, handName: '', won: 0, winner: false, eq: null, eqAtReveal: null, revealed: false, start: p.stack, hf: {}, rg: { top: 1, low: 0, agg: 0, raised: false, calls: 0, big: 0 }, _eq: null, all: [], extra: null, parts: null, splitDone: false, vrank: null, plan: null, _plan: null, pscore: null, pname: null, partWin: null });
    g.btab.clear();
    Object.assign(g, { variant: null, board2: [], boardVis2: 0, board: [], boardVis: 0, pot: 0, highlight: null, msg: '', explain: '', sideInfo: '', lastAggressor: null, pfAggressor: null, cbetMade: false, streetRaises: 0, revealed: false, vpip: false, pfr: false, hist: [], ev: [], street: 0, toAct: -1, currentBet: 0, minRaise: g.bb, handActive: true });
    g.button = g.button < 0 ? alive[Math.floor(rs.rand() * alive.length)]!.i : nextAlive(g, g.button);
    g.sbIdx = alive.length === 2 ? g.button : nextAlive(g, g.button);
    g.bbIdx = nextAlive(g, g.sbIdx);
    g.deck = g.nextDeck ? g.nextDeck.slice() : rs.seg('h' + g.handNo + ':deck', () => shuffled(rs.rand));
    g.nextDeck = null;
  });
  const hero = heroP(g);
  lg(g, g.money ? `Home Game Hand #${g.handNo}: ${g.settings.games === 'holdem' ? "Hold'em" : "Dealer's choice"} No Limit (${fmt(g, g.sb)}/${fmt(g, g.bb)} USD)` : `River Room Hand #${g.handNo}: Hold'em No Limit (${fmt(g, g.sb)}/${fmt(g, g.bb)}${g.ante ? `, ante ${fmt(g, g.ante)}` : ''}) - Level ${g.level + 1}`);
  lg(g, `Table ${g.tableNo} ${g.entrants}-max. Seat #${g.players[g.button]!.seat + 1} is the button`);
  for (const p of alive) lg(g, `Seat ${p.seat + 1}: ${p.name} (${fmt(g, p.stack)} in chips)`);
  yield { kind: 'pause', what: 'handStart', ms: 500 };
  if (g.money) {
    const d = g.players[g.button]!;
    g.variant = g.settings.games === 'holdem' ? 'holdem' : ((yield { kind: 'variant', p: d }) as VariantKey);
    const V0 = VARIANTS[g.variant];
    lg(g, `Game: ${V0.name} (${d.name}'s choice)`);
    if (g.settings.games !== 'holdem' && VAR(g)) g.tables.oppDist(g.variant);
    yield { kind: 'pause', what: 'variant', ms: !d.isHuman && g.settings.games !== 'holdem' ? 900 : 0, data: { d } };
  }
  if (g.ante) {
    for (const p of alive) {
      const a = Math.min(g.ante, p.stack);
      p.stack -= a; p.total += a; g.pot += a;
      if (!p.stack) p.allIn = true;
      lg(g, `${p.name}: posts the ante ${fmt(g, a)}`);
    }
    yield { kind: 'pause', what: 'antes', ms: 250 };
  }
  post(g, g.players[g.sbIdx]!, g.sb, 'small blind');
  post(g, g.players[g.bbIdx]!, g.bb, 'big blind');
  g.currentBet = g.bb; g.minRaise = g.bb;
  yield { kind: 'pause', what: 'blinds', ms: 1450 };
  lg(g, '*** HOLE CARDS ***');
  const order: Player[] = [];
  let k = nextAlive(g, g.button);
  for (let j = 0; j < alive.length; j++) { order.push(g.players[k]!); k = nextAlive(g, k); }
  const V = VAR(g), nDeal = V ? V.deal : 2;
  for (let r = 0; r < nDeal; r++) for (const p of order) (V ? p.all : p.cards).push(g.deck.pop()!);
  order.forEach(p => (p.vis = nDeal));
  // until someone plans a split, a player's poker cards are the first two dealt (as for the hero)
  if (V) order.forEach(p => { let i = 0; p.parts = V.parts.map(pt => { const grp = p.all.slice(i, i + pt.n); i += pt.n; return grp; }); p.cards = p.parts[0]!.slice(); p.extra = p.parts.slice(1).map(x => x.slice()); });
  if (!hero.out) { lg(g, `Dealt to ${hero.name} [${(V ? hero.all : hero.cards).map(cardTxt).join(' ')}]`); g.stats.hands++; ev(g, { t: 'dealt' }); }
  yield { kind: 'pause', what: 'deal', ms: 500, data: { order, nDeal } };
  if (V) yield { kind: 'plans', order };

  for (let st = 0; st < 4; st++) {
    g.street = st;
    if (st > 0) {
      for (const p of g.players) { p.bet = 0; p.acted = false; p.raiseLocked = false; if (!p.folded && !p.allIn) p.label = ''; }
      g.currentBet = 0; g.minRaise = g.bb; g.lastAggressor = null; g.streetRaises = 0;
      g.deck.pop(); // burn
      const n = st === 1 ? 3 : 1;
      for (let j = 0; j < n; j++) g.board.push(g.deck.pop()!);
      g.boardVis = g.board.length;
      if (st === 1) liveList(g).forEach(p => (p.hf.sawFlop = true));
      const b = g.board.map(cardTxt);
      lg(g, st === 1 ? `*** FLOP *** [${b.join(' ')}]` : st === 2 ? `*** TURN *** [${b.slice(0, 3).join(' ')}] [${b[3]}]` : `*** RIVER *** [${b.slice(0, 4).join(' ')}] [${b[4]}]`);
      ev(g, { t: 'board', cards: g.board.slice() });
      yield { kind: 'pause', what: 'board', ms: 1200, data: { st, n } };
      // house rule: both board-2 cards open together with the flop
      if (V && V.board2 && st === 1) {
        for (let j = 0; j < V.board2; j++) { g.board2.push(g.deck.pop()!); g.boardVis2 = g.board2.length; }
        lg(g, `*** BOARD 2 *** [${g.board2.map(cardTxt).join(' ')}]`);
        ev(g, { t: 'board2', cards: g.board2.slice() });
        yield { kind: 'pause', what: 'board2', ms: 1100 };
      }
      if (g.revealed) { updateAllInEquity(g); yield { kind: 'pause', what: 'runout', ms: 1600 }; }
    }
    if (!g.revealed && liveList(g).length > 1) yield* bettingRound(g);
    endStreet(g);
    yield { kind: 'pause', what: 'streetEnd', ms: 400 };
    if (liveList(g).length === 1) break;
    if (!g.revealed && ableList(g).length <= 1) {
      g.revealed = true;
      revealAll(g);
      yield { kind: 'pause', what: 'reveal', ms: V ? 900 : 1800 };
    }
  }
  const totalPot = g.players.reduce((a, p) => a + p.total, 0);
  if (liveList(g).length === 1) { winWithoutShowdown(g); yield { kind: 'pause', what: 'pay', ms: 600 }; }
  else if (V) { yield* finalSplits(g); yield* showdownMulti(g); }
  else yield* showdown(g);
  if (g.settings.revealAll) yield* revealEveryone(g);
  rememberPlays(g);
  g.toAct = -1; g.handActive = false;
  if (!hero.out) {
    if (g.vpip) g.stats.vpip++;
    if (g.pfr) g.stats.pfr++;
    if (hero.won > 0) { g.stats.won++; g.stats.biggest = Math.max(g.stats.biggest, hero.won); }
  }
  lg(g, '*** SUMMARY ***');
  lg(g, `Total pot ${fmt(g, totalPot)}${g.board.length ? ` | Board [${g.board.map(cardTxt).join(' ')}]` : ''}`);
  const newReads = finishHud(g);
  updateMood(g);
  const lines = g.hist.slice();
  const heroNet = hero.out ? null : hero.stack - hero.start;
  yield { kind: 'pause', what: 'handEnd', ms: 0, data: { totalPot } };
  const rebought: Player[] = [];
  if (g.money) {
    for (const p of g.players.filter(x => !x.isHuman && x.stack <= 0)) { p.stack = HOME_BUY; p.buyins++; rebought.push(p); lg(g, `${p.name} rebuys for ${fmt(g, HOME_BUY)}`); }
    if (hero.stack <= 0) {
      const c = yield { kind: 'rebuy', p: hero };
      if (c === 'yes') { hero.stack = HOME_BUY; hero.buyins++; rebought.push(hero); } else g.cashOutReq = true;
    }
  }
  const busted = g.money ? [] : g.players.filter(p => !p.out && p.stack <= 0).sort((a, b) => b.start - a.start);
  if (busted.length) {
    const remaining = g.players.filter(p => !p.out && p.stack > 0).length;
    busted.forEach((p, j) => { p.out = true; p.place = remaining + 1 + j; });
  }
  for (const p of g.players) Object.assign(p, { cards: [], all: [], extra: null, parts: null, splitDone: false, partWin: null, plan: null, vis: 0, shown: false, revealed: false, label: '', winner: false, handName: '', eq: null, bet: 0, allIn: false, folded: p.out });
  Object.assign(g, { board2: [], boardVis2: 0, board: [], boardVis: 0, highlight: null, msg: '', sideInfo: '', pot: 0, street: 0 });
  return { handNo: g.handNo, totalPot, heroNet, busted, rebought, newReads, lines };
}

/** Is the session over? (home: cash-out requested; tournament: hero out or one player left) */
export function sessionOver(g: Game): boolean {
  if (g.money) return g.cashOutReq;
  const hero = heroP(g), alive = g.players.filter(p => !p.out);
  if (hero.out) return true;
  if (alive.length === 1) { hero.place = 1; return true; }
  return false;
}

export type { GameEvent };
