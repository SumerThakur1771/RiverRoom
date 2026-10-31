// Golden-trace recorder: plays seeded sessions of the ORIGINAL game (legacy/river-room.html)
// in headless Chromium and saves every hand's history log, coach grades and final stacks.
// The TypeScript port must reproduce these traces exactly (see test/golden.test.ts).
//
// How determinism works (the same scheme is implemented in src/engine/rng.ts):
//  - Math.random is replaced by a seeded generator (mulberry32).
//  - Each random "segment" of the game gets its own stream, seeded by hash(seed + '|' + label):
//      setup, h<N>:start, h<N>:deck, h<N>:variant, h<N>:plans, h<N>:ai:<k>, h<N>:coach:<k>,
//      h<N>:rec:<k>, h<N>:allin:<k>, h<N>:final, h<N>:reveal, h<N>:mood,
//      b2tab:<cards>, h5tab, opp:<variant>
//    so cosmetic randomness (chat lines, sounds) can never shift a card or a decision.
//  - The deck uses the stream instead of crypto.getRandomValues.
//  - The hero is played by a fixed policy keyed on hash(seed + '|' + h<N>:hero:<k>).
//
// Usage: node tools/golden/record.mjs [--check]   (--check records twice and compares)
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'test', 'golden');
const CHECK = process.argv.includes('--check');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

export const SESSIONS = [
  { id: 'home-holdem', mode: 'home', force: 'holdem', hands: 40 },
  { id: 'home-std', mode: 'home', force: 'std', hands: 40 },
  { id: 'home-two', mode: 'home', force: 'two', hands: 40 },
  { id: 'home-k8', mode: 'home', force: 'k8', hands: 30 },
  { id: 'home-n7', mode: 'home', force: 'n7', hands: 40 },
  { id: 'home-dealer', mode: 'home', force: null, hands: 40 },
  { id: 'tourney-a', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-b', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-c', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-d', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-e', mode: 'tourney', force: null, hands: 60 },
  { id: 'tourney-f', mode: 'tourney', force: null, hands: 60 },
];

let s = readFileSync(join(ROOT, 'legacy', 'river-room.html'), 'utf8');
function r(a, b) { if (s.split(a).length !== 2) throw new Error('anchor not unique: ' + a.slice(0, 80)); s = s.replace(a, b); }
// Wrap a top-level function so its synchronous body runs on its own named stream.
function seg(name, labelExpr) {
  const m = s.match(new RegExp('\\n(async )?function ' + name + '\\('));
  if (!m) throw new Error('function not found: ' + name);
  r(m[0], `\nfunction ${name}(...a){ return __with(${labelExpr}, () => __${name}.apply(this, a)); }\n${m[1] || ''}function __${name}(`);
}

// the artifact host normally provides this skeleton (see ANALYSIS.md section 1)
s = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>' + s + '</body></html>';

r("(() => {\n'use strict';\n", `(() => {
'use strict';
const __h = str => { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const __mb = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const __stack = []; let __cur = __mb(__h('ui'));
Math.random = () => __cur();
const __with = (label, fn) => { __stack.push(__cur); __cur = __mb(__h(window.__seed + '|' + label)); try { return fn(); } finally { __cur = __stack.pop(); } };
let __hn = -1, __cnt = {};
const __lab = name => { if (S.handNo !== __hn){ __hn = S.handNo; __cnt = {}; } const k = __cnt[name] = (__cnt[name] === undefined ? -1 : __cnt[name]) + 1; return 'h' + S.handNo + ':' + name + ':' + k; };
`);
// speed: timers only, no CPU work removed
r('const PACE = {learn: 1, normal: 0.55, fast: 0.3};', 'const PACE = {learn: 1, normal: 0.55, fast: 0.001};');
r('  const d = REDUCED ? 40 : dur * Math.min(1, SPEED() * 0.8 + 0.35);', '  const d = 1;');
r('let S = null, GID = 0,', 'let S = null, GID = 0; window.__rr = () => S; let __x,');
// deck from the seeded stream instead of crypto
r('  try { crypto.getRandomValues(r); } catch (e) {', '  try { throw 0; } catch (e) {');
// lazily built random tables get their own streams, so it does not matter who builds them first
r('  if (!H5_TAB){ const a = new Float64Array(30000); for (let i = 0; i < a.length; i++) a[i] = evaluate(randCards(5)); H5_TAB = a.sort(); }',
  "  if (!H5_TAB) H5_TAB = __with('h5tab', () => { const a = new Float64Array(30000); for (let i = 0; i < a.length; i++) a[i] = evaluate(randCards(5)); return a.sort(); });");
