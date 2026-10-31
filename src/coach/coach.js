// The coach: reads a decision (equity against likely hands, pot odds, position, opponents'
// styles), recommends an action and grades what you did. Also the shared adapter that gives
// the original function names on top of the TypeScript engine.
// DOM-free on purpose: it runs on the page, in the compute Web Worker and in Node tests.
// Plain JavaScript carried over from the original; typing it is planned work.
import * as C from '../engine/cards';
import * as T from '../engine/table';
import * as R from '../engine/reads';
import * as E from '../engine/engine';
import * as ST from '../engine/strength';
import * as SP from '../ai/split';
import * as Q from '../ai/equity';
import * as B from '../ai/bots';
import { VARIANTS, VAR_ORDER, DEALER_PICKS, splitsOf, combos, normSplit } from '../engine/variants';
import { tpScore, tpName } from '../engine/teenpatti';
import { TYPES, HOME_FRIENDS, NAMES, OPEN, PUSH } from '../engine/personas';

const { RANKCH, LOGR, SUITS, SUITCH, RNAME, PNAME, cr, cs, cardTxt, straightHigh, evaluate, catOf, kAt, describe, holeName, holeClass, bestFive } = C;
const { LEVELS, SEATMAP, HOME_BUY, HOME_BLINDS } = E;
const { handPct, rangeText, sortedPct, kPow, PCT } = ST;
const { CATN, drawInfo, madeInfo, bestPair } = Q;
const { comboEq, useSplit, applySplit, splitKey } = SP;


/** The game the coach reads, whether money is in dollars, and the player's settings. */
export let S = null;
export let MONEY = false;
export let settings = {};
export function bindGame(g, money, st){ S = g; MONEY = money; settings = st; }

/* ---- adapter: the original function names, bound to the current game S ---- */
const VAR = () => (S ? T.VAR(S) : null);
const liveList = () => T.liveList(S);
const ableList = () => T.ableList(S);
const heroP = () => (S ? T.heroP(S) : undefined);
const potTotal = () => T.potTotal(S);
const needsAction = p => T.needsAction(S, p);
const nextAlive = i => T.nextAlive(S, i);
const roundChips = x => T.roundChips(S, x);
const lg = t => T.lg(S, t);
const ev = e => T.ev(S, e);
const seatOrder = () => T.seatOrder(S);
const posInfo = p => T.posInfo(S, p);
const inPosition = p => T.inPosition(S, p);
const effStack = p => T.effStack(S, p);
const knownStyle = p => R.knownStyle(S, p);
const estOpen = p => R.estOpen(S, p);
const estVpip = p => R.estVpip(S, p);
const est3b = p => R.est3b(p);
const bluffEst = p => R.bluffEst(S, p);
const rangeModel = p => R.rangeModel(S, p);
const options = p => E.options(S, p);
const buildPots = () => E.buildPots(S);
let lastThreat = null;
const equityVs = (hole, board, models, iters, dead) => Q.equityVs(S.rs.rand, hole, board, models, iters, dead);
const sampleFrom = (m, deck, used, board, bcat) => Q.sampleFrom(S.rs.rand, m, deck, used, board, bcat);
const equityVsMulti = (hold, board, models, iters, dead, N) => { const r = Q.equityVsMulti(S.rs.rand, hold, board, models, iters, dead, N); lastThreat = r.threat; return r.eq; };
const equityKnown = (hands, board, iters) => Q.equityKnown(S.rs.rand, hands, board, iters);
const gameEquity = (p, models, iters, withThreat) => { const r = SP.gameEquity(S, p, models, iters, withThreat); lastThreat = S.lastThreat; return r; };
const holdEquity = (p, hold, models, iters) => { const r = SP.holdEquity(S, p, hold, models, iters); lastThreat = S.lastThreat; return r; };
const quickSplitScores = (V, cards, board, board2, k) => SP.quickSplitScores(S, V, cards, board, board2, k);
const vsOne = (j, kind, h, dead) => SP.vsOne(S, j, kind, h, dead);
const splitValue = (s, k, dead) => SP.splitValue(S, s, k, dead);
const planSplit = (p, k) => SP.planSplit(S, p, k);
const varRankOf = s => SP.varRankOf(S, s);
const b2Win = (h, vis, k, p) => SP.b2Win(S, h, vis, k, p);
const extraWins = (p, k, ex) => SP.extraWins(S, p, k, ex);
const partName = (kind, h) => SP.partName(S, kind, h);
const partScore = (kind, h) => SP.partScore(S, kind, h);
const oppDist = key => S.tables.oppDist(key);
const oppCdf = (key, j, str) => S.tables.oppCdf(key, j, str);
const tpPct = h => S.tables.tpPct(h);
const h5Pct = h => S.tables.h5Pct(h);
const partStr = (kind, h) => S.tables.partStr(kind, h);
/** Optional `?seed=...` in the URL makes a session reproducible (used by the browser tests). */

const num = n => Math.round(n).toLocaleString('en-US');
const fmt = n => MONEY ? (n < 0 ? '-$' : '$') + (Math.abs(Math.round(n)) / 100).toFixed(2) : Math.round(n).toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pc = x => Math.round(x * 100) + '%';
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

const SUITCLS = ['s-s','s-h','s-d','s-c'];
const icard = c => `<span class="ic ${SUITCLS[cs(c)]}">${RANKCH[cr(c)]}${SUITS[cs(c)]}</span>`;
const icards = a => a.map(icard).join('');

const partsText = p => { const V = VAR(); return V && p.parts ? V.parts.map((pt, j) => `${pt.label} [${p.parts[j].map(cardTxt).join(' ')}]`).join(' | ') : `[${p.cards.map(cardTxt).join(' ')}]`; };
const nm = p => p.isHuman ? 'You' : p.name;