r('  if (!t){ const dead = new Set(vis2), a = new Float64Array(3000); for (let i = 0; i < a.length; i++) a[i] = evaluate(randCards(3, dead).concat(vis2)); t = a.sort(); BTAB.set(key, t); }',
  "  if (!t){ t = __with('b2tab:' + key, () => { const dead = new Set(vis2), a = new Float64Array(3000); for (let i = 0; i < a.length; i++) a[i] = evaluate(randCards(3, dead).concat(vis2)); return a.sort(); }); BTAB.set(key, t); }");
r('function oppDist(key){\n  if (OPPD[key]) return OPPD[key];\n', "function oppDist(key){\n  if (OPPD[key]) return OPPD[key];\n  return __with('opp:' + key, () => __oppDist(key));\n}\nfunction __oppDist(key){\n");
// patch function bodies before seg() renames them
r('function pickVariant(d){\n', "function pickVariant(d){\n  if (window.__force) return Promise.resolve(window.__force);\n  if (window.__auto && d.isHuman && MONEY && settings.games !== 'holdem') return Promise.resolve(VAR_ORDER[S.handNo % VAR_ORDER.length]);\n");
seg('setupTable', "'setup'");
seg('playHand', "'h' + (S.handNo + 1) + ':start'");
seg('shuffled', "'h' + S.handNo + ':deck'");
seg('pickVariant', "'h' + S.handNo + ':variant'");
seg('initPlans', "'h' + S.handNo + ':plans'");
seg('aiAction', "__lab('ai')");
seg('coachContext', "__lab('coach')");
seg('updateAllInEquity', "__lab('allin')");
seg('finalSplits', "'h' + S.handNo + ':final'");
seg('revealEveryone', "'h' + S.handNo + ':reveal'");
seg('moodAndChat', "'h' + S.handNo + ':mood'");
r('const coachRec = c => {', "const coachRec = c => __with(__lab('rec'), () => __coachRec(c));\nconst __coachRec = c => {");
// automatic hero and dealer choices
r("  setupTable(null); $('#startOv').hidden = true; runLoop();", "  setupTable(null); window.__setup = S.players.map(p => ({name: p.name, seat: p.seat, type: p.type, stack: p.stack, persona: p.persona})); $('#startOv').hidden = true; runLoop();");
r('function humanAction(p, ctx){\n', `function __heroPolicy(p){
  const o = options(p), u = __h(window.__seed + '|' + __lab('hero')) % 100;
  if (u < 12) return o.toCall > 0 ? {type: 'fold'} : {type: 'check'};
  if (u < 62 || !o.canRaise) return o.toCall > 0 ? {type: 'call'} : {type: 'check'};
  if (u < 82) return {type: 'raise', to: o.minTo};
  if (u < 94) return {type: 'raise', to: Math.min(o.maxTo, Math.max(o.minTo, roundChips(S.currentBet + potTotal() * 0.75)))};
  return {type: 'raise', to: o.maxTo};
}
function humanAction(p, ctx){
  if (window.__auto) return Promise.resolve(__heroPolicy(p));
`);
r('function heroSplit(p, k, mode){\n', "function heroSplit(p, k, mode){\n  if (window.__auto && mode === 'final') return Promise.resolve(planSplit(p, k));\n");
r('function askRebuy(){\n', "function askRebuy(){\n  if (window.__auto) return Promise.resolve('yes');\n");
r('      await playHand();\n      if (checkEnd()) return;', '      if (window.__stopAt && S.handNo >= window.__stopAt){ window.__done = true; return; }\n      await playHand();\n      if (checkEnd()){ window.__done = true; return; }');
r("} catch (e) { if (!(e instanceof Abort)){ console.error(e);", "} catch (e) { if (!(e instanceof Abort)){ window.__crash = String(e && e.stack); console.error(e);");
// engine inputs for exact replay: the deck, every action as submitted, the final splits
r('  S.deck = shuffled();\n', '  S.deck = shuffled(); window.__deck = S.deck.slice(); window.__acts = []; window.__splits = null;\n');
r('async function applyAction(p, a){\n', 'async function applyAction(p, a){\n  if (window.__acts) window.__acts.push({i: p.i, type: a.type, to: a.to == null ? null : a.to});\n');
r('await finalSplits(); guard(gid); await showdownMulti();', 'await finalSplits(); guard(gid); window.__splits = S.players.map(p => p.splitDone ? p.parts.map(x => x.slice()) : null); await showdownMulti();');
// per-hand trace record (chat lines are cosmetic and excluded)
r('  if (S.history.length > 80) S.history.length = 80;\n', `  if (window.__trace) window.__trace.push({hand: S.handNo, variant: S.variant || 'holdem', button: S.button, deck: window.__deck, acts: window.__acts, splits: window.__splits,
    lines: S.hist.filter(l => !/^[^:]* said, "/.test(l)),
    dec: S.dec.map(d => ({st: d.ctx.st, eq: d.ctx.eq, need: d.ctx.need, act: d.act.type, to: d.act.to || 0, rec: d.rec.act, size: d.rec.size == null ? null : d.rec.size, grade: d.g ? d.g.grade : null})),
    split: S.splitDec ? {grade: S.splitDec.g.grade, loss: S.splitDec.loss} : null});
  if (S.history.length > 80) S.history.length = 80;
`);
r('  for (const p of S.players) Object.assign(p, {cards: [], all: [], extra: null, parts: null, splitDone: false,',
  `  if (window.__trace && window.__trace.length) window.__trace[window.__trace.length - 1].after = S.players.map(p => ({name: p.name, stack: p.stack, out: p.out, place: p.place, buyins: p.buyins, tilt: p.tilt}));
  for (const p of S.players) Object.assign(p, {cards: [], all: [], extra: null, parts: null, splitDone: false,`);

const dir = mkdtempSync(join(tmpdir(), 'rr-golden-'));
const page = join(dir, 'recorder.html');
writeFileSync(page, s);

async function runSession(browser, cfg) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const seed = 'golden-' + cfg.id;
  await ctx.addInitScript(({ seed, cfg }) => {
    localStorage.setItem('river-room-v2', JSON.stringify({ mode: cfg.mode, games: 'dealer', pace: 'fast', review: 'off', sound: false, timer: 0, holdResult: false, revealAll: true, hints: true, showEq: false, opp: 5, stack: 1500, perLevel: 10 }));
    Object.assign(window, { __seed: seed, __auto: true, __force: cfg.force, __stopAt: cfg.hands, __trace: [] });
  }, { seed, cfg });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
  await pg.goto('file://' + page);
  await pg.click('#startBtn');
  const setup = await pg.evaluate(() => window.__setup);
  const t0 = Date.now();
  await pg.waitForFunction(() => window.__done || window.__crash, null, { timeout: 20 * 60 * 1000, polling: 200 });
  const res = await pg.evaluate(() => ({ trace: window.__trace, crash: window.__crash || null, tableNo: window.__rr().tableNo }));
  await ctx.close();
  return { id: cfg.id, seed, config: cfg, tableNo: res.tableNo, setup, hands: res.trace, crash: res.crash, errors, ms: Date.now() - t0 };
}

const browser = await chromium.launch();
mkdirSync(OUT, { recursive: true });
let failed = false;
const results = await Promise.all(SESSIONS.filter(c => !ONLY.length || ONLY.includes(c.id)).map(async cfg => {
  const a = await runSession(browser, cfg);
  let same = null;
  if (CHECK) { const b = await runSession(browser, cfg); same = JSON.stringify(a.hands) === JSON.stringify(b.hands) && JSON.stringify(a.setup) === JSON.stringify(b.setup);
    if (!same) { const d = join(ROOT, 'tools', 'golden', '.diff'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, cfg.id + '.a.json'), JSON.stringify(a, null, 1)); writeFileSync(join(d, cfg.id + '.b.json'), JSON.stringify(b, null, 1)); } }
  return { a, same };
}));
await browser.close();
for (const { a, same } of results) {
  const { errors, ms, ...rest } = a;
  writeFileSync(join(OUT, a.id + '.json'), JSON.stringify(rest) + '\n');
  const lines = a.hands.reduce((n, h) => n + h.lines.length, 0);
  console.log(`${a.id.padEnd(12)} hands=${String(a.hands.length).padStart(3)} lines=${String(lines).padStart(5)} ${(ms / 1000).toFixed(0)}s` +
    (a.crash ? ' CRASH ' + a.crash.split('\n')[0] : '') + (errors.length ? ` errors=${errors.length}: ${errors[0]}` : '') + (same === null ? '' : same ? ' deterministic=yes' : ' deterministic=NO'));
  if (a.crash || errors.length || same === false) failed = true;
}
process.exit(failed ? 1 : 0);