const GRADE_LABEL = {great: 'Great', good: 'Good', fine: 'Okay', mistake: 'Mistake', blunder: 'Big mistake'};
const GRADE_SCORE = {great: 1, good: 1, fine: 0.6, mistake: 0.15, blunder: 0};
const LESSONS = {
  tight_pre: 'Don\'t fold good cards. Pairs and two big cards are worth playing.',
  loose_pre: 'Play fewer hands, especially when you act early. Fold Red hands.',
  limp: 'Raise instead of just calling the big blind. A raise can win the pot right away.',
  call_no_odds: 'Before you call, compare the price with your chance to win. If it costs a lot and you rarely win, fold.',
  overfold: 'If calling is cheap and you win often enough, call. It pays off over time.',
  missed_value: 'When you have a strong hand, bet. Make the others pay to see more cards.',
  bluff_multi: 'Don\'t bluff against many players. Someone usually has something.',
  passive: 'With a very strong hand, raise instead of just calling.',
  risky_allin: 'Only put all your chips in with strong hands.',
  sizing_small: 'With a good hand, bet about half the pot. Tiny bets win tiny pots.',
  free_fold: 'Never fold when you can check for free.',
  bad_split: 'Split your cards so every part has a real chance. Pairs, sequences and same-suit cards win 3 Patti; two high cards or a pair are what you want for poker. Tap "Use the coach\'s split" to compare.'
};
const CONCEPTS = [
  'Acting last is a big advantage: you see what everyone else does first. Play more hands when you have the dealer chip.',
  'Price check: if a call costs 50 and the pot will be 200, you need to win at least 1 time in 4 (25%) for it to pay off.',
  'Counting helpful cards: on the flop, (number of cards that help you) × 4 is roughly your % chance to hit by the end. On the turn, × 2.',
  'You almost never know someone\'s exact cards. Ask yourself: what kind of cards would they bet like this?',
  'The player who raised before the flop often bets again on the flop, even when they missed.',
  'Bet when you think you are ahead. Bluff rarely, and only against one player.',
  'With very few chips (about 12 big blinds or less), go all-in or fold before the flop.'
];
const LIGHT = p => p <= 0.07 ? {c: 'g', w: 'Green', d: 'a strong starting hand'} : p <= 0.45 ? {c: 'y', w: 'Yellow', d: 'an okay hand, best played from a late seat'} : {c: 'r', w: 'Red', d: 'a weak hand'};
const lightHTML = L => `<b class="lt-${L.c}">${L.w} hand</b>`;
// split games: colour by the share of the pot the hand really wins
const lightOf = c => { if (!c.parts) return LIGHT(c.pct); const s = varShare(c.pct); return s >= 0.26 ? {c: 'g', w: 'Green', d: 'a strong starting hand'} : s >= 0.195 ? {c: 'y', w: 'Yellow', d: 'a playable hand'} : {c: 'r', w: 'Red', d: 'a weak hand'}; };
const SEATTXT = {ep: 'You act early. Most players act after you, and one of them often has better cards.', hj: 'You are in a middle seat. A few players still act after you.', co: 'You are one seat before the dealer chip. Only a few players act after you.', btn: 'You have the dealer chip, so you act last. That is the best seat.', hu: 'You have the dealer chip, so you act last after the flop.', sb: 'You are the small blind. You will act first after the flop, which is hard.', bb: 'You are the big blind. You already paid, so calling is cheaper.'};
const SEATSHORT = {ep: 'Early seat', hj: 'Middle seat', co: 'Late seat', btn: 'Dealer chip', hu: 'Dealer chip', sb: 'Small blind', bb: 'Big blind'};
function preSituation(p){
  const raises = S.streetRaises;
  if (raises === 0){ const limpers = S.players.filter(x => x !== p && x.i !== S.bbIdx && !x.folded && !x.out && x.bet >= S.bb).length; return limpers ? 'limped' : 'unopened'; }
  return raises === 1 ? 'raise' : '3bet';
}
function coachContext(p){
  const o = options(p), opps = liveList().filter(x => x !== p), pot = potTotal(), toCall = o.toCall;
  const models = opps.map(rangeModel);
  const V = VAR(), best = V && !p.splitDone ? planSplit(p, opps.length) : null;
  const hold = best ? best[0] : p.cards, ex = best ? best.slice(1) : p.extra;
  let eqHold, xs, eq, threat;
  if (V){
    const g = gameEquity(p, models, S.street === 0 ? 260 : 320, true); threat = lastThreat;
    eqHold = g.parts[0]; xs = g.parts.slice(1); eq = g.eq;
    // the simulation plays your stronger 3 Patti 1st; line the numbers up with your planned hands
    if (xs.length === 2 && tpScore(ex[0]) < tpScore(ex[1])) xs = [xs[1], xs[0]];
  } else { eqHold = holdEquity(p, hold, models, S.street === 0 ? 500 : 700); threat = lastThreat; xs = []; eq = eqHold; }
  const main = (S.lastAggressor && S.lastAggressor !== p && !S.lastAggressor.folded) ? S.lastAggressor : opps.slice().sort((a, b) => (b.rg.agg + (b === S.pfAggressor ? .5 : 0)) - (a.rg.agg + (a === S.pfAggressor ? .5 : 0)))[0];
  const ag = S.lastAggressor;
  return {
    st: S.street, pos: posInfo(p), hole: hold.slice(), board: S.board.slice(), pot, toCall, need: toCall > 0 ? toCall / (pot + toCall) : 0,
    eq, k: opps.length, main, mainName: main ? nm(main) : '', mainRange: main ? rangeText(main.rg.top) : '', mainAgg: main ? main.rg.agg : 0,
    pct: handPct(hold[0], hold[1]), cls: holeClass(hold[0], hold[1]), hn: holeName(hold[0], hold[1]),
    made: S.board.length ? madeInfo(hold, S.board) : null, draw: drawInfo(hold, S.board), stack: p.stack, bet: p.bet,
    effBB: effStack(p) / S.bb, bb: S.bb, o, preSit: S.street === 0 ? preSituation(p) : null, ip: inPosition(p),
    allInFacing: toCall > 0 && (toCall >= p.stack * 0.45 || !!(ag && ag.allIn)), currentBet: S.currentBet, raiser: ag,
    ...(V ? {eqHold, holdLabel: V.parts[0].label, pct: S.street === 0 && p.vrank != null ? p.vrank : varRankOf([hold].concat(ex)),
      parts: ex.map((h, i) => ({label: V.parts[i + 1].label, kind: V.parts[i + 1].k, cards: h.slice(), name: partName(V.parts[i + 1].k, h), win: xs[i]})),
      bestTxt: V.parts.map((pt, j) => `${esc(pt.label)} ${icards(j ? ex[j - 1] : hold)}`).join(', '),
      arrDiff: !!(p.isHuman && p.plan && best && splitKey(p.plan) !== splitKey(best)), threat, nDeal: V.deal,
      nParts: V.parts.length, lockedLabel: (S.boardVis === 5 && vsOne(0, 'hold', hold, p.all) >= 1) ? V.parts[0].label : (V.parts.slice(1).find((pt, i) => xs[i] >= 0.995) || {}).label || '',
      locked: ((S.boardVis === 5 && vsOne(0, 'hold', hold, p.all) >= 1) ? 1 : 0) + xs.filter(x => x >= 0.995).length,
      hn: `${holeName(hold[0], hold[1])} for ${V.parts[0].label.toLowerCase()}, ` + ex.map((h, i) => `${partName(V.parts[i + 1].k, h)} for ${V.parts[i + 1].label}`).join(', ')} : {})
  };
}
// Split games: what your other parts are worth right now
// Different ways to split your cards right now, so you can choose: all-round, poker first, or 3 Patti first
function splitOptions(p, k, curS){
  const V = VAR(), pw = Math.max(1, k), memo = V.parts.map(() => new Map());
  const one = (j, h) => { const m = memo[j], key = h.reduce((a, c) => a + 2 ** c, 0); let v = m.get(key); if (v === undefined){ v = vsOne(j, V.parts[j].k, h, p.all); m.set(key, v); } return v; };
  const rate = sp => { const w = sp.map((h, j) => Math.pow(one(j, h), pw)); return {s: sp, w, tot: comboEq(w[0], w.slice(1), k)}; };
  const all = splitsOf(V, p.all).map(rate), other = o => o.w.slice(1).reduce((a, b) => a + b, 0);
  const top = f => all.reduce((a, b) => f(b) > f(a) + 1e-9 || (Math.abs(f(b) - f(a)) <= 1e-9 && b.tot > a.tot) ? b : a);
  const opts = [];
  const add = (label, o) => { if (!opts.some(x => splitKey(x.s) === splitKey(o.s))) opts.push(Object.assign({label}, o)); };
  add('Best all-round', top(o => o.tot));
  add(`Strongest ${V.parts[0].label === 'Poker' ? 'poker' : V.parts[0].label}`, top(o => o.w[0]));
  add(V.parts.length === 3 ? 'Strongest 3 Patti hands' : `Strongest ${V.parts[1].label}`, top(other));
  return {opts, cur: curS ? rate(curS) : null};
}
function splitHintLines(p, k, curS){
  const V = VAR(), {opts, cur} = splitOptions(p, k, curS);
  const show = o => V.parts.map((pt, j) => `${esc(pt.label)} ${icards(o.s[j])} <span class="muted">${esc(partLabelName(pt.k, o.s[j]))}, ${pc(o.w[j])}</span>`).join(' · ') + ` → about <b>${pc(o.tot)}</b> of the pot`;
  const out = [];
  // tell the player when a new card changed which split is best
  const bestNow = opts[0], prev = S.hintBest, cardWord = ['', 'flop', 'turn card', 'river card'][S.street] || 'new card';
  if (prev && prev.key !== splitKey(bestNow.s) && prev.board !== S.boardVis) out.push(`<b>The ${cardWord} changed the best split.</b> Before: ${prev.txt}. Now: ${V.parts.map((pt, j) => `${esc(pt.label)} ${icards(bestNow.s[j])}`).join(', ')}.`);
  if (!prev || prev.board !== S.boardVis || prev.key !== splitKey(bestNow.s)) S.hintBest = {key: splitKey(bestNow.s), board: S.boardVis, txt: V.parts.map((pt, j) => `${esc(pt.label)} ${icards(bestNow.s[j])}`).join(', ')};
  // a part that nobody can beat locks in its share of the pot
  const nut = opts.concat(cur ? [cur] : []).find(o => o.w.some((x, j) => x >= 0.999 && (V.parts[j].k === 'hold' || V.parts[j].k === 'b2')));
  if (nut){ const j = nut.w.findIndex((x, j) => x >= 0.999 && (V.parts[j].k === 'hold' || V.parts[j].k === 'b2')); out.push(`<b>${esc(V.parts[j].label)} ${icards(nut.s[j])} (${esc(partLabelName(V.parts[j].k, nut.s[j]))}) is the best possible hand on this table.</b> Nobody can beat it, at most tie it. Using it locks in that share of the pot, so a sure half is often better than a strong-but-beatable hand somewhere else.`); }
  if (cur) out.push(`<b>Your cards now:</b> ${show(cur)}`);
  for (const o of opts) out.push(`<b>${o.label}${cur && splitKey(o.s) === splitKey(cur.s) ? ' (same as yours)' : ''}:</b> ${show(o)}`);
  out.push(`The % next to each part is your chance to win that part against everyone still in. You decide: make one part very strong, or keep every part decent.${S.boardVis < 5 && S.street < 4 ? ' More table cards are coming, so the poker part can still change; ' + (V.parts.some(x => x.k === 'tp') ? '3 Patti hands do not.' : V.parts.some(x => x.k === 'h5') ? 'hand poker does not.' : 'board 2 is already out.') : ''}`);
  if (V.parts.length === 3) out.push('Winning 2 of the 3 parts takes the whole pot, so two strong parts can beat three okay ones. ' + orderTip());
  return out;
}
function partLines(c){
  if (!c.parts) return [];
  const out = splitHintLines(heroP(), c.k, heroP().plan);
  const b2 = c.parts.find(x => x.kind === 'b2');
  if (b2 && S.boardVis2 < 2) out.push(`Board 2 still has ${2 - S.boardVis2} card${S.boardVis2 === 1 ? '' : 's'} to come. Pairs and cards of one suit or in a row get better with it.`);
  return out;
}
const eqLine = (c, pre) => c.parts ? `${pre} (with the best all-round split): about <b>${pc(c.eq)}</b> of the pot overall (${esc(c.holdLabel)} ${pc(c.eqHold)}, ${c.parts.map(x => esc(x.label) + ' ' + pc(x.win)).join(', ')}). ${c.parts.length === 2 ? 'Win 2 of the 3 parts and you take the whole pot.' : 'Each part wins its own share.'}` : `${pre}: about <b>${pc(c.eq)}</b>.`;
function topTxt(x){ return 'top ' + Math.max(1, Math.round(x * 100)) + '%'; }
// What your pair means compared to the cards on the table
function pairWords(hole, board, mi){
  if (!mi || mi.cat !== 1 || !mi.improves) return '';
  const r = kAt(mi.v, 0), br = board.map(cr).sort((a, b) => b - a), pocket = cr(hole[0]) === cr(hole[1]);
  if (pocket && r > br[0]) return 'an overpair: your pair is higher than every card on the table';
  if (pocket) return `a pocket pair below the ${RNAME[br[0]]} on the table`;
  const kick = cr(hole[0]) === r ? cr(hole[1]) : cr(hole[0]);
  if (r === br[0]) return `top pair, with ${RNAME[kick] === 'Ace' ? 'an' : 'a'} ${RNAME[kick]} as your side card`;
  if (r === br[br.length - 1]) return 'bottom pair: the weakest pair you can make with this board';
  return `middle pair: there is a higher card (${RNAME[br[0]]}) on the table that beats it`;
}
const STYLE_FACING = {
  rohit: (o, n) => `Rohit only bets when he has something, and he folds weak hands. ${n >= 2 ? 'Betting again and again from him means a real hand.' : 'His bets are usually real.'}`,
  krish: (o, n, checkedFirst) => checkedFirst ? 'Krish loves to bet when everyone checks, and he bets medium pairs like monsters. This could easily be a bluff or a medium hand.' : `Krish bets medium pairs like monsters and sometimes bluffs.${n >= 3 ? ' But three bets in a row from him usually means a real hand.' : ' A decent pair often beats him.'}`,
  nikhil: (o, n, cf, big) => `Nikhil is the best player at your table. He bluffs sometimes, mostly with smaller bets, and bets bigger when his hand is strong.${big ? ' A bet this big from him usually means a strong hand.' : n >= 2 ? ' Two bets in a row from him usually means a good hand.' : ' A small bet from him can be a bluff.'}`,
  venky: () => 'Venky bets big at random and often does not know what he has. A decent pair is usually good enough to call him.'
};
const STYLE_CHECKED = {
  rohit: 'Rohit checks when he has nothing and folds to big bets. A bet of about 50¢–$1 often wins this pot right away.',
  krish: 'Krish likes to bet when everyone checks. If you have something decent, checking can let him bluff into you.',
  nikhil: 'Nikhil does not fold good hands to small bets, so only bet when you are ahead.',
  venky: 'Never bluff Venky: he calls. If you have anything good, bet, because he pays you.'
};
function oppLines(o, c){
  if (!o) return [];
  const out = [], ks = knownStyle(o), name = esc(o.name);
  const bets = S.ev.filter(e => e.p === o && (e.t === 'bet' || e.t === 'raise') && e.st >= 1);
  const streets = new Set(bets.map(e => e.st)).size, last = bets[bets.length - 1];
  const big = !!(last && (MONEY ? last.to >= 100 : last.to >= c.pot * 0.45));
  const checkedFirst = c.toCall > 0 && S.ev.some(e => e.st === S.street && e.t === 'check' && e.p !== o) && S.ev.filter(e => e.st === S.street && e.p === o).length === 1;
  if (c.toCall > 0 && streets >= 2) out.push(`${name} has bet on ${streets} streets in a row${last ? `, now ${fmt(last.to)}` : ''}.`);
  if (MONEY && c.toCall > 0 && last && last.to >= 100) out.push(`${fmt(last.to)} is a big bet at your table${last.to >= 200 ? ', more than twice the usual big bet' : ''}.`);
  if (ks && ks.home){
    if (c.toCall > 0 && STYLE_FACING[o.type]) out.push(STYLE_FACING[o.type](o, streets, checkedFirst, big));
    else if (c.toCall === 0 && c.k === 1 && STYLE_CHECKED[o.type]) out.push(STYLE_CHECKED[o.type]);
  } else if (ks){
    out.push(`Your read: ${name} plays like a ${TYPES[o.type].label.toLowerCase()}. ${TYPES[o.type].beat}`);
  } else if (o.hud.hands >= 8){
    out.push(`From what you have seen, ${name} plays ${pc(o.hud.vpip / o.hud.hands)} of hands and raises ${pc(o.hud.pfr / o.hud.hands)} before the flop.`);
  }
  if (o.mem && o.mem.seen >= 1 && (o.mem.bluffs || o.mem.strong)) out.push(`So far you have seen ${name} bet with nothing ${o.mem.bluffs} time${o.mem.bluffs === 1 ? '' : 's'} and with a real hand ${o.mem.strong} time${o.mem.strong === 1 ? '' : 's'}.`);
  return out;
}
const PLUR = r => r === 6 ? 'Sixes' : RNAME[r] + 's';
// Which cards still to come would make your hand better (not cards that help everyone equally)
function improveInfo(hole, board){
  if (board.length < 3 || board.length >= 5) return null;
  const known = new Set(hole.concat(board)), unseen = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) unseen.push(c);
  const lead = (h, b) => catOf(evaluate(h.concat(b))) - catOf(evaluate(b));
  const curLead = lead(hole, board), curCat = catOf(evaluate(hole.concat(board)));
  const groups = {}; let outs = 0;
  for (const c of unseen){
    const nb = board.concat([c]), cat = catOf(evaluate(hole.concat(nb)));
    if (cat > curCat && lead(hole, nb) > curLead){ outs++; (groups[cat] = groups[cat] || {n: 0, ranks: new Set()}).n++; groups[cat].ranks.add(cr(c)); }
  }
  let byRiver = null;
  if (board.length === 3){
    let hit = 0, tot = 0;
    for (let i = 0; i < unseen.length; i++) for (let j = i + 1; j < unseen.length; j++){
      const nb = board.concat([unseen[i], unseen[j]]); tot++;
      if (catOf(evaluate(hole.concat(nb))) > curCat && lead(hole, nb) > curLead) hit++;
    }
    byRiver = hit / tot;
  }
  const list = Object.entries(groups).sort((a, b) => b[0] - a[0]).map(([cat, g]) => {
    const cat_ = +cat, ranks = [...g.ranks].sort((a, b) => b - a);
    const which = cat_ === 5 || cat_ === 8 ? `any ${['Spade', 'Heart', 'Diamond', 'Club'][cs(hole[0])]}` : ranks.length <= 3 ? 'a ' + ranks.map(r => RNAME[r]).join(' or ') : `${ranks.length} different cards`;
    return `${g.n} card${g.n > 1 ? 's' : ''} give${g.n > 1 ? '' : 's'} you ${CATN[cat_]} (${which})`;
  });
  return {outs, next: outs / unseen.length, byRiver, list};
}
// What the table cards make possible for everyone
function boardTexture(board){
  if (board.length < 3) return [];
  const out = [], rc = {}, sc = [0, 0, 0, 0];
  for (const c of board){ rc[cr(c)] = (rc[cr(c)] || 0) + 1; sc[cs(c)]++; }
  const SN = ['spades', 'hearts', 'diamonds', 'clubs'];
  const pairs = Object.entries(rc).filter(([, n]) => n >= 2).map(([r]) => +r).sort((a, b) => b - a);
  if (pairs.length) out.push(`The table is paired (${pairs.map(PLUR).join(' and ')}): anyone holding a ${pairs.map(r => RNAME[r]).join(' or a ')} has three of a kind or better.`);
  const fs = sc.findIndex(n => n >= 3), fd = sc.findIndex(n => n === 2);
  if (fs >= 0) out.push(`${sc[fs] >= 4 ? 'Four' : 'Three'} ${SN[fs]} on the table: anyone with ${sc[fs] >= 4 ? 'one' : 'two'} ${SN[fs]} has a flush.`);
  else if (fd >= 0 && board.length < 5) out.push(`Two ${SN[fd]} on the table: someone could be hoping for a flush.`);
  let m = 0; for (const c of board){ m |= 1 << cr(c); if (cr(c) === 14) m |= 2; }
  let best = 0; for (let lo = 1; lo <= 10; lo++){ let n = 0; for (let r = lo; r < lo + 5; r++) if (m & (1 << r)) n++; best = Math.max(best, n); }
  if (straightHigh(m) && board.length >= 5) out.push('The table itself makes a straight: everyone plays it.');
  else if (best >= 4) out.push('Four cards in a row (or close) on the table: one more right card makes someone a straight.');
  else if (best >= 3) out.push(`Three cards close together: someone with two cards that fit in has ${board.length >= 5 ? 'a straight' : 'a straight or a straight draw'}.`);
  else if (board.length < 5){ const rs = [...new Set(board.map(cr))].sort((a, b) => a - b); for (let i = 1; i < rs.length; i++) if (rs[i] - rs[i - 1] <= 2){ out.push(`The ${RNAME[rs[i - 1]]} and ${RNAME[rs[i]]} are close together: someone could be hoping for a straight.`); break; } }
  if (!out.length) out.push('A "dry" table: no pairs, no flush or straight chances. Strong hands are rare here.');
  return out;
}
// Of the hands this player would play this way, how many beat you right now?
function threatInfo(hole, board, o){
  if (!o || board.length < 3) return null;
  const known = new Set(hole.concat(board)), deck = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  const m = rangeModel(o), bcat = catOf(evaluate(board)), mine = evaluate(hole.concat(board)), myCat = catOf(mine);
  const N = 500, ahead = {}; let nAhead = 0, nTie = 0, nDraw = 0;
  for (let i = 0; i < N; i++){
    const h = sampleFrom(m, deck, new Set(), board, bcat), v = evaluate(h.concat(board));
    if (v > mine){ nAhead++; const cat = catOf(v); const key = cat === myCat ? (cat === 0 ? 'higher cards (no pair)' : cat === 1 ? 'a higher pair' : cat === 2 ? 'better two pair' : 'a better ' + CATN[cat].replace(/^a /, '')) : CATN[cat]; ahead[key] = (ahead[key] || 0) + 1; }
    else if (v === mine) nTie++;
    else if (board.length < 5){ const d = drawInfo(h, board); if (d.fd || d.sd === 'oesd') nDraw++; }
  }
  const top = Object.entries(ahead).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${pc(n / N)}`);
  return {ahead: nAhead / N, tie: nTie / N, draw: nDraw / N, behind: 1 - (nAhead + nTie + nDraw) / N, top};
}
function prePotential(hole){
  const [a, b] = hole, ra = cr(a), rb = cr(b), out = [];
  if (ra === rb) out.push('Pocket pair: you make three of a kind on the flop about 1 time in 8 (12%). If you miss, your pair is often beaten by a higher card on the table.');
  else {
    out.push('You pair at least one of your cards on the flop about 1 time in 3 (32%).');
    const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
    out.push(lo >= 10 ? 'Both cards are high, so when you pair, it is usually a strong pair.' : hi >= 11 ? `Your ${RNAME[hi]} is a decent card to pair; pairing the ${RNAME[lo]} makes only a weak pair.` : 'Both cards are small: even when you pair, a higher pair often beats you.');
  }
  if (cs(a) === cs(b)) out.push('Same suit: you make a flush by the river about 1 time in 16 (6%).');
  const gap = Math.abs(ra - rb);
  if (ra !== rb && (gap <= 2 || (Math.max(ra, rb) === 14 && Math.min(ra, rb) <= 5))) out.push('Your cards are close together, so they can make a straight (about 1 time in 12 by the river).');
  return out;
}
function rangeSummary(o){
  const r = o.rg;
  if (r.agg >= 3 || r.big) return 'usually top pair or better';
  if (r.raised || r.agg >= 2) return 'usually a decent pair or better';
  if (r.agg === 1) return 'often a pair or a draw, sometimes a bluff';
  if (r.calls) return 'often a pair, a draw or high cards';
  return rangeText(r.top);
}
const strip = h => h.replace(/<[^>]+>/g, '');
function rec(act, lines, extra){ const r = Object.assign({act, lines}, extra || {}); r.why = lines.map(strip).join(' '); return r; }
const priceLine = c => `Calling costs ${fmt(c.toCall)} to win a pot of ${fmt(c.pot + c.toCall)}. That pays off only if you win at least <b>${pc(c.need)}</b> of the time.`;
// Split games, measured by simulation: how much of a 5-way pot a starting hand wins when everyone limps and sees the showdown
const VAR_SHARE = {
  std: [[.04, .32], [.13, .26], [.23, .24], [.34, .22], [.45, .215], [.53, .21], [.57, .17], [.63, .155], [.69, .14], [.9, .135]],
  two: [[.04, .265], [.12, .235], [.23, .225], [.34, .22], [.5, .215], [.53, .18], [.62, .175], [.68, .17], [.77, .148], [.9, .145]],
  n7: [[.04, .36], [.13, .27], [.21, .25], [.31, .23], [.41, .22], [.5, .22], [.55, .21], [.62, .13], [.69, .125], [.8, .09], [.92, .075]],
  k8: [[.07, .35], [.17, .34], [.22, .32], [.27, .24], [.32, .225], [.37, .22], [.42, .2], [.48, .155], [.55, .13], [.63, .13], [.72, .125], [.85, .095]]
};
function varShare(pct){
  const t = VAR_SHARE[S.variant]; if (!t) return 0.2;
  if (pct <= t[0][0]) return t[0][1]; if (pct >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 1; i < t.length; i++) if (pct <= t[i][0]){ const [a, x] = t[i - 1], [b, y] = t[i]; return x + (y - x) * (pct - a) / (b - a); }
  return 0.2;
}
// the weakest hand (as a rank) that still wins at least `share` of the pot
function varThr(share){ const t = VAR_SHARE[S.variant]; let thr = 0.02; if (t) for (let p = 0.01; p < 0.99; p += 0.01) if (varShare(p) >= share) thr = p; return thr; }
function coachPreVar(c, handLine){
  const key = c.pos.key, sh = varShare(c.pct);
  const shareLine = `When everyone just calls and sees the end, hands like yours win about <b>${pc(sh)}</b> of a 5-player pot. A fair share is 20%: one pot in five.`;
  const why = 'In games with more cards, hands are much closer in strength than in simple poker, so you can play more of them. Only hands with very little in any part should be folded.';
  // position: acting late, or already half in as small blind, makes calling a bit better
  const bar = ({ep: 1.04, hj: 1.02, co: 0.97, btn: 0.94, hu: 0.92, sb: 0.93}[key] || 1) * 0.2;
  if (c.preSit === 'unopened' || c.preSit === 'limped'){
    if (c.pct <= 0.06 || sh >= 0.28) return rec('raise', [handLine, shareLine, 'This is one of the best starting hands in this game. A small raise to 40¢ builds a bigger pot while you are ahead.'], {size: 40, thr: 0.06});
    if (c.toCall === 0) return rec('check', [handLine, shareLine, 'Nobody raised, so check and see the flop for free.'], {thr: 1});
    if (sh >= bar) return rec('call', [handLine, shareLine, `Calling ${fmt(c.toCall)} pays off over time with this hand. ${why}`], {thr: varThr(bar)});
    return rec('fold', [handLine, shareLine, `That is below a fair share, so even ${fmt(c.toCall)} loses money over time. ${SEATTXT[key]} Fold this one.`], {thr: varThr(bar)});
  }
  if (c.preSit === 'raise' && c.currentBet <= 60){
    const need = bar * (c.currentBet <= 40 ? 1.15 : 1.3), rl = c.raiser ? ` ${esc(c.raiser.name)} raised, so the pot is more expensive.` : '';
    if (c.pct <= 0.03) return rec('raise', [handLine, shareLine, `${rl} Your hand is one of the very best, so raise again a little.`], {size: c.currentBet * 2.5, thr: 0.03});
    if (sh >= need) return rec('call', [handLine, shareLine, `${rl} Your hand is strong enough to call the raise.`], {thr: varThr(need)});
    return rec('fold', [handLine, shareLine, `${rl} For the higher price you need a better hand. Fold.`], {thr: varThr(need)});
  }
  return null;
}
function coachPre(c){
  const key = c.pos.key, bb = c.bb, L = lightOf(c), who = esc(c.mainName), hn = esc(c.hn);
  const handLine = c.parts ? `Your cards: ${hn}. All together that is a ${lightHTML(L)}.` : `Your cards: ${hn}. That is a ${lightHTML(L)} (${L.d}).`;
  if (c.allInFacing){
    const ok = c.eq >= c.need + 0.02;
    return rec(ok ? 'call' : 'fold', [`${who} bet big or went all-in.`, priceLine(c), c.parts ? eqLine(c, `Against what ${who} probably has, you win`) : `${who} probably has ${esc(c.mainRange)}. Against that, your chance to win is about <b>${pc(c.eq)}</b>.`, ok ? 'That is enough. Call.' : 'That is not enough. Fold.'], {eqMode: true, thr: c.need});
  }
  const Rtop = c.raiser ? c.raiser.rg.top : 0.2;
  const rks = knownStyle(c.raiser);
  const raiserRead = !c.raiser ? '' : rks && rks.home ? ({rohit: 'Rohit hardly ever raises, so his raise means a strong hand.', krish: 'Krish raises good hands, though he sometimes overplays medium ones.', nikhil: 'Nikhil raises good hands. Respect it.', venky: 'Venky raises at random, so his raise does not mean much.'}[c.raiser.type] || '') : rks ? `Your read: ${esc(c.raiser.name)} plays like a ${TYPES[c.raiser.type].label.toLowerCase()}.` : (c.raiser.hud.hands >= 8 ? `${esc(c.raiser.name)} has raised ${pc(c.raiser.hud.pfr / c.raiser.hud.hands)} of hands so far.` : '');
  if (c.parts){ const vr = coachPreVar(c, handLine); if (vr) return vr; }
  if (MONEY){
    const playTop = {ep: .22, hj: .26, co: .32, btn: .4, hu: .45, sb: .32, bb: 1}[key] || .3;
    if (c.preSit === 'unopened' || c.preSit === 'limped'){
      if (c.pct <= 0.05) return rec('raise', [handLine, 'This is one of the best starting hands. At your table nobody raises much, so a small raise to 40¢ grows the pot without scaring everyone away.'], {size: 40, thr: 0.05});
      if (c.toCall === 0) return rec('check', ['Nobody raised, so check and see the flop for free.'], {thr: 1});
      if (c.pct <= playTop) return rec('call', [handLine, 'At your table almost everyone just calls 20¢, so calling to see the flop is fine with this hand.'], {thr: playTop});
      return rec('fold', [handLine, SEATTXT[key], 'Even for 20¢, this hand loses more than it wins over time. Fold.'], {thr: playTop});
    }
    if (c.preSit === 'raise' && c.currentBet <= 60){
      const top = playTop * 0.7;
      const rr = c.raiser && c.raiser.type === 'venky' ? 0.35 : top; const rl = raiserRead ? ' ' + raiserRead : '';
      if (c.pct <= 0.03) return rec('raise', [handLine, `${who} made a small raise.${rl} Your hand is one of the very best, so raise again a little.`], {size: c.currentBet * 2.5, thr: 0.03});
      if (c.pct <= rr) return rec('call', [handLine, `${who} made a small raise.${rl} Your hand is good enough to call.`], {thr: rr});
      return rec('fold', [handLine, `${who} raised.${rl} Fold this one.`], {thr: rr});
    }
  }
  if (c.effBB <= 12 && (c.preSit === 'unopened' || c.preSit === 'limped')){
    const push = PUSH[key] * Math.pow(10 / Math.max(3, c.effBB), 0.6);
    if (c.pct <= push) return rec('allin', [handLine, `You only have about ${Math.round(c.effBB)} big blinds left. With so few chips, either go all-in or fold.`, 'This hand is good enough to go all-in.'], {thr: push});
    return rec(c.toCall === 0 ? 'check' : 'fold', [handLine, `You only have about ${Math.round(c.effBB)} big blinds left, so wait for a better hand to go all-in with.`], {thr: push});
  }
  if (c.preSit === 'unopened'){
    const open = OPEN[key];
    if (key === 'bb') return rec('check', ['Nobody raised, so you can check and see the flop for free.'], {thr: open});
    if (c.pct <= open) return rec('raise', [handLine, SEATTXT[key], 'Nobody has bet yet, so raise. You might win the blinds right away.'], {size: bb * (key === 'sb' ? 3 : 2.5), thr: open});
    return rec('fold', [handLine, SEATTXT[key], 'From this seat, fold it and save your chips for better cards.'], {thr: open});
  }
  if (c.preSit === 'limped'){
    const iso = OPEN[key] * 0.65, limpers = S.players.filter(x => x.i !== S.bbIdx && !x.folded && !x.out && x.bet >= S.bb && !x.isHuman).length;
    if (c.pct <= iso) return rec('raise', [handLine, 'Someone just called instead of raising. That usually means okay cards, not great ones.', 'Your hand is good enough to raise and take control.'], {size: bb * (3 + limpers), thr: iso});
    if (c.toCall === 0) return rec('check', ['Nobody raised, so check. Seeing the flop is free.'], {thr: iso});
    if (c.pct <= OPEN[key] * 1.1 && ['btn', 'co', 'sb'].includes(key)) return rec('call', [handLine, 'Calling is cheap here, and this hand can turn into something strong.'], {thr: OPEN[key] * 1.1});
    return rec('fold', [handLine, 'Too weak to play, even when it is cheap.'], {thr: iso});
  }
  if (c.preSit === 'raise'){
    const raiseBB = c.currentBet / bb, sizeF = Math.min(1, 3.2 / Math.max(2, raiseBB));
    const tb = clamp(Rtop * 0.2, 0.025, 0.12), cw = clamp(Rtop * (key === 'bb' ? 0.9 : c.ip ? 0.55 : 0.4) * sizeF, 0.02, 0.45);
    const rLine = `${who} raised. ${raiserRead ? raiserRead + ' ' : ''}Players who raise like this usually have ${esc(rangeText(Rtop))}.`;
    if (c.pct <= tb) return rec('raise', [handLine, rLine, 'Your hand is better than most of those. Raise again.'], {size: c.currentBet * (c.ip ? 3 : 3.5), thr: tb});
    if (c.pct <= tb + cw) return rec('call', [handLine, rLine, `Good enough to call${key === 'bb' ? ', especially since you already paid the big blind' : ''}, but not to raise again.`], {thr: tb + cw});
    return rec('fold', [handLine, rLine, 'Your hand usually loses to those cards. Fold and wait for a better one.'], {thr: tb + cw});
  }
  const four = clamp(Rtop * 0.3, 0.01, 0.04), cont = clamp(Rtop * 0.6, 0.02, 0.1);
  const rLine = 'There was a raise and then another raise. That usually means very strong cards.';
  if (c.pct <= four) return rec('raise', [handLine, rLine, 'Yours is one of the very best hands. Raise again or go all-in.'], {size: c.currentBet * 2.3, thr: four});
  if (c.pct <= four + cont) return rec('call', [handLine, rLine, 'Your hand is strong enough to call.'], {thr: four + cont});
  return rec('fold', [handLine, rLine, 'Your hand is not strong enough. Fold.'], {thr: four + cont});
}
function coachPost(c){
  const ks = c.k === 1 ? knownStyle(c.main) : null, o = c.main;
  let valueTh = c.parts ? Math.max(1 / (c.k + 1) + 0.08, 0.3) : clamp(1.6 / (c.k + 1), 0.36, 0.6);
  if (ks && ks.clueless) valueTh -= 0.08;
  const strongTh = c.parts ? 1 / (c.k + 1) + 0.2 : Math.max(valueTh + 0.16, 0.66 - (c.k - 1) * 0.08);
  const draw = c.draw.fd || c.draw.sd === 'oesd';
  const pw = pairWords(c.hole, c.board, c.made);
  // What you have
  const have = [`${c.parts ? esc(c.holdLabel) + ', best 2 cards: ' : ''}<b>${esc(c.made ? c.made.name : '')}</b>${pw ? ` (${esc(pw)})` : c.made && !c.made.improves && c.made.cat > 0 ? ' (but that is from the cards on the table, so everyone shares it)' : ''}.`];
  // What you could make
  const could = [];
  const im = improveInfo(c.hole, c.board);
  if (im && im.outs){
    could.push(...im.list.map(esc));
    could.push(`Next card: about <b>${pc(im.next)}</b> to improve${im.byRiver != null ? `. By the river: about <b>${pc(im.byRiver)}</b>` : ''}.`);
  } else if (im) could.push('No cards make your hand clearly better from here. Your hand needs to be good already.');
  else could.push('This is the last card: no more cards to come.');
  // What they could have
  const they = [];
  if (o){
    they.push(...oppLines(o, c).map(esc));
    if (c.parts){
      they.push(`Everyone holds ${c.nDeal} cards and can use any 2 of them for poker, so straights, flushes and full houses are much more common than in normal poker.`);
      if (c.threat && c.threat.behind >= 0.05) they.push(`Right now, about <b>${pc(c.threat.behind)}</b> of the time someone already beats your poker part${c.threat.top.length ? ` (${c.threat.top.map(([k, n]) => `${k} ${pc(n)}`).join(', ')})` : ''}.`);
      const paired = new Set(c.board.map(cr)).size < c.board.length;
      const inNow = new Set(S.ev.filter(e => e.st === S.street && (e.t === 'bet' || e.t === 'raise' || e.t === 'call') && e.p !== heroP()).map(e => e.p)).size;
      if (paired && c.made && c.made.cat >= 4 && c.made.cat <= 5) they.push(`The table is paired, so a full house beats your ${c.made.cat === 4 ? 'straight' : 'flush'}. Anyone holding a ${[...new Set(c.board.map(cr))].filter(r => c.board.filter(x => cr(x) === r).length >= 2).map(r => RNAME[r]).join(' or ')} plus another table card has one.`);
      if (inNow >= 2 && S.ev.some(e => e.st === S.street && e.t === 'raise' && e.p !== heroP() && e.to > 0 && S.ev.some(x => x.st === S.street && x.t === 'bet' && x.p !== e.p))) they.push(`${inNow} players are putting money in on this card, with a raise. That much action usually means at least one very strong hand.`);
    }
    if (c.parts && c.nParts === 3 && c.locked === 1) they.push(`Your ${esc(c.lockedLabel)} part cannot be beaten, but in this game you need 2 of the 3 parts to take the pot. If one player wins both other parts, they take everything; if two different players win them, the pot is split in three.`);
    const t = c.parts ? null : threatInfo(c.hole, c.board, o);
    if (t){
      they.push(`Of the hands ${esc(o.name)} would play like this: about <b>${pc(t.ahead)}</b> beat you right now${t.top.length ? ' (' + esc(t.top.join(', ')) + ')' : ''}${t.draw >= 0.05 ? `, about ${pc(t.draw)} are draws that could pass you` : ''}, and about ${pc(Math.max(0, t.behind))} are behind you.`);
    }
    if (c.k > 1) they.push(`${c.k - 1} other player${c.k > 2 ? 's are' : ' is'} still in too, so the chance someone beats you is higher.`);
  }
  // Decision
  const extra = {thr: 0, strongTh, valueTh};
  const sections = [{h: 'What you have', items: have}, {h: 'What you could make', items: could}, {h: 'What they could have', items: they}, {h: 'The table', items: boardTexture(c.board).map(esc)}];
  if (c.parts){ sections.splice(1, 0, {h: 'Ways to split (your choice)', items: partLines(c)}); if (could.length && im) could[0] = esc(c.holdLabel) + ', best 2 cards: ' + could[0]; }
  const decide = (act, items, x) => { const r = rec(act, have.concat(could, they, items), Object.assign(extra, x || {})); r.sections = sections.concat({h: 'Decision', items}); return r; };
  // a part nobody can beat: some of this pot is already yours, so more money in the pot pays you
  if (c.parts && c.locked >= 1 && (c.nParts === 2 || c.locked >= 2)){
    const whole = c.locked * 2 > c.nParts;
    const lockLine = whole && c.nParts === 3 ? 'Two of your parts cannot be beaten, so this whole pot is yours.' : `Your ${esc(c.lockedLabel)} part cannot be beaten (it is the best possible hand), so at least half of this pot is already yours. Every dollar that goes in, at least half comes back to you.`;
    const why = whole && c.nParts === 3 ? 'Get as much money in as you can.' : c.k >= 2 ? `With ${c.k} other players still in, each dollar you add can bring in ${c.k} more, so you make money even if you lose the other half. Raise big, even all-in.` : 'Against one player you cannot lose money by raising: at worst you split, and if you also win the other part you take everything. Raise.';
    if (c.toCall === 0) return decide('bet', [eqLine(c, 'Your chance to win'), lockLine, why], {size: MONEY ? Math.max(100, c.pot * 0.75) : c.pot * 0.75, thr: 0, locked: true});
    return decide('raise', [priceLine(c), lockLine, why], {size: c.k >= 2 ? c.o.maxTo : Math.max(c.currentBet * 2.5, c.pot * 0.75), thr: 0, locked: true});
  }
  if (c.toCall === 0){
    const ch = eqLine(c, 'Your chance to win');
    if (c.eq >= valueTh){
      const vs = ks && ks.clueless ? `Venky calls with almost anything, so bet bigger than usual (about ${fmt(MONEY ? 100 : roundChips(c.pot * 0.75))}).` : MONEY ? (c.eq >= strongTh ? 'You are well ahead. Bet what they will still call: at your table that is about 50¢–$1.' : 'You are probably ahead. Bet about 30–50¢: medium hands at your table still call that, but fold to $1.') : 'You are probably ahead. Bet about half the pot so worse hands pay you.';
      return decide('bet', [ch, vs], {size: ks && ks.clueless ? (MONEY ? 100 : c.pot * 0.75) : MONEY ? clamp(c.pot * 0.5, 30, c.eq >= strongTh ? 150 : 60) : c.pot * 0.6, thr: valueTh});
    }
    const folder = ks && (ks.bigFold || ks.label === 'Cautious' || ks.label === 'Rock');
    if (folder && c.k === 1 && o.rg.agg === 0) return decide('bet', [ch, `Good bluff spot: ${esc(o.name)} has not bet and gives up easily. Bet about ${fmt(MONEY ? 60 : roundChips(c.pot * 0.5))}; if they call or raise, slow down.`], {alt: 'check', size: MONEY ? 60 : c.pot * 0.5, thr: valueTh, bluffSpot: true});
    if (draw && c.k <= 2 && !(ks && ks.clueless)) return decide('bet', [ch, 'You can bet to try to win now, or check and see the next card. Both are fine.'], {alt: 'check', size: MONEY ? 40 : c.pot * 0.5, thr: valueTh});
    return decide('check', [ch, `Not strong enough to bet. Check.${ks && ks.clueless ? ' Bluffing Venky does not work.' : c.k > 1 ? ' With several players in, someone usually has something.' : ''}`], {thr: valueTh});
  }
  const imp = draw && c.st < 3 ? 0.06 : 0;
  const nameEnd = o ? ` against ${esc(o.name)}` : '';
  const dec = [priceLine(c), eqLine(c, 'Your chance to win against those hands')];
  if (c.eq >= strongTh) return decide('raise', dec.concat(`You are well ahead${nameEnd}. Raise to win more.`), {size: MONEY ? c.currentBet * 2.5 : c.currentBet * 2.8, thr: strongTh});
  const bar = homeBar(c);
  if (bar && c.eq < bar) return decide('fold', dec.concat(`${fmt(c.toCall)} is a lot of money at your table: people put in this much only with strong hands. The price looks okay, but you need a strong hand here, not just a cheap price. Fold.`), {thr: bar, homeMoney: true});
  if (c.eq + imp >= c.need) return decide('call', dec.concat(imp && c.eq < c.need ? 'Close, but if you hit your card you can win a big pot. Call.' : `That is enough. Call${nameEnd}.`), {thr: c.need});
  return decide('fold', dec.concat(`That is not enough. Fold${nameEnd}.`), {thr: c.need});
}
// At the home game $1 is big money: a call that size needs a strong hand, whatever the pot odds say
// The coach already reads a big bet as a strong hand, so this is only a safety margin on top of the price,
// plus, against 3 or more players all putting money in: don't call $1+ with less than about a fair share.
function homeBar(c){ if (!MONEY || c.toCall < 100) return 0; return Math.max(c.need + (c.toCall >= 200 ? 0.08 : 0.05), c.k >= 3 ? 0.9 / (c.k + 1) : 0); }
function preThey(c){
  const p = heroP(), others = liveList().filter(x => x !== p);
  const callers = S.ev.filter(e => e.st === 0 && e.t === 'call' && e.p !== p).map(e => e.p);
  const out = [];
  if (c.raiser && c.raiser !== p) out.push(`${c.raiser.name} raised: ${rangeText(c.raiser.rg.top)} is typical for that.`);
  if (callers.length) out.push(`${[...new Set(callers.map(x => x.name))].join(', ')} just called. ${MONEY ? 'At your table people call with lots of hands, so they could have almost anything.' : 'Calling usually means a medium hand, not strong enough to raise.'}`);
  if (!c.raiser && !callers.length) out.push('Nobody has done anything yet, so you know nothing about their cards.');
  out.push(`${others.length} other player${others.length === 1 ? ' is' : 's are'} in the hand. The more players, the more likely someone has a strong hand.`);
  return out;
}
// when raising is impossible (everyone else is all-in), the advice is simply call
const coachRec = c => {
  const r = coachRec0(c);
  if ((r.act === 'raise' || r.act === 'bet' || r.act === 'allin') && c.o && !c.o.canRaise){
    const ai = liveList().filter(x => !x.isHuman && x.allIn).map(x => x.name);
    const note = ai.length ? `${ai.join(' & ')} ${ai.length > 1 ? 'are' : 'is'} all-in, so raising is not possible: extra chips could not be called. Just call.` : 'Raising is not possible here, so just call.';
    r.act = c.toCall > 0 ? 'call' : 'check'; r.size = 0; r.lines = r.lines.concat(note); r.why += ' ' + note;
    if (r.sections){ const d = r.sections[r.sections.length - 1]; d.items = d.items.concat(esc(note)); }
  }
  return r;
};
const coachRec0 = c => {
  if (c.st > 0) return coachPost(c);
  const r = coachPre(c);
  const [first, ...rest] = r.lines;
  const startsWithHand = /^Your cards:/.test(strip(first || ''));
  r.sections = [
    {h: 'What you have', items: [startsWithHand ? first : `${esc(c.hn)}. That is a ${lightHTML(lightOf(c))}.`]},
    {h: 'What you could make', items: prePotential(c.hole).map((x, i) => i === 0 && c.parts ? `${esc(c.holdLabel)}, best 2 cards: ${x}` : x)},
    {h: 'What they could have', items: preThey(c).map(esc)},
    {h: 'Decision', items: startsWithHand ? rest : r.lines}
  ];
  if (c.parts){
    r.sections.splice(1, 0, {h: 'Ways to split (your choice)', items: partLines(c)});
    r.sections[r.sections.length - 1].items.unshift(eqLine(c, 'Your chance to win'));
  }
  return r;
};
function actWords(a, c){
  const all = a.type === 'raise' && a.to >= c.o.maxTo;
  if (a.type === 'fold') return 'folded';
  if (a.type === 'check') return 'checked';
  if (a.type === 'call') return `called ${fmt(a.amt || c.toCall)}`;
  if (all) return `went all-in for ${fmt(a.to)}`;
  return a.kind === 'bet' ? `bet ${fmt(a.to)}` : `raised to ${fmt(a.to)}`;
}
function recWords(r, c){
  if (r.act === 'allin' || ((r.act === 'raise' || r.act === 'bet') && r.size && roundChips(r.size) >= c.o.maxTo)) return 'go all-in';
  if (r.act === 'raise') return c.currentBet === 0 ? `bet about ${fmt(roundChips(r.size))}` : `raise to about ${fmt(roundChips(r.size))}`;
  if (r.act === 'bet') return `bet about ${fmt(roundChips(r.size))}`;
  return r.act;
}
function gradeDecision(c, a, r){
  const all = a.type === 'raise' && a.to >= c.o.maxTo;
  const act = a.type === 'raise' ? (all ? 'allin' : (c.currentBet === 0 && c.st > 0 ? 'bet' : 'raise')) : a.type;
  const agg = x => x === 'raise' || x === 'allin' || x === 'bet';
  const g = (grade, cat, text, better) => ({grade, cat, text, better});
  const callEv = c.eq * (c.pot + c.toCall) - c.toCall;
  const L = lightOf(c);
  if (c.st === 0){
    if (r.eqMode){
      if (act === 'fold') return c.eq > c.need + 0.06 ? g('mistake', 'overfold', `You folded, but you win about ${pc(c.eq)} and only needed ${pc(c.need)}. Calling was better.`, 'call') : g('good', null, 'Right fold. The price was too high for your chances.');
      if (c.eq < c.need - 0.05) return g(c.eq < c.need - 0.15 ? 'blunder' : 'mistake', 'call_no_odds', `Too expensive. You needed to win ${pc(c.need)} of the time but only win about ${pc(c.eq)}.`, 'fold');
      return g('good', null, 'Good call. Your chance to win was worth the price.');
    }
    if (act === r.act || (agg(act) && agg(r.act))) return g(c.pct <= 0.05 && agg(act) ? 'great' : 'good', null, act === 'fold' ? 'Good fold. This hand was not worth playing here.' : 'Good. This is what a strong player does here.');
    if (act === 'fold'){
      if (r.act === 'check') return g('mistake', 'free_fold', 'You folded when you could check for free. Always check when it costs nothing.', 'check');
      const ratio = c.pct / Math.max(0.01, r.thr);
      return ratio < 0.55 ? g('mistake', 'tight_pre', `${c.hn} is a good hand here. Folding it throws away a good chance.`, recWords(r, c)) : g('fine', 'tight_pre', `${c.hn} was a close call. Folding is okay.`, recWords(r, c));
    }
    if (act === 'check' && agg(r.act)) return g('fine', 'passive', `${c.hn} is strong. Raise to win more chips.`, recWords(r, c));
    if ((act === 'call' || agg(act)) && (r.act === 'fold' || r.act === 'check')){
      const ratio = c.pct / Math.max(0.01, r.thr);
      if (r.act === 'check' && act === 'call') return g('good', null, 'Fine.');
      if (ratio > 2.2) return g(act === 'allin' && ratio > 3 ? 'blunder' : 'mistake', 'loose_pre', `${c.hn} is a ${L.w} hand. From this seat it is too weak to play.`, r.act);
      return g('fine', 'loose_pre', `${c.hn} is a bit weak to play from this seat. Not a big deal.`, r.act);
    }
    if (act === 'call' && agg(r.act)) return c.preSit === 'unopened' ? g('fine', 'limp', `You only called the big blind with ${c.hn}. Raising is better: it can win the pot right away.`, recWords(r, c)) : g('fine', 'passive', `${c.hn} is strong enough to raise again.`, recWords(r, c));
    if (agg(act) && r.act === 'call') return g('fine', null, `Raising with ${c.hn} is a bit much here. Calling is the usual play.`, 'call');
    return g('fine', null, 'A reasonable choice.');
  }
  const draw = c.draw.fd || c.draw.sd === 'oesd';
  if (c.toCall > 0){
    if (act === 'fold'){
      if (homeBar(c) && c.eq < homeBar(c)) return g('good', null, `Good fold. ${fmt(c.toCall)} is big money at your table, and your hand was not strong enough for it.`);
      if (c.eq >= c.need + 0.08) return g(callEv > c.pot * 0.3 && c.eq > 0.6 ? 'blunder' : 'mistake', 'overfold', `You folded, but you needed to win ${pc(c.need)} and had about ${pc(c.eq)}. Calling was better.`, r.act === 'raise' ? recWords(r, c) : 'call');
      if (c.eq >= c.need - 0.02) return g('fine', null, `Close decision. You needed ${pc(c.need)} and had about ${pc(c.eq)}. Folding is fine.`);
      return g('good', null, `Good fold. You needed ${pc(c.need)} and had only about ${pc(c.eq)}.`);
    }
    if (r.locked && agg(act)) return g('great', null, 'Great raise. One part could not be beaten, so part of the pot was already yours: every chip that went in paid you back at least half.');
    if (r.locked && act === 'call') return g('fine', 'passive', 'Calling wins, but raising wins more: one part could not be beaten, so every extra chip in the pot pays you back at least half.', recWords(r, c));
    if (act === 'call'){
      if (c.eq < c.need - 0.1 && !(draw && c.st < 3 && c.eq >= c.need - 0.16)) return g(-callEv > c.stack * 0.25 ? 'blunder' : 'mistake', 'call_no_odds', `Too expensive. You needed ${pc(c.need)} and had only about ${pc(c.eq)}.`, 'fold');
      if (r.act === 'raise') return g('fine', 'passive', `You were ahead (about ${pc(c.eq)} to win). Raising would win more.`, recWords(r, c));
      if (homeBar(c) && c.eq < homeBar(c)) return g('fine', null, `Risky call. ${fmt(c.toCall)} is big money at your table, and people bet like this with strong hands. You had about ${pc(c.eq)}.`, 'fold');
      if (c.eq < c.need) return g('fine', null, `A close call. You needed ${pc(c.need)} and had about ${pc(c.eq)}${draw && c.st < 3 ? ', but your draw can win a bigger pot later' : ''}. Folding was fine too.`);
      return g('good', null, `Good call. You needed ${pc(c.need)} and had about ${pc(c.eq)}.`);
    }
    if (c.eq >= r.strongTh - 0.05) return g('great', null, `Strong raise. You were well ahead (about ${pc(c.eq)} to win).`);
    if (draw && c.st < 3) return g(c.k === 1 ? 'good' : 'fine', null, 'Good: you raised with a draw. You can win now, or hit your card later.');
    if (c.parts && c.eq >= 1 / (c.k + 1) - 0.03 && c.eq <= 1 / (c.k + 1) + 0.03) return g('fine', null, `About a fair share: you expected about ${pc(c.eq)} of the pot, and a fair share with ${c.k + 1} players is ${pc(1 / (c.k + 1))}, so raising neither wins nor loses much here.`);
    if (c.parts && c.eq > 1 / (c.k + 1) + 0.03) return g('good', null, `A value raise. You expected about ${pc(c.eq)} of the pot, more than a fair share (${pc(1 / (c.k + 1))} with ${c.k + 1} players), so more money in the pot helps you.`);
    if (act === 'allin' && c.eq < 0.45) return g('mistake', 'risky_allin', `You bet all your chips with only about ${pc(c.eq)} to win. Too risky.`, r.act === 'fold' ? 'fold' : r.act);
    return c.k === 1 ? g('fine', null, 'A bluff. It can work against one player, but do it rarely.') : g('mistake', 'bluff_multi', 'Bluffing against several players rarely works. Someone usually has something.', recWords(r, c));
  }
  if (act === 'fold') return g('mistake', 'free_fold', 'You folded when you could check for free. Always check when it costs nothing.', 'check');
  const betSize = a.to || 0;
  if (r.locked && agg(act)) return g('great', null, 'Great bet. One part could not be beaten, so every chip that goes in pays you back at least half.');
  if (act === 'check'){
    if (r.locked) return g('mistake', 'missed_value', 'One part could not be beaten, so part of the pot was already yours. Betting would have made the others pay more into it.', recWords(r, c));
    if (c.eq >= r.strongTh && c.st === 3) return g('mistake', 'missed_value', `You had a strong hand (about ${pc(c.eq)} to win). Betting would have won more.`, recWords(r, c));
    if (c.eq >= r.valueTh + 0.05) return g('fine', 'missed_value', `You were probably ahead (about ${pc(c.eq)}). A bet usually wins more.`, recWords(r, c));
    return g('good', null, 'Checking was fine.');
  }
  if (c.eq >= r.valueTh){
    // judge the size against what the coach itself suggested; at the home game $1 is already a big bet
    const recSize = r.size && (r.act === 'bet' || r.act === 'raise') ? Math.min(roundChips(r.size), c.o.maxTo) : 0;
    const bigEnough = (recSize && betSize >= recSize * 0.8) || (MONEY && betSize >= 100);
    if (!bigEnough && betSize < c.pot * 0.25) return g('fine', 'sizing_small', MONEY ? `Good hand to bet, but the bet was small. About ${fmt(recSize || 60)} gets more from the hands that call.` : 'Good hand to bet, but the bet was small. Bet about half the pot.', recWords(r, c));
    if (act === 'allin' && betSize > c.pot * 2 && c.eq < r.strongTh) return g('fine', 'risky_allin', 'Betting was right, but all-in was too much for this hand.', recWords(r, c));
    return g(c.eq >= r.strongTh ? 'great' : 'good', null, `Good bet. You were probably ahead (about ${pc(c.eq)} to win).`);
  }
  if (draw && c.st < 3) return g('good', null, 'Good: you bet with a draw. You can win now, or hit your card later.');
  if (c.parts && c.eq > 1 / (c.k + 1) + 0.03) return g('good', null, `A value bet. You expected about ${pc(c.eq)} of the pot, more than a fair share (${pc(1 / (c.k + 1))}).`);
  if (r.bluffSpot) return g('good', null, `Good bluff spot: ${c.mainName} gives up easily when they have nothing.`);
  if (c.k >= 3) return g('mistake', 'bluff_multi', `You bluffed against ${c.k} players. Someone usually calls.`, 'check');
  if (act === 'allin' && c.eq < 0.4) return g('mistake', 'risky_allin', 'Bluffing with all your chips is too risky.', 'check');
  return g('fine', null, 'A bluff. Fine sometimes, mostly against one player.');
}
const orderTip = () => 'Most players put their stronger 3 Patti 1st. Putting your strong one 2nd can beat their weaker one, but then your weak one meets their strong one.' + (S && liveList().some(p => p.type === 'krish') ? ' Krish usually puts his stronger 3 Patti 2nd, but he switches sometimes, so you cannot count on it.' : '');
function partLabelName(kind, h){ return kind === 'hold' ? partName('hold', h) : kind === 'b2' ? describe(evaluate(h.concat(S.board2.slice(0, S.boardVis2)))) : partName(kind, h); }

// used by the UI layer
export {
  CONCEPTS, GRADE_LABEL, GRADE_SCORE, HOME_BUY, HOME_FRIENDS, LESSONS, LEVELS, LOGR, PCT, RANKCH,
  SEATSHORT, SUITCLS, SUITS, TYPES, VAR, VARIANTS, VAR_ORDER, actWords, cardTxt, catOf,
  clamp, coachContext, coachRec, cr, cs, describe, drawInfo, esc, evaluate, fmt,
  gradeDecision, handPct, heroP, holeName, icards, lg, liveList, madeInfo, nm, num,
  oppDist, options, partLabelName, partName, pc, pick, planSplit, posInfo, potTotal, rnd,
  roundChips, splitHintLines, splitKey, splitValue, useSplit, vsOne,
};
