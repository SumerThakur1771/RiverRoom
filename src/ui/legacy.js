// River Room UI: the original game's screens and animations, driven by the TypeScript engine
// (src/engine) and bots (src/ai). The engine owns the rules and the game state; this file
// renders that state and animates the engine's steps (see playHand below). The coach and the
// shared helpers live in src/coach/coach.js. Typing this file is planned work (plain JS for now).
import * as B from '../ai/bots';
import * as E from '../engine/engine';
import { Tables } from '../engine/strength';
import { toPlain } from '../coach/compute';
import { compute, workerMs } from './compute-client';
import { readReviewEvents } from '../review/sse';
import { reviewKey } from '../review/key';
import { bindGame,
  CONCEPTS, GRADE_LABEL, GRADE_SCORE, HOME_BUY, HOME_FRIENDS, LESSONS, LEVELS, LOGR, PCT, RANKCH,
  SEATSHORT, SUITCLS, SUITS, TYPES, VAR, VARIANTS, VAR_ORDER, actWords, cardTxt, catOf,
  clamp, coachContext, coachRec, cr, cs, describe, drawInfo, esc, evaluate, fmt,
  gradeDecision, handPct, heroP, holeName, icards, lg, liveList, madeInfo, nm, num,
  oppDist, options, partLabelName, partName, pc, pick, planSplit, posInfo, potTotal, rnd,
  roundChips, splitHintLines, splitKey, splitValue, useSplit, vsOne,
} from '../coach/coach';
import './styles.css';
import { initSite } from '../pwa/site';
import { decodeGame, decodeStep } from '../net/wire';
import { Streams } from '../engine/rng';
import { addCharacter, DEFAULT_ROSTER, removeCharacter, renameCharacter, ROSTER_MAX, ROSTER_MIN, STYLES, styleLabel, validRoster } from '../engine/roster';

initSite();
const SEED = new URLSearchParams(location.search).get('seed');
// Measurement build only (`vite build --mode measure`, see tools/measure/longtasks.mjs): the same
// shortcuts and timers the Phase 1 harness patched into the original. Production builds drop it.
const MEASURE = import.meta.env.MODE === 'measure';
function timed(name, fn){
  if (!MEASURE) return fn();
  const t0 = performance.now();
  try { return fn(); } finally {
    const ms = performance.now() - t0;
    if (window.__on){ (window.__T[name] ||= []).push(ms); if (ms >= 2) window.__C.push([name, performance.now() - ms, ms]); }
  }
}
if (MEASURE){
  Object.assign(window, {__T: {}, __C: [], __W: workerMs, __rr: () => S});
  // time the split-game opponent model only when it is really computed (not cache hits)
  const orig = Tables.prototype.oppDist;
  Tables.prototype.oppDist = function(key){ return this.has(key) ? orig.call(this, key) : timed('oppDist', () => orig.call(this, key)); };
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
let MONEY = false;
const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const Snd = {
  ctx: null, nb: null, out: null, verb: null,
  init(){
    if (this.ctx){ if (this.ctx.state !== 'running' && this.ctx.resume) this.ctx.resume().catch(() => {}); return; }
    try {
      const C = window.AudioContext || window.webkitAudioContext, c = new C(); this.ctx = c;
      const len = Math.floor(c.sampleRate * 1), b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; this.nb = b;
      const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3;
      const master = c.createGain(); master.gain.value = 0.9; master.connect(comp).connect(c.destination); this.out = master;
      // small felt-covered room: short, dark reverb
      const ir = c.createBuffer(2, Math.floor(c.sampleRate * 0.32), c.sampleRate);
      for (let ch = 0; ch < 2; ch++){ const x = ir.getChannelData(ch); for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / x.length, 3.2) * 0.55; }
      const cv = c.createConvolver(); cv.buffer = ir; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
      const wet = c.createGain(); wet.gain.value = 0.16; cv.connect(lp).connect(wet).connect(master); this.verb = cv;
    } catch (e) { this.ctx = null; }
  },
  ok(){ return settings.sound && this.ctx && this.ctx.state === 'running'; },
  bus(pan = 0){
    const c = this.ctx, p = c.createStereoPanner ? c.createStereoPanner() : c.createGain();
    if (p.pan) p.pan.value = clamp(pan, -0.8, 0.8);
    p.connect(this.out); p.connect(this.verb); return p;
  },
  nz(t, dur, type, f, q, g, dest, f2){
    const c = this.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter(), ga = c.createGain();
    s.buffer = this.nb; fl.type = type; fl.frequency.setValueAtTime(f, t); if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur); fl.Q.value = q;
    ga.gain.setValueAtTime(0.0001, t); ga.gain.exponentialRampToValueAtTime(g, t + Math.min(0.006, dur / 4)); ga.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl).connect(ga).connect(dest); s.start(t, Math.random() * 0.8); s.stop(t + dur + 0.02);
  },
  ring(t, f, decay, g, dest){
    const c = this.ctx, o = c.createOscillator(), ga = c.createGain();
    o.frequency.value = f; ga.gain.setValueAtTime(0.0001, t); ga.gain.exponentialRampToValueAtTime(g, t + 0.0015); ga.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(ga).connect(dest); o.start(t); o.stop(t + decay + 0.02);
  },
  // one clay chip striking another: a hard transient plus short inharmonic ringing
  clack(t, g, dest){
    const f = rnd(2900, 4300), ratios = [1, 1.59, 2.14, 2.83], amps = [1, .5, .32, .16];
    this.nz(t, 0.006, 'highpass', 2500, 0.7, g * 0.9, dest);
    ratios.forEach((r, i) => this.ring(t, f * r * rnd(0.995, 1.005), rnd(0.03, 0.055) / (1 + i * 0.5), g * amps[i] * 0.22, dest));
    this.nz(t, 0.02, 'bandpass', rnd(900, 1300), 1.2, g * 0.25, dest);
  },
  // a small stack set down on felt: a few chips settling, getting quicker and quieter
  chipsDown(n = 4, pan = 0, g = 0.5){
    if (!this.ok()) return; const d = this.bus(pan); let t = this.ctx.currentTime + 0.01, dt = rnd(0.028, 0.04);
    for (let i = 0; i < n; i++){ this.clack(t, g * Math.pow(0.82, i), d); t += dt; dt *= rnd(0.62, 0.8); }
    this.nz(this.ctx.currentTime + 0.005, 0.05, 'lowpass', 500, 0.7, g * 0.25, d);
  },
  // chips pushed across felt into the pot: friction swish with chips knocking together
  chipsSlide(n = 7, pan = 0){
    if (!this.ok()) return; const d = this.bus(pan), t0 = this.ctx.currentTime + 0.01;
    this.nz(t0, 0.32, 'bandpass', 1500, 0.6, 0.09, d, 2600);
    for (let i = 0; i < n; i++) this.clack(t0 + 0.04 + Math.random() * 0.28, rnd(0.18, 0.4), d);
  },
  bigPot(pan = 0){ if (!this.ok()) return; this.chipsSlide(14, pan); setTimeout(() => this.chipsDown(6, pan, 0.45), 260); },
  // a card sliding across the felt, then landing
  cardSlide(pan = 0, g = 0.32){
    if (!this.ok()) return; const d = this.bus(pan), t = this.ctx.currentTime + 0.005;
    this.nz(t, 0.09, 'bandpass', 1100, 0.9, g, d, 3600);
    this.nz(t + 0.002, 0.03, 'highpass', 5000, 0.7, g * 0.5, d);
    this.nz(t + 0.085, 0.03, 'lowpass', 700, 0.8, g * 0.55, d);
  },
  cardFlip(pan = 0){
    if (!this.ok()) return; const d = this.bus(pan), t = this.ctx.currentTime + 0.005;
    this.nz(t, 0.012, 'highpass', 3200, 0.8, 0.35, d); this.nz(t + 0.006, 0.04, 'bandpass', 1400, 1, 0.18, d);
  },
  // riffle shuffle: dozens of card edges flicking past each other, then the bridge
  shuffle(){
    if (!this.ok()) return; const d = this.bus(0), t0 = this.ctx.currentTime + 0.02;
    for (let i = 0; i < 46; i++){ const x = i / 46, t = t0 + 0.75 * (x - 0.18 * Math.sin(Math.PI * x)); this.nz(t, 0.005, 'highpass', rnd(3500, 6000), 0.7, rnd(0.08, 0.16), d); this.nz(t, 0.012, 'bandpass', rnd(1500, 2500), 1.5, 0.05, d); }
    this.nz(t0 + 0.8, 0.22, 'bandpass', 2400, 0.7, 0.12, d, 900);
    this.nz(t0 + 1.0, 0.05, 'lowpass', 600, 0.8, 0.25, d);
  },
  // two knuckle taps on a padded table
  knock(pan = 0){
    if (!this.ok()) return; const d = this.bus(pan), c = this.ctx;
    for (const dt of [0, 0.13]){
      const t = c.currentTime + 0.01 + dt, o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(115, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.07);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(g).connect(d); o.start(t); o.stop(t + 0.12);
      this.nz(t, 0.035, 'lowpass', 380, 0.8, 0.35, d);
    }
  },
  muck(pan = 0){ this.cardSlide(pan, 0.16); },
  turn(){
    if (!this.ok()) return; const d = this.bus(0), t = this.ctx.currentTime + 0.01;
    this.ring(t, 784, 0.35, 0.09, d); this.ring(t, 1568, 0.18, 0.025, d); this.ring(t + 0.14, 1175, 0.45, 0.08, d); this.ring(t + 0.14, 2350, 0.2, 0.02, d);
  },
  tick(){ if (!this.ok()) return; const d = this.bus(0); this.ring(this.ctx.currentTime + 0.01, 1900, 0.05, 0.05, d); }
};

// Hand-drawn portraits from Sumer's descriptions
const AV = {
  sumer:  {skin: '#a8714a', hair: 'drop',   shirt: '#2f3b52'},
  rohit:  {skin: '#b98058', hair: 'afro',   shirt: '#2a5d8f'},
  krish:  {skin: '#ad7650', hair: 'burst',  shirt: '#8f3a2a'},
  nikhil: {skin: '#6e4128', hair: 'mullet', shirt: '#2c6e4f'},
  venky:  {skin: '#9c6a45', hair: 'side',   shirt: '#8a6a24'}
};
function avatarSVG(key, bg){
  const a = AV[key], H = '#15100d', shade = 'rgba(0,0,0,.18)';
  const hair = {
    afro: {back: '', front: [[32, 12, 11], [21, 15, 8.5], [43, 15, 8.5], [17, 22.5, 6.5], [47, 22.5, 6.5], [26, 8, 7], [38, 8, 7], [32, 5.5, 6], [14.5, 17, 4.5], [49.5, 17, 4.5]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')},
    drop: {back: '', front: '<path d="M19.5 25 C18 13 25 8 33 8 C41 8 47 13 44.5 25 C43 19 38 16.5 32 16.5 C26 16.5 21.5 19 19.5 25 Z"/><path d="M19.6 25 Q18.8 30 21 33.5 L22 26 Z" opacity=".5"/><path d="M44.4 25 Q45.2 30 43 33.5 L42 26 Z" opacity=".5"/>'},
    burst: {back: '', front: '<path d="M20.5 23 C20.5 14.5 25.5 11 32 11 C38.5 11 43.5 14.5 43.5 23 C40.5 18.5 36.5 17 32 17 C27.5 17 23.5 18.5 20.5 23 Z"/><path d="M19.6 24 C18.6 28 19.5 31 21.5 32.5 L21 25 Z" opacity=".38"/><path d="M44.4 24 C45.4 28 44.5 31 42.5 32.5 L43 25 Z" opacity=".38"/>'},
    mullet: {back: '<path d="M18.8 24 C16.3 34 17.3 43 21 48.5 L43 48.5 C46.7 43 47.7 34 45.2 24 Z"/>', front: '<path d="M20 24 C19.5 13 25.5 9.5 32 9.5 C38.5 9.5 44.5 13 44 24 C41 18.5 37 16 32 16 C27 16 23 18.5 20 24 Z"/>'},
    side: {back: '', front: '<path d="M20 24 C19.5 12 27 8.5 34 9.5 C41 10.5 45 15 44 24 C41 17 34 15 24.5 19.5 Z"/>'}
  }[a.hair];
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="32" fill="${bg}"/><g fill="${H}">${hair.back}</g><path d="M9 64 C11 51 21 46.5 32 46.5 C43 46.5 53 51 55 64 Z" fill="${a.shirt}"/><rect x="27" y="37" width="10" height="11" rx="4" fill="${a.skin}"/><rect x="27" y="37" width="10" height="5" fill="${shade}"/><ellipse cx="20.3" cy="29" rx="2.6" ry="3.6" fill="${a.skin}"/><ellipse cx="43.7" cy="29" rx="2.6" ry="3.6" fill="${a.skin}"/><ellipse cx="32" cy="28" rx="12" ry="14" fill="${a.skin}"/><g fill="${H}">${hair.front}</g><rect x="25" y="25.2" width="5" height="1.3" rx=".6" fill="${H}"/><rect x="34" y="25.2" width="5" height="1.3" rx=".6" fill="${H}"/><circle cx="27.5" cy="29.2" r="1.35" fill="#1b1410"/><circle cx="36.5" cy="29.2" r="1.35" fill="#1b1410"/><path d="M31 31 Q32 34 33 31" fill="none" stroke="${shade}" stroke-width="1"/><path d="M28.5 36.2 Q32 38.6 35.5 36.2" fill="none" stroke="#5a2e22" stroke-width="1.2" stroke-linecap="round"/></svg>`;
}
const HOME_CHAT = {
  Venky: {think: ['hmm...', 'wait what do I have', 'one sec guys', 'ok ok ok', 'umm'], win: ['lets gooo', 'wait I won?', 'easy'], lose: ['how', 'bro what']},
  Krish: {win: ['you had nothing', 'told you', 'too easy'], lose: ['nice call', 'ugh'], bluff: ['lol', 'gotcha']},
  Rohit: {win: ['ty', 'finally'], lose: ['nh'], fold: ['too rich for me', 'not this time']},
  Nikhil: {win: ['nh', 'gg'], lose: ['nice hand', 'well played']}
};
const homeLine = (p, kind, fallback) => { const c = HOME_CHAT[p.name]; return c && c[kind] ? pick(c[kind]) : fallback; };
const COACH = TYPES.tag;
const CHAT = {
  win: ['ty', 'gg', 'nice', 'ship it', 'finally', 'ty ty'],
  lose: ['ugh', 'nh', 'unreal', 'sick river', 'every time', 'wow', 'of course'],
  tilt: ['rigged lol', 'this deck hates me', 'cant win a hand'],
  bust: ['gg all', 'gg', 'gl everyone']
};
/** @type {Array<[number, string, string?]>} */
const DENOMS = [[5000,'#d97a2b'],[1000,'#e0bd45'],[500,'#7b52b8'],[100,'#26282c'],[25,'#2c8a4d'],[5,'#c23a2e'],[1,'#ece8dc','#3b6fb6']];
// home game chips, in cents: black $1, green 50c, red 20c, blue 10c
/** @type {Array<[number, string, string?]>} */
const DENOMS_HOME = [[100,'#1d1e22'],[50,'#2c8a4d'],[20,'#c23a2e'],[10,'#2f6fd0']];
const BUYIN = 10;
const PACE = {learn: 1, normal: 0.55, fast: MEASURE ? 0.02 : 0.3};
const LAY = {
  land: { ratio: 1.72, felt: [12, 7, 14, 7],
    seats: [[50,89],[11,72],[11,30],[50,12.5],[89,30],[89,72]],
    bets:  [[50,66],[25,62],[25,38],[50,28],[75,38],[75,62]],
    dbtn:  [[59.5,67],[19,54],[19,46],[41,28],[81,46],[81,55]],
    pot: [50,35.5], board: [50,48], msg: [50,60], street:[50,58.5], board2: [50,22.5], msg2: [50,60] },
  port: { ratio: .64, felt: [9, 6, 14, 6],
    seats: [[50,90],[15,65],[15,32],[50,11],[85,32],[85,65]],
    bets:  [[50,68.5],[33,60],[31,38.5],[50,23],[69,38.5],[67,60]],
    dbtn:  [[63,70],[24,53],[22,45],[37,23.5],[78,45],[76,53]],
    pot: [50,33.5], board: [50,46.5], msg: [50,56.5], street:[50,55], board2: [50,22.5], msg2: [50,56.5] }
};

const SKEY = 'river-room-v2';
const settings = Object.assign({games:'dealer', name:'You', opp:5, stack:1500, perLevel:10, sound:true, fourColor:true, showEq:false, timer:0, pace:'learn', review:'played', hints:true, hud:true, revealAll:true, holdResult:true, mode:'tourney'}, loadLocal(SKEY, {}));
function loadLocal(k, d){ try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && typeof v === 'object' ? v : d; } catch (e) { return d; } }
function saveLocal(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
const saveSettings = () => saveLocal(SKEY, settings);

/* ================= state ================= */
const board2El = $('#board2'), arena = $('#arena'), stage = $('#stage'), boardEl = $('#board'), potEl = $('#pot'), msgEl = $('#msg'), dbtnEl = $('#dbtn');
/** The game in progress: the engine's state plus what the screens keep alongside it. @type {(ReturnType<typeof E.newGame> & Record<string, any>) | null} */
let S = null;
let GID = 0, L = LAY.land, pending = null, curAmt = 0;
class Abort extends Error {}
const SPEED = () => {
  // online: catch up quickly when the server is a few steps ahead of this screen
  if (S && S.online && ON && ON.queue.length > 1) return 0.15;
  const hero = S && S.players.find(p => p.isHuman);
  const watching = hero && (hero.folded || hero.out || !S.handActive);
  return (PACE[settings.pace] || 1) * (watching ? 0.75 : 1);
};
function wait(ms, raw){
  const gid = S.gid, d = raw ? ms : ms * SPEED();
  return new Promise((res, rej) => setTimeout(() => (S && S.gid === gid) ? res() : rej(new Abort()), d));
}
function guard(gid){ if (!S || S.gid !== gid) throw new Abort(); }
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({1:'st', 2:'nd', 3:'rd'}[n % 10] || 'th'));
const homeName = () => (!settings.name || settings.name === 'You') ? 'Sumer' : settings.name;
function buildSeats(){
  $$('.seat,.bet', arena).forEach(e => e.remove());
  for (let s = 0; s < 6; s++){
    const p = S.players.find(x => x.seat === s);
    const seat = document.createElement('div');
    seat.className = 'seat' + (p ? '' : ' empty') + (p && p.isHuman ? ' hero' : '');
    seat.dataset.seat = String(s);
    if (p){
      const ini = p.isHuman ? (p.name.trim()[0] || 'Y').toUpperCase() : p.name.slice(0, 2).toUpperCase();
      seat.innerHTML = `<div class="hole"></div><div class="plate" style="--pc:${p.color}"><div class="avatar${p.avatar ? ' pic' : ''}">${p.avatar ? avatarSVG(p.avatar, p.color) : `<span>${esc(ini)}</span>`}</div><div class="meta"><div class="nm"></div><div class="stk"></div>${p.isHuman ? '' : '<div class="hud"></div>'}</div><div class="timer"><i></i></div><div class="eqp" hidden></div></div><div class="hn" hidden></div><div class="xp" hidden></div><div class="gain"></div>${p.isHuman ? '' : '<div class="bubble"></div>'}`;
      p.el = seat;
      const b = document.createElement('div'); b.className = 'bet'; b.hidden = true; arena.appendChild(b); p.betEl = b;
    } else seat.innerHTML = `<div class="plate"><div class="meta"><div class="nm">Open seat</div></div></div>`;
    arena.appendChild(seat);
  }
}
function layout(){
  const r = stage.getBoundingClientRect(); const W = Math.max(200, r.width), H = Math.max(200, r.height);
  const portrait = W / H < 1.05; L = portrait ? LAY.port : LAY.land;
  let aw, ah;
  if (portrait){ ah = Math.min(H, W / L.ratio); aw = ah * L.ratio; } else { aw = Math.min(W, H * L.ratio); ah = aw / L.ratio; }
  arena.style.width = aw + 'px'; arena.style.height = ah + 'px';
  const shortWide = !portrait && window.innerHeight <= 520;
  arena.style.fontSize = Math.max(8, Math.min(19, portrait ? aw / 30 : aw / (shortWide ? 56 : 64))) + 'px';
  arena.classList.toggle('portrait', portrait);
  const f = L.felt, rail = $('#rail');
  rail.style.top = f[0] + '%'; rail.style.right = f[1] + '%'; rail.style.bottom = f[2] + '%'; rail.style.left = f[3] + '%';
  $$('.seat', arena).forEach(el => { const s = +el.dataset.seat; el.style.left = L.seats[s][0] + '%'; el.style.top = L.seats[s][1] + '%'; });
  if (S) S.players.forEach(p => { p.betEl.style.left = L.bets[p.seat][0] + '%'; p.betEl.style.top = L.bets[p.seat][1] + '%'; });
  const b2 = !!(VAR() && VAR().board2); board2El.hidden = !b2; arena.classList.toggle('b2on', b2); arena.classList.toggle('var', !!VAR());
  for (const [el, k] of [[potEl, 'pot'], [boardEl, 'board'], [msgEl, b2 ? 'msg2' : 'msg'], [$('#streetLbl'), 'street'], [board2El, 'board2']]){ el.style.left = L[k][0] + '%'; el.style.top = L[k][1] + '%'; }
  placeButton();
}
function placeButton(){
  if (!S || S.button < 0){ dbtnEl.hidden = true; return; }
  const d = L.dbtn[S.players[S.button].seat]; dbtnEl.hidden = false; dbtnEl.style.left = d[0] + '%'; dbtnEl.style.top = d[1] + '%';
}
new ResizeObserver(() => layout()).observe(stage);

/* ================= rendering ================= */
function chipsHTML(amt){
  const list = [], DEN = MONEY ? DENOMS_HOME : DENOMS; let a = Math.max(1, Math.round(amt));
  for (const d of DEN){ while (a >= d[0] && list.length < 6){ list.push(d); a -= d[0]; } if (list.length >= 6) break; }
  if (!list.length) list.push(DEN[DEN.length - 1]);
  return `<span class="chips" style="--n:${list.length}">${list.map((d, i) => `<i class="chip" style="--c:${d[1]};${d[2] ? `--e:${d[2]};` : ''}bottom:${(i * 0.2).toFixed(2)}em"></i>`).join('')}</span>`;
}
function cardHTML(c, cls = ''){
  const s = cs(c);
  return `<div class="card ${SUITCLS[s]} ${cls}"><span class="cr">${RANKCH[cr(c)]}</span><span class="cs">${SUITS[s]}</span><span class="big">${SUITS[s]}</span></div>`;
}
const backHTML = () => '<div class="card back"></div>';
function hudText(p){
  const h = p.hud; if (h.hands < 4) return MONEY && p.type && TYPES[p.type].home ? TYPES[p.type].label : 'New player';
  return `VPIP ${Math.round(h.vpip / h.hands * 100)} · PFR ${Math.round(h.pfr / h.hands * 100)} · ${h.hands}h`;
}
function renderSeat(p){
  const el = p.el; if (!el || !el.isConnected) return;
  el.classList.toggle('active', S.toAct === p.i);
  el.classList.toggle('folded', p.folded && !p.out);
  el.classList.toggle('out', p.out);
  el.classList.toggle('win', !!p.winner);
  const nmEl = el.querySelector('.nm'), lab = p.out ? '' : p.label;
  const txt = lab || p.name;
  if (nmEl.textContent !== txt){ nmEl.textContent = txt; if (lab){ nmEl.classList.remove('pop'); void nmEl.offsetWidth; nmEl.classList.add('pop'); } }
  nmEl.className = 'nm' + (lab ? ' lab lab-' + lab.toLowerCase().replace(/[^a-z]/g, '') : '') + (nmEl.classList.contains('pop') ? ' pop' : '');
  el.querySelector('.stk').textContent = p.out ? (p.place ? ordinal(p.place) + ' place' : 'Out') : (p.allIn && p.stack === 0 && S.handActive ? 'All-in' : fmt(p.stack));
  const hudEl = el.querySelector('.hud');
  if (hudEl){ hudEl.hidden = !settings.hud || p.out; hudEl.textContent = hudText(p); }
  const plate = el.querySelector('.plate');
  if (!p.isHuman) plate.title = p.read ? `${p.name} plays like a ${TYPES[p.type].label.toLowerCase()}. ${TYPES[p.type].desc}` : `${p.name}: no read yet. Watch how they play.`;
  const hole = el.querySelector('.hole');
  const show = p.vis > 0 && !(p.folded && !p.isHuman && !p.revealed);
  const toks = [], faceUp = p.isHuman || p.shown;
  // split games: before the split you hold every card; afterwards your two poker cards sit here and the other parts beside you
  const groups = p.isHuman && VAR() && !p.splitDone && p.plan ? p.plan : null, starts = new Set();
  if (groups){ let x = 0; groups.forEach((g, j) => { if (j) starts.add(x); x += g.length; }); }
  const src = groups ? [].concat(...groups) : faceUp && p.splitDone ? p.cards : (p.all && p.all.length ? p.all : p.cards);
  const cnt = faceUp && p.splitDone ? Math.min(2, p.vis) : Math.min(p.vis, src.length || p.vis);
  if (show) for (let k = 0; k < cnt; k++){
    const c = src[k], face = faceUp;
    const h = face && S.highlight ? (S.highlight.has(c) ? 'hl' : 'dim') : '';
    toks.push(face ? `f${c}:${h}${p.folded ? 'x' : ''}` : 'b');
  }
  const key = toks.join(',') + (p.shown && !p.isHuman ? '|o' : '') + (starts.size ? '|g' + [...starts].join('.') : '');
  if (hole.dataset.k !== key){
    const prev = hole._prev || [];
    hole.innerHTML = toks.map((t, k) => {
      if (t === 'b') return backHTML();
      const c = src[k], wasFace = (prev[k] || '').startsWith(`f${c}:`);
      const h = t.split(':')[1].replace('x', '');
      return cardHTML(c, [h, wasFace ? '' : 'flip', p.folded ? 'folded' : '', starts.has(k) ? 'gap' : ''].join(' '));
    }).join('');
    hole._prev = toks; hole.dataset.k = key;
  }
  hole.classList.toggle('open', p.shown && !p.isHuman);
  hole.classList.toggle('many', toks.length > 2);
  const hn = el.querySelector('.hn'); let t = '';
  if (p.handName && (p.shown || p.isHuman) && (!p.folded || p.revealed)) t = p.handName;
  else if (groups && p.vis >= src.length && !p.out){
    const V = VAR(); t = groups.map((g, j) => (j ? V.parts[j].sh + ': ' : '') + partName(V.parts[j].k, g)).join(' · ');
  }
  else if (p.isHuman && p.cards.length === 2 && p.vis >= 2 && !p.folded && !p.out){
    const vb = S.board.slice(0, S.boardVis);
    t = vb.length >= 3 ? describe(evaluate(p.cards.concat(vb))) : holeName(p.cards[0], p.cards[1]);
    if (settings.showEq && S.heroEq != null && !S.revealed) t += ` · ${pc(S.heroEq)} ${VAR() ? 'of the pot' : 'to win'}`;
  }
  hn.textContent = t; hn.hidden = !t;
  renderParts(p);
  const xpEl = el.querySelector('.xp');
  if (xpEl && !p.isHuman && !xpEl.hidden) xpEl.style.top = (hn.hidden ? el.offsetHeight + 4 : hn.offsetTop + hn.offsetHeight + 4) + 'px';
  const eqp = el.querySelector('.eqp');
  if (p.eq != null && !p.folded){ eqp.textContent = pc(p.eq); eqp.hidden = false; } else eqp.hidden = true;
  const b = p.betEl;
  if (p.bet > 0){ const k = 'b' + p.bet; if (b.dataset.k !== k){ b.innerHTML = chipsHTML(p.bet) + `<span class="amt">${fmt(p.bet)}</span>`; b.dataset.k = k; } b.hidden = false; }
  else { b.hidden = true; b.dataset.k = ''; }
}
// The other parts of a split hand, shown as small cards beside the seat
function renderParts(p){
  const xp = p.el && p.el.querySelector('.xp'); if (!xp) return;
  const V = VAR(), on = !!(V && p.splitDone && p.extra && !p.out && (p.isHuman || ((p.shown || p.revealed) && (!p.folded || p.revealed))));
  const key = on ? p.extra.map((h, i) => h.join('.') + (p.partWin && p.partWin[i + 1] ? 'w' : '')).join('|') + '/' + S.boardVis2 + (p.revealed ? 'r' : '') + (p.folded ? 'f' : '') : '';
  if (xp.dataset.k === key) return;
  xp.dataset.k = key; xp.hidden = !on;
  xp.innerHTML = on ? p.extra.map((h, i) => { const pt = V.parts[i + 1]; return `<div class="xg${p.partWin && p.partWin[i + 1] ? ' win' : ''}"><span class="xl">${esc(pt.label)}</span><div class="xc">${h.map(c => cardHTML(c, p.folded ? 'folded' : '')).join('')}</div><span class="xn">${esc(partName(pt.k, h))}</span></div>`; }).join('') : '';
}
function renderBoard2(){
  const V = VAR(), on = !!(V && V.board2); board2El.hidden = !on; if (!on) return;
  const slots = board2El.querySelectorAll('.slot');
  for (let k = 0; k < 2; k++){
    const s = slots[k], c = S.board2[k], vis = k < S.boardVis2, tok = vis ? 'f' + c : '';
    if (s.dataset.k !== tok){ s.innerHTML = vis ? cardHTML(c, 'flip') : ''; s.dataset.k = tok; }
  }
}
function renderBoard(){
  const slots = boardEl.children;
  for (let k = 0; k < 5; k++){
    const s = slots[k], c = S.board[k], vis = k < S.boardVis;
    const h = vis && S.highlight ? (S.highlight.has(c) ? 'hl' : 'dim') : '';
    const tok = vis ? `f${c}:${h}` : '';
    if (s.dataset.k !== tok){ const wasFace = (s.dataset.k || '').startsWith(`f${c}:`); s.innerHTML = vis ? cardHTML(c, h + (wasFace ? '' : ' flip')) : ''; s.dataset.k = tok; }
  }
}
function renderPot(){
  const bets = S.players.reduce((a, p) => a + p.bet, 0);
  potEl.hidden = !(S.pot > 0 || bets > 0);
  if (potEl.hidden) return;
  potEl.innerHTML = (S.pot > 0 ? chipsHTML(S.pot) : '') + `<div class="pl"><span class="pv">Pot ${fmt(S.pot)}</span>${bets > 0 && S.pot > 0 ? `<span class="pt">Total ${fmt(S.pot + bets)}</span>` : ''}${S.sideInfo ? `<span class="ps">${esc(S.sideInfo)}</span>` : ''}</div>`;
}
function render(){
  if (!S) return;
  S.players.forEach(renderSeat); renderBoard(); renderBoard2(); renderPot();
  msgEl.textContent = S.msg; msgEl.hidden = !S.msg;
  placeButton();
}
function renderInfo(){
  if (!S) return;
  if (MONEY){
    const hero = heroP(), net = (S.handActive ? hero.start : hero.stack) - hero.buyins * HOME_BUY;
    $('#info').innerHTML = `<span class="ichip"><b>Hand</b>${S.handNo ? '#' + S.handNo : '—'}</span>${S.variant ? `<span class="ichip hot"><b>Game</b>${VARIANTS[S.variant].short}</span>` : ''}<span class="ichip hot opt"><b>Blinds</b>${fmt(S.sb)}/${fmt(S.bb)}</span><span class="ichip opt"><b>Buy-in</b>${fmt(HOME_BUY)}</span><span class="ichip"><b>Your net</b>${net > 0 ? '+' : ''}${fmt(net)}</span>`;
    $('#tableName').textContent = S.online && ON ? `Online table ${ON.code} · ${fmt(HOME_BUY)} buy-in` : `Home game · ${fmt(HOME_BUY)} buy-in`;
    return;
  }
  const alive = S.players.filter(p => !p.out);
  const total = alive.reduce((a, p) => a + p.stack + p.bet, 0) + S.pot;
  const handsLeft = settings.perLevel - ((Math.max(1, S.handNo) - 1) % settings.perLevel) - 1;
  const atTop = S.level >= LEVELS.length - 1;
  $('#info').innerHTML =
    `<span class="ichip"><b>Hand</b>${S.handNo ? '#' + S.handNo : '—'}</span>` +
    `<span class="ichip hot"><b>Lvl ${S.level + 1}</b>${fmt(S.sb)}/${fmt(S.bb)}</span>` +
    (S.ante ? `<span class="ichip opt"><b>Ante</b>${fmt(S.ante)}</span>` : '') +
    (S.handNo && !atTop ? `<span class="ichip opt"><b>Blinds up</b>${handsLeft === 0 ? 'next hand' : 'in ' + (handsLeft + 1) + ' hands'}</span>` : '') +
    `<span class="ichip"><b>Left</b>${alive.length}/${S.players.length}</span>` +
    `<span class="ichip opt"><b>Avg</b>${fmt(total / Math.max(1, alive.length))}</span>`;
  $('#tableName').textContent = `Table ${S.tableNo} · $${BUYIN} Sit & Go`;
}
let toastT = 0;
function toast(t, ms = 2800){ const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = window.setTimeout(() => el.classList.remove('show'), ms); }
function feedPush(t){ S.feed.unshift(t); if (S.feed.length > 3) S.feed.length = 3; renderFeed(); }
function renderFeed(){ $('#feed').innerHTML = S && S.feed.length ? S.feed.map(t => `<span>${esc(t)}</span>`).join('') : ''; }
function streetFlash(t){ const el = $('#streetLbl'); el.textContent = t; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1400); }

/* ================= animation helpers ================= */
function ptOf(el){ const a = arena.getBoundingClientRect(), b = el.getBoundingClientRect(); return {x: b.left - a.left + b.width / 2, y: b.top - a.top + b.height / 2}; }
function pct(v){ return {x: v[0] / 100 * arena.clientWidth, y: v[1] / 100 * arena.clientHeight}; }
const panOf = p => p ? (L.seats[p.seat][0] - 50) / 50 : 0;
function fly(html, from, to, dur = 400, cls = '', fade = false){
  const el = document.createElement('div'); el.className = 'flyer ' + cls; el.innerHTML = html;
  el.style.left = from.x + 'px'; el.style.top = from.y + 'px'; arena.appendChild(el);
  const d = MEASURE ? 5 : REDUCED ? 40 : dur * Math.min(1, SPEED() * 0.8 + 0.35);
  const dx = to.x - from.x, dy = to.y - from.y;
  let anim;
  try {
    anim = el.animate([
      {transform: 'translate(-50%,-50%) translate(0,0) rotate(-10deg)', opacity: 1},
      {transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) rotate(0deg)`, opacity: fade ? 0 : 1}
    ], {duration: d, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards'});
  } catch (e) { el.remove(); return Promise.resolve(); }
  return anim.finished.then(() => el.remove(), () => el.remove());
}
const plateOf = p => p.el.querySelector('.plate');
function betFly(p){ return fly(chipsHTML(p.bet), ptOf(plateOf(p)), pct(L.bets[p.seat]), 300).then(() => renderSeat(p)); }
function muckFly(p){ if (!p.vis) return; fly(backHTML(), ptOf(p.el.querySelector('.hole')), pct(L.pot), 420, 'fcard', true); }
function gainFx(p, amt){ const g = p.el.querySelector('.gain'); g.textContent = '+' + fmt(amt); g.classList.remove('show'); void g.offsetWidth; g.classList.add('show'); }
function say(p, text){
  if (!p.el || p.isHuman) return;
  const b = p.el.querySelector('.bubble'); if (!b) return;
  b.textContent = text; b.classList.add('show'); clearTimeout(b._t); b._t = setTimeout(() => b.classList.remove('show'), 3400);
  feedPush(`${p.name}: “${text}”`); lg(`${p.name} said, "${text}"`);
}

function thinkTime(p, a, o, strength){
  const pr = p.persona, big = o.toCall > p.stack * 0.35 || (a.type === 'raise' && a.to >= o.maxTo);
  let t;
  if (a.type === 'fold') t = S.street === 0 ? rnd(1100, 2100) : rnd(1500, 2700);
  else if (a.type === 'check') t = rnd(1200, 2400);
  else if (a.type === 'call') t = rnd(1700, 3300);
  else t = rnd(2000, 3800);
  if (big) t += rnd(1800, 3800);
  // timing tells: some players take longer with strong hands and act fast with weak ones
  if (a.type === 'raise' || a.type === 'call') t += pr.tell * (strength - 0.5) * 3000;
  else t -= pr.tell * (0.5 - strength) * 900;
  if (pr.quickFold && a.type === 'fold') t *= 0.45;
  if (pr.slow) t = Math.min(12000, t * pr.slow);
  return Math.max(600, t);
}
/* ================= your turn ================= */
function humanAction(p, ctx){
  return new Promise(res => {
    const o = options(p), pre = S.pre; S.pre = null;
    if (pre === 'checkfold'){ res(o.toCall === 0 ? {type: 'check'} : {type: 'fold'}); return; }
    if (pre === 'check' && o.toCall === 0){ res({type: 'check'}); return; }
    if (pre === 'callany'){ res(o.toCall === 0 ? {type: 'check'} : {type: 'call'}); return; }
    pending = {res, o, p, ctx};
    if (settings.showEq){ const dp = S.decPre; hintFor(dp).then(r => { if (pending && S.decPre === dp){ S.heroEq = r.ctx.eq; renderSeat(p); } }).catch(() => {}); }
    setupActionUI(o, ctx); Snd.turn();
  });
}
function submit(a){ if (!pending) return; const r = pending.res; pending = null; $('#act').hidden = true; $('#hint').hidden = true; r(a); }
function setupActionUI(o, ctx){
  $('#pre').hidden = true; $('#status').hidden = true; $('#act').hidden = false; $('#hint').hidden = true;
  $('#bFold .t').textContent = 'Fold'; foldArm = 0;
  const call = $('#bCall');
  if (o.canCheck){ call.querySelector('.t').textContent = 'Check'; call.querySelector('.v').textContent = ''; }
  else { call.querySelector('.t').textContent = o.toCall >= pending.p.stack ? 'Call all-in' : 'Call'; call.querySelector('.v').textContent = fmt(o.toCall); }
  const canSize = o.canRaise && o.maxTo > o.minTo;
  $('#bRaise').hidden = !o.canRaise; $('#sizer').hidden = !canSize;
  $('.acts').style.gridTemplateColumns = o.canRaise ? '' : '1fr 1fr';
  const potT = potTotal();
  $('#tinfo').innerHTML = `<span><b>Pot</b>${fmt(potT)}</span>` + (o.toCall > 0 ? `<span><b>Call costs</b>${fmt(o.toCall)}</span><span><b>Need to win</b>${pc(ctx.need)}+</span>` : `<span><b>Nobody bet</b>checking is free</span>`) + `<span><b>Seat</b>${SEATSHORT[ctx.pos.key] || ctx.pos.label}</span>`;
  $('#hintBtn').hidden = !settings.hints;
  if (!o.canRaise && o.toCall > 0){
    const ai = liveList().filter(x => x !== pending.p && x.allIn);
    if (ai.length && ai.length === liveList().filter(x => x !== pending.p).length) $('#tinfo').insertAdjacentHTML('beforeend', `<span class="ainote">${esc(ai.map(x => x.name).join(' & '))} ${ai.length > 1 ? 'are' : 'is'} all-in, so you can only call or fold. Extra chips could not be called and would come straight back to you.</span>`);
  }
  $('#arrBtn').hidden = !(VAR() && pending && pending.p.plan && !pending.p.splitDone);
  const amt = $('#amt'); amt.min = o.minTo; amt.max = o.maxTo; amt.step = MONEY ? 10 : 1; $('#amtNum').step = MONEY ? '0.10' : '1';
  const pr = [];
  if (MONEY && S.street === 0 && S.streetRaises === 0) pr.push(['$0.30', 30], ['$0.40', 40], ['$0.60', 60], ['$1', 100], ['All-in', o.maxTo]);
  else if (MONEY && S.currentBet === 0) pr.push(['$0.20', 20], ['$0.30', 30], ['$0.50', 50], ['$1', 100], ['Pot', potT], ['All-in', o.maxTo]);
  else if (MONEY){ const seen = new Set(); for (const v of [o.minTo, S.currentBet * 3, S.currentBet * 4, S.currentBet + potT + o.toCall]){ const x = clamp(Math.round(v / 10) * 10, o.minTo, o.maxTo); if (x < o.maxTo && !seen.has(x)){ seen.add(x); pr.push([fmt(x), x]); } } pr.push(['All-in', o.maxTo]); }
  else if (S.street === 0 && S.streetRaises === 0) pr.push(['2.5 BB', 2.5 * S.bb], ['3 BB', 3 * S.bb], ['4 BB', 4 * S.bb], ['Pot', S.currentBet + potT + o.toCall], ['All-in', o.maxTo]);
  else pr.push(['Min', o.minTo], ['½ Pot', S.currentBet + 0.5 * (potT + o.toCall)], ['¾ Pot', S.currentBet + 0.75 * (potT + o.toCall)], ['Pot', S.currentBet + potT + o.toCall], ['All-in', o.maxTo]);
  $('#presets').innerHTML = pr.map(([l, v]) => `<button type="button" data-v="${Math.round(v)}">${l}</button>`).join('');
  let def;
  if (S.street === 0 && S.streetRaises === 0) def = MONEY ? 40 : 2.5 * S.bb; else if (o.isBet) def = MONEY ? [0, 30, 50, 100][S.street] : 0.6 * potT; else def = o.minTo;
  setAmt(canSize ? def : o.maxTo);
}
/** The coach's read and recommendation for the current decision, computed once in the worker. */
function hintFor(dp){
  if (!dp.hint) dp.hint = compute({type: 'hint', snap: dp.snap, seed: S.rs.seed, pi: dp.pi, label: dp.label, recLabel: S.rs.label(S.handNo, 'hint'), money: MONEY, settings});
  return dp.hint;
}
function showHint(){
  if (!pending || !S.decPre) return;
  const dp = S.decPre, h = $('#hint');
  h.innerHTML = '<strong>The coach is thinking…</strong>'; h.hidden = false;
  hintFor(dp).then(r => { if (pending && S.decPre === dp && !h.hidden) timed('showHintInner', () => showHintInner(r.ctx, r.rec)); })
    .catch(err => { console.error(err); h.textContent = 'The coach could not work this one out. Use your own read here.'; h.hidden = false; });
}
function showHintInner(c, r){
  const h = $('#hint');
  const shove = (r.act === 'raise' || r.act === 'bet') && r.size && roundChips(r.size) >= c.o.maxTo;
  const word = r.act === 'allin' || shove ? 'Go all-in' : r.act === 'raise' ? (c.currentBet === 0 && c.st > 0 ? 'Bet' : 'Raise') : r.act[0].toUpperCase() + r.act.slice(1);
  const size = r.size && !shove && (r.act === 'raise' || r.act === 'bet') ? (c.currentBet === 0 ? ' about ' : ' to about ') + fmt(roundChips(r.size)) : '';
  h.title = 'Tap to close';
  const body = r.sections ? r.sections.filter(x => x.items.length).map(x => `<div class="hs"><h5>${x.h}</h5><ul>${x.items.map(l => `<li>${l}</li>`).join('')}</ul></div>`).join('') : `<ul>${r.lines.map(l => `<li>${l}</li>`).join('')}</ul>`;
  h.innerHTML = `<strong>Coach says: ${esc(word)}${size}${r.alt ? ' (or ' + r.alt + ')' : ''}</strong>${body}`;
  h.hidden = false;
}
function setAmt(v){
  if (!pending) return;
  const o = pending.o;
  v = Math.round(Number(v)); if (!isFinite(v)) v = o.minTo;
  if (MONEY && v < o.maxTo) v = Math.round(v / 10) * 10;
  v = clamp(v, o.minTo, o.maxTo); curAmt = v;
  $('#amt').value = v; $('#amtNum').value = MONEY ? (v / 100).toFixed(2) : v;
  $('#bRaise .t').textContent = v >= o.maxTo ? 'All-in' : (o.isBet ? 'Bet' : 'Raise to');
  $('#bRaise .v').textContent = fmt(v);
  $$('#presets button').forEach(b => b.classList.toggle('on', clamp(+b.dataset.v, o.minTo, o.maxTo) === v));
}
function statusText(){
  const hero = heroP();
  if (!S.running) return 'Pick your table settings to start.';
  if (hero.out) return 'You are out of the tournament.';
  if (!S.handActive) return S.paused ? '<b>Paused.</b> Press play in the top bar to deal the next hand.' : 'Shuffling up the next hand…';
  if (hero.folded) return 'You folded. Watching the rest of the hand.';
  if (hero.allIn) return '<b>You are all-in.</b> Good luck.';
  if (S.toAct >= 0 && S.players[S.toAct] && !S.players[S.toAct].isHuman) return `<b>${esc(S.players[S.toAct].name)}</b> is thinking…`;
  return '';
}
function renderControls(){
  if (pending || !S) return;
  $('#act').hidden = true;
  $('#contRow').hidden = !contWait;
  if (contWait){ $('#pre').hidden = true; $('#status').hidden = false; $('#status').innerHTML = contMsg || '<b>Hand over.</b> Look at everyone\'s cards, then continue.'; return; }
  const hero = heroP();
  const inHand = S.running && S.handActive && hero && !hero.out && !hero.folded && !hero.allIn && hero.vis >= 2 && hero.cards.length === 2 && !S.revealed && S.street < 4;
  if (inHand){
    $('#pre').hidden = false; $('#status').hidden = true;
    const toCall = Math.max(0, S.currentBet - hero.bet);
    if (S.pre === 'check' && toCall > 0) S.pre = null;
    const [cf, ck, ca] = $$('#pre .pbtn');
    cf.textContent = toCall > 0 ? 'Fold' : 'Check / Fold';
    ck.hidden = toCall > 0;
    ca.textContent = toCall > 0 ? `Call ${fmt(Math.min(toCall, hero.stack))}+` : 'Call any';
    $$('#pre .pbtn').forEach(b => b.setAttribute('aria-pressed', String(S.pre === b.dataset.pre)));
  } else { $('#pre').hidden = true; $('#status').hidden = false; $('#status').innerHTML = statusText() || '&nbsp;'; }
}

async function dealBoard(n){
  const gid = S.gid, start = S.boardVis, fl = [];
  for (let j = 0; j < n; j++){
    const k = start + j; Snd.cardSlide(0, 0.28);
    fl.push(fly(backHTML(), pct(L.pot), ptOf(boardEl.children[k]), 340, 'fboard').then(() => { if (S.gid === gid){ S.boardVis = Math.max(S.boardVis, k + 1); Snd.cardFlip(0); renderBoard(); S.players.forEach(p => p.isHuman && renderSeat(p)); } }));
    await wait(n > 1 ? 160 : 0);
  }
  await Promise.all(fl); guard(gid);
  S.boardVis = start + n; render();
  await wait(n > 1 ? 700 : 550);
}
async function dealBoard2(){
  const gid = S.gid, k = S.boardVis2; Snd.cardSlide(0, 0.28);
  await fly(backHTML(), pct(L.pot), ptOf(board2El.querySelectorAll('.slot')[k]), 340, 'fboard'); guard(gid);
  S.boardVis2 = k + 1; Snd.cardFlip(0); render();
  await wait(550);
}
// Dealer's choice: the dealer picks the game for this hand
let dealWait = null;
let splitWait = null, spState = null;
function openArrange(){
  const hero = heroP();
  if (!S || !VAR() || !S.handActive || !hero || !hero.plan || hero.splitDone || hero.out || splitWait || !$('#splitOv').hidden) return;
  heroSplit(hero, Math.max(1, liveList().filter(x => x !== hero).length), 'plan');
}
function heroSplit(p, k, mode){
  const V = VAR(), prev = spState && !$('#splitOv').hidden ? spState.cur : null;
  spState = {V, p, k, mode, cur: (prev || p.plan || planSplit(p, k)).map(x => x.slice()), best: planSplit(p, k), sel: null};
  const fin = mode === 'final';
  $('#spEyebrow').textContent = fin ? `Hand #${S.handNo} · showdown · everyone shows after this` : `Hand #${S.handNo} · arrange your cards`;
  $('#spTitle').textContent = fin ? 'Your final split' : V.name;
  const vb = S.board.slice(0, S.boardVis), vb2 = S.board2.slice(0, S.boardVis2);
  $('#spRule').innerHTML = (vb.length ? `Table: ${icards(vb)}${vb2.length ? ` &nbsp;Board 2: ${icards(vb2)}` : ''}. ` : '') + esc(fin ? 'Last chance to change your split.' : V.desc);
  $('.sp-how').textContent = fin ? 'Tap a card, then a card in another row, to swap them. Then show your cards: everyone shows together.' : 'Tap a card, then a card in another row, to swap them. Nothing is locked: you make your final split at the showdown.';
  $('#spLock').textContent = fin ? 'Show my cards' : 'Done';
  renderSplit(); $('#splitOv').hidden = false; $('#splitOv').scrollTop = 0;
  if (!fin) return null;
  return new Promise(res => { splitWait = res; });
}
function renderSplit(){
  const st = spState; if (!st) return;
  const V = st.V;
  $('#spRows').innerHTML = V.parts.map((pt, j) => {
    const h = st.cur[j], beat = vsOne(j, pt.k, h, st.p.all);
    const why = `${pt.k === 'b2' && S.boardVis2 < 2 ? 'Plays with the 2 cards of board 2. ' : ''}Chance to beat one other player here: about ${pc(beat)}.`;
    return `<div class="sprow"><div class="sphead"><b>${esc(pt.label)} · ${pt.n} cards</b><span>${esc(partLabelName(pt.k, h))}</span></div><div class="spcards">${h.map((c, i) => `<button type="button" data-j="${j}" data-i="${i}" class="${st.sel && st.sel[0] === j && st.sel[1] === i ? 'sel' : ''}" aria-label="${cardTxt(c)}">${cardHTML(c)}</button>`).join('')}</div><div class="spwhy">${esc(why)}</div></div>`;
  }).join('');
  $('#spBest').hidden = !settings.hints; $('#spBest').textContent = st.showHint ? 'Hide hint' : 'Hint';
  const cb = $('#spCoach'); cb.hidden = !(settings.hints && st.showHint);
  if (!cb.hidden) cb.innerHTML = `<ul style="margin:0;padding-left:18px">${splitHintLines(st.p, st.k, st.cur).map(l => `<li>${l}</li>`).join('')}</ul><p style="margin:6px 0 0">${esc(splitTip(V))}</p>`;
}
function splitTip(V){
  if (V.parts.length === 3) return 'In 3 Patti a pair, a sequence or three of one suit wins most of the time.';
  if (V.parts.some(x => x.k === 'tp')) return 'In 3 Patti a pair, a sequence or three of one suit wins most of the time. For poker, use the 2 cards that work best with the table.';
  if (V.parts.some(x => x.k === 'h5')) return 'Hand poker has no table cards, so put your pairs and matching suits there; use the 2 cards that work best with the table for poker.';
  return 'Use the 2 cards that work best with board 1, and the 3 that work best with board 2\'s two cards.';
}
$('#spRows').addEventListener('click', e => {
  const b = e.target.closest('button[data-j]'), st = spState; if (!b || !st) return;
  const j = +b.dataset.j, i = +b.dataset.i;
  if (!st.sel || st.sel[0] === j){ st.sel = st.sel && st.sel[0] === j && st.sel[1] === i ? null : [j, i]; renderSplit(); return; }
  const [a, ai] = st.sel, t = st.cur[a][ai]; st.cur[a][ai] = st.cur[j][i]; st.cur[j][i] = t; st.sel = null;
  Snd.cardSlide(0, 0.18); renderSplit();
});
$('#spBest').onclick = () => { const st = spState; if (!st) return; st.showHint = !st.showHint; renderSplit(); };
$('#spLock').onclick = () => {
  const st = spState; if (!st) return;
  const sp = st.cur.map(x => x.slice()); $('#splitOv').hidden = true; spState = null;
  if (st.mode === 'final'){ if (splitWait){ const r = splitWait; splitWait = null; r(sp); } return; }
  if (S && st.p === heroP() && !st.p.splitDone && S.handActive){ st.p.plan = sp; useSplit(st.p, sp); Snd.cardSlide(0, 0.2); render(); }
};
arena.addEventListener('click', e => { if (e.target.closest('.seat.hero .hole')) openArrange(); });
$('#dealOpts').addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (!b || !dealWait) return; $('#dealOv').hidden = true; const r = dealWait; dealWait = null; r(b.dataset.k); });
function gradeSplit(p, s, k){
  const V = VAR(), best = planSplit(p, k);
  const loss = splitValue(best, k, p.all) - splitValue(s, k, p.all);
  const words = V.parts.map((pt, j) => `${pt.label} ${s[j].map(cardTxt).join(' ')}`).join(', ');
  const bw = V.parts.map((pt, j) => `${pt.label} ${best[j].map(cardTxt).join(' ')}`).join(', ');
  const g = loss <= 0.005 || splitKey(s) === splitKey(best) ? {grade: 'great', text: 'You split your cards the strongest way.'}
    : loss <= 0.02 ? {grade: 'good', text: 'A good split, very close to the strongest one.', better: bw}
    : loss <= 0.05 ? {grade: 'fine', cat: 'bad_split', text: 'An okay split, but another one gave you a better chance overall.', better: bw}
    : {grade: 'mistake', cat: 'bad_split', text: 'This split made your hands weaker than they needed to be.', better: bw};
  S.splitDec = {g, words, loss: +loss.toFixed(3)};
}
function setupTable(snap){
  if (pending){ const r = pending.res; pending = null; r({type: 'fold'}); }
  if (reviewWait){ const r = reviewWait; reviewWait = null; r(); }
  if (contWait){ const r = contWait; contWait = null; $('#contRow').hidden = true; r('skip'); }
  if (rebuyWait){ const r = rebuyWait; rebuyWait = null; $('#rebuyOv').hidden = true; r('no'); }
  if (dealWait){ const r = dealWait; dealWait = null; $('#dealOv').hidden = true; r('holdem'); }
  if (splitWait){ const r = splitWait; splitWait = null; r(null); }
  $('#splitOv').hidden = true; spState = null;
  GID++;
  const mode = snap ? (snap.mode || 'tourney') : settings.mode; MONEY = mode === 'home';
  // the engine reads `settings` live (name, opponents, stack, blind level length, practice view, games)
  const r = rosterNow();
  const g = E.newGame({mode, settings, seed: SEED ? SEED + ':' + GID : null, snap: snap || null, ...(mode === 'home' ? {roster: r, heroId: heroIdNow(r)} : {})});
  S = Object.assign(g, {gid: GID, history: [], dec: [], paused: false, pre: null, heroEq: null, snap: null, feed: [], running: false, splitDec: null, hintBest: null, tablesReady: Promise.resolve()});
  bindGame(S, MONEY, settings);
  // the split-game opponent model is built by the compute worker, never on this thread
  const myGid = GID;
  S.tablesReady = MONEY ? compute({type: 'tables', seed: S.rs.seed}).then(t => { if (S && S.gid === myGid) S.tables.adopt(t); }).catch(err => console.error(err)) : Promise.resolve();
  if (snap) S.history = Array.isArray(snap.history) ? snap.history.map(h => { const x = Object.assign({}, h); if (x.review){ x.review = Object.assign({}, x.review); if (!x.review.text) x.review.text = x.text; } return x; }) : [];
  $$('.flyer', arena).forEach(e => e.remove());
  buildSeats(); layout(); render(); renderInfo(); renderHistory(); renderControls(); renderFeed();
  $('#pauseBtn').setAttribute('aria-pressed', 'false');
  makeSnap();
}

/* ================= running a hand: the engine decides, this code animates ================= */
async function aiAction(p){
  // the decision is worked out in the compute worker while the bot "thinks"
  const gid = S.gid, t0 = performance.now(), label = S.rs.label(S.handNo, 'ai');
  const r = await compute({type: 'bot', snap: toPlain(S), seed: S.rs.seed, pi: p.i, label, money: MONEY, settings});
  guard(gid);
  Object.assign(p, r.patch);
  const a = r.action, o = options(p);
  const tt = thinkTime(p, a, o, p._eq == null ? 0.5 : p._eq);
  if (p.persona.slow && tt > 4000 && Math.random() < 0.3) say(p, homeLine(p, 'think', 'hmm...'));
  if (p.persona.quickFold && a.type === 'fold' && o.toCall > S.bb * 2 && Math.random() < 0.15) setTimeout(() => say(p, homeLine(p, 'fold', 'fold')), 300);
  await wait(Math.max(0, tt * SPEED() - (performance.now() - t0)), true);
  return a;
}
// sounds, chips and the feed line for an action the engine has just applied
async function actionFx(p, res){
  const pan = panOf(p);
  if (res.type === 'fold'){ Snd.muck(pan); if (!p.isHuman) muckFly(p); feedPush(`${nm(p)} folded`); return; }
  if (res.type === 'check'){ Snd.knock(pan); feedPush(`${nm(p)} checked`); return; }
  if (res.type === 'call'){ Snd.chipsDown(p.allIn ? 6 : 3, pan); feedPush(`${nm(p)} called ${fmt(res.amt)}${p.allIn ? ' (all-in)' : ''}`); await betFly(p); return; }
  Snd.chipsDown(p.allIn ? 7 : 5, pan);
  const bbx = S.street === 0 ? ` (${+(res.to / S.bb).toFixed(1)} BB)` : '';
  feedPush(res.kind === 'bet' ? `${nm(p)} bet ${fmt(res.to)}${p.allIn ? ' (all-in)' : ''}` : `${nm(p)} raised to ${fmt(res.to)}${bbx}${p.allIn ? ' (all-in)' : ''}`);
  await betFly(p);
}
async function dealHoleCards(order, nDeal){
  const gid = S.gid, fl = [];
  Snd.shuffle(); await wait(1100);
  order.forEach(p => p.vis = 0); render();
  for (let r = 0; r < nDeal; r++) for (const p of order){
    if (r < 2 || r % 2 === 0) Snd.cardSlide(panOf(p), 0.22);
    fl.push(fly(backHTML(), pct(L.pot), ptOf(p.el.querySelector('.hole')), r < 2 ? 320 : 240, 'fcard' + (p.isHuman ? ' hero' : '')).then(() => { if (S.gid === gid){ p.vis = Math.min(nDeal, p.vis + 1); renderSeat(p); } }));
    await wait(r < 2 ? 110 : 45);
  }
  await Promise.all(fl); guard(gid);
  order.forEach(p => p.vis = nDeal); render();
}
async function chipsToPot(se){
  const gid = S.gid;
  if (se.returned) render();
  if (!se.moved.length){ render(); return; }
  await wait(400);
  const potPt = pct(L.pot), fl = se.moved.map(m => fly(chipsHTML(m.amt), pct(L.bets[m.p.seat]), potPt, 420));
  render(); Snd.chipsSlide(Math.min(10, 3 + se.moved.length * 2));
  await Promise.all(fl); guard(gid);
  render();
}
async function payFx(d){
  const gid = S.gid, fl = d.winners.map((w, i) => fly(chipsHTML(d.amounts[i] || w.won), pct(L.pot), ptOf(plateOf(w)), 650));
  await Promise.all(fl); guard(gid);
  d.winners.forEach(w => gainFx(w, w.won));
  if (d.winners.length) Snd.bigPot(panOf(d.winners[0]));
  if (d.noShow){ const w = d.winners[0]; feedPush(`${nm(w)} ${w.isHuman ? 'win' : 'wins'} ${fmt(w.won)}`); }
  render();
}
// After the result: chat (bots tilt in the engine; here they only talk about it)
function chatAfterHand(totalPot){
  const bigPot = totalPot >= S.bb * 15;
  for (const p of S.players){
    if (p.isHuman || p.out || !p.cards.length) continue;
    const lost = p.start - p.stack, pr = p.persona;
    const badBeat = p.eqAtReveal != null && p.eqAtReveal >= 0.65 && p.won === 0;
    if ((lost >= p.start * 0.35 && lost >= S.bb * 10) || badBeat){
      if (p.stack > 0 && Math.random() < pr.chat * 1.6) say(p, homeLine(p, 'lose', pick(p.tilt > 0.5 && pr.tiltProne > 0.5 ? CHAT.tilt : CHAT.lose)));
    }
    if (p.won > 0 && bigPot && Math.random() < pr.chat) say(p, homeLine(p, 'win', pick(CHAT.win)));
    else if (p.won > 0 && !p.hf.sd && p.hf.lastAggSt != null && (p._eq || 1) < 0.35 && Math.random() < pr.chat * 1.4) say(p, homeLine(p, 'bluff', pick(['nice fold', 'ty', 'thx'])));
  }
}
function pickVariant(d, allowed){
  if (MEASURE && window.__force) return Promise.resolve(window.__force);
  if (!d.isHuman) return Promise.resolve(B.pickVariantFor(S, d));
  const offer = allowed ? VAR_ORDER.filter(k => allowed.includes(k)) : VAR_ORDER;
  $('#dealOpts').innerHTML = offer.map(k => `<button type="button" data-k="${k}"${k === 'std' ? ' class="usual"' : ''}><b>${VARIANTS[k].name}${k === 'std' ? ' · your usual' : ''}</b><small>${VARIANTS[k].desc}</small></button>`).join('');
  $('#dealOv').hidden = false;
  setTimeout(() => { const b = $('#dealOpts button'); if (b && !$('#dealOv').hidden) b.focus({preventScroll: true}); }, 50);
  return new Promise(res => { dealWait = res; });
}

async function playHand(){
  const gid = S.gid, hero = heroP(), prevLevel = S.level;
  Object.assign(S, {dec: [], decPending: [], decPre: null, splitDec: null, hintBest: null, heroEq: null, pre: null});
  const flow = E.playHand(S);
  let answer, summary;
  for (;;){
    const r = flow.next(answer); answer = undefined;
    if (r.done){ summary = r.value; break; }
    const s = /** @type {import('../engine/engine').Step} */ (r.value);
    if (s.kind === 'act'){
      const p = s.p;
      S.turnStart = performance.now(); S.turnLen = p.isHuman ? (settings.timer > 0 ? settings.timer * 1000 : 1e12) : 30000; S.warned = false;
      render(); renderControls();
      if (p.isHuman){
        // the coach's full read runs later in the worker (on a Hint, or for the end-of-hand grade)
        const o = options(p), pot = potTotal();
        S.decPre = {snap: toPlain(S), pi: p.i, label: S.rs.label(S.handNo, 'coach'), hint: null};
        answer = await humanAction(p, {need: o.toCall > 0 ? o.toCall / (pot + o.toCall) : 0, pos: posInfo(p), eq: null});
      }
      else answer = await aiAction(p);
    } else if (s.kind === 'variant'){ answer = await pickVariant(s.p); if (answer !== 'holdem') await S.tablesReady; }
    else if (s.kind === 'plans'){
      B.initPlans(S, s.order); render();
      if (!S.tipArr && !hero.out){ S.tipArr = true; toast('Your cards are in the order they were dealt. Tap them to arrange them your way; tap Hint for ideas. Your final split happens at the showdown.', 6000); }
    } else if (s.kind === 'split'){
      if (s.p.isHuman && MEASURE){ const sp = planSplit(s.p, s.k); gradeSplit(s.p, sp, s.k); answer = sp; }
      else if (s.p.isHuman){ const sp = await heroSplit(s.p, s.k, 'final'); if (!sp) throw new Abort(); gradeSplit(s.p, sp, s.k); answer = sp; }
      else answer = B.botFinalSplit(S, s.p, s.k);
    } else if (s.kind === 'practiceView') B.practiceSplits(S);
    else if (s.kind === 'rebuy'){ answer = await askRebuy(); guard(gid); if (answer === 'yes') toast(`You rebought for ${fmt(HOME_BUY)}`); }
    else await pauseFx(s, {hero, prevLevel});
    guard(gid);
  }
  // after the hand: rebuys, busts and new reads
  for (const p of summary.rebought) if (!p.isHuman){ toast(`${p.name} rebuys for ${fmt(HOME_BUY)}`); say(p, pick(['rebuy', 'one more time', 'reload'])); }
  if (summary.busted.length){
    toast(summary.busted.map(p => `${p.isHuman ? 'You' : p.name} finished ${ordinal(p.place)}`).join(' · '));
    summary.busted.filter(p => !p.isHuman && Math.random() < 0.6).forEach(p => say(p, pick(CHAT.bust)));
  }
  makeSnap(); persistTable(); render(); renderInfo(); renderControls();
}

async function pauseFx(s, h){
  const gid = S.gid, d = s.data;
  switch (s.what){
    case 'handStart': {
      S.heroPos = h.hero.out ? null : posInfo(h.hero);
      if (!MONEY && S.level !== h.prevLevel && S.handNo > 1) toast(`Blinds up: ${fmt(S.sb)}/${fmt(S.bb)}${S.ante ? `, ante ${fmt(S.ante)}` : ''}`);
      feedPush(`Hand #${S.handNo} · ${nm(S.players[S.button])} ${S.players[S.button].isHuman ? 'have' : 'has'} the dealer button`);
      renderInfo(); render(); renderControls();
      await wait(500); return;
    }
    case 'variant': {
      const dd = d.d, V0 = VARIANTS[S.variant];
      if (settings.games !== 'holdem'){
        feedPush(`${nm(dd)} ${dd.isHuman ? 'picked' : 'picks'} the game: ${V0.name}`);
        if (!dd.isHuman){ toast(`${dd.name}'s choice: ${V0.name}`, 3200); if (Math.random() < 0.7) say(dd, pick(V0.say)); }
      }
      layout(); renderInfo(); render();
      if (s.ms) await wait(s.ms);
      return;
    }
    case 'antes': {
      const fl = S.players.filter(p => !p.out).map(p => fly(chipsHTML(S.ante), ptOf(plateOf(p)), pct(L.pot), 380));
      Snd.chipsSlide(6); await Promise.all(fl); guard(gid); render(); await wait(250); return;
    }
    case 'blinds': {
      feedPush(`${nm(S.players[S.sbIdx])} posted the small blind ${fmt(S.sb)}, ${nm(S.players[S.bbIdx])} the big blind ${fmt(S.bb)}`);
      Snd.chipsDown(3, panOf(S.players[S.sbIdx])); setTimeout(() => Snd.chipsDown(3, panOf(S.players[S.bbIdx])), 140);
      await Promise.all([betFly(S.players[S.sbIdx]), betFly(S.players[S.bbIdx])]); guard(gid); render();
      await wait(350); return;
    }
    case 'deal': await dealHoleCards(d.order, d.nDeal); renderControls(); await wait(500); return;
    case 'action': {
      await actionFx(d.p, d.res); guard(gid);
      if (d.p.isHuman && S.decPre){
        // keep what the coach needs to grade this decision at the end of the hand
        S.decPending.push({pre: S.decPre.snap, post: toPlain(S), pi: d.p.i, label: S.decPre.label, recLabel: S.rs.label(S.handNo, 'rec'), act: d.res});
        S.decPre = null; S.heroEq = null;
      }
      render(); renderControls(); await wait(s.ms); return;
    }
    case 'board': {
      const names = ['', 'Flop', 'Turn', 'River'];
      S.boardVis = S.board.length - d.n; render(); renderControls();
      streetFlash(names[d.st]);
      await dealBoard(d.n); guard(gid);
      feedPush(`${names[d.st]}: ${S.board.slice(d.st === 1 ? 0 : d.st + 1).map(c => RANKCH[cr(c)] + SUITS[cs(c)]).join(' ')}`);
      return;
    }
    case 'board2': {
      S.boardVis2 = 0;
      for (let j = 0; j < S.board2.length; j++){ await dealBoard2(); guard(gid); }
      feedPush(`Board 2: ${S.board2.map(c => RANKCH[cr(c)] + SUITS[cs(c)]).join(' ')}`);
      return;
    }
    case 'runout': render(); await wait(1600); return;
    case 'streetEnd': await chipsToPot(d); return;
    case 'reveal': {
      feedPush(VAR() ? 'All-in: the rest of the cards come out. Everyone shows after the split' : 'All-in: cards are turned over');
      if (!VAR()) Snd.cardFlip(0);
      render(); renderControls(); await wait(s.ms); return;
    }
    case 'show': {
      const p = d.p, V = VAR();
      feedPush(V ? `${nm(p)} ${p.isHuman ? 'show' : 'shows'} ${V.parts.map((pt, j) => p.pname[j]).join(' + ')}` : `${nm(p)} ${p.isHuman ? 'show' : 'shows'} ${p.handName}`);
      Snd.cardFlip(panOf(p)); render(); await wait(s.ms); return;
    }
    case 'muck': feedPush(`${d.p.name} mucks`); Snd.muck(panOf(d.p)); render(); await wait(s.ms); return;
    case 'pay': await payFx(d); if (s.ms > 650) await wait(s.ms - 650); return;
    case 'practiceView': {
      const hidden = S.players.some(p => p.justShown && !p.isHuman && p.revealed);
      if (hidden){ Snd.cardFlip(0); feedPush('Practice view: everyone\'s cards are face up'); }
      render(); await wait(hidden ? 700 : 200); return;
    }
    case 'handEnd': {
      if (S.msg) feedPush(S.msg);
      chatAfterHand(d.totalPot);
      const hero = h.hero;
      if (S.decPending.length){
        try { S.dec = await compute({type: 'grade', seed: S.rs.seed, money: MONEY, settings, items: S.decPending}); } catch (err){ console.error(err); S.dec = []; }
        guard(gid);
      }
      let review = null; try { review = hero.out && !S.dec.length ? null : buildReview(d.totalPot); } catch (err){ console.error(err); }
      S.history.unshift({no: S.handNo, blinds: `${fmt(S.sb)}/${fmt(S.bb)}`, text: S.hist.join('\n'), net: hero.out && !S.dec.length ? null : hero.stack - hero.start, review});
      if (S.history.length > 80) S.history.length = 80;
      renderHistory(); renderInfo(); renderControls();
      if (review){ try { recordProgress(review); } catch (err){ console.error(err); } }
      if (S.online){
        // the online table moves on by itself: the review waits in the hand history
        if (review && wantsReview(review)) toast('Hand review saved: open the hand history to see it.', 2600);
        return;
      }
      // save the table now, before the result screen waits for you, so leaving here never loses this hand
      try { saveAfterHand(); } catch (err){ console.error(err); }
      await endOfHand(review, review && wantsReview(review));
      return;
    }
    default: if (s.ms) await wait(s.ms);
  }
}

async function runLoop(){
  const gid = S.gid; S.running = true;
  renderControls();
  try {
    for (;;){
      guard(gid);
      while (S.paused){ renderControls(); await wait(250, true); }
      if (MONEY && S.cashOutReq){ showSession(); return; }
      // after a resume, anyone who ended the last hand with no chips rebuys first
      if (MONEY){
        for (const p of S.players.filter(x => !x.isHuman && x.stack <= 0)){ p.stack = HOME_BUY; p.buyins++; toast(`${p.name} rebuys for ${fmt(HOME_BUY)}`); }
        const hero = heroP();
        if (hero.stack <= 0){ const c = await askRebuy(); guard(gid); if (c === 'yes'){ hero.stack = HOME_BUY; hero.buyins++; toast(`You rebought for ${fmt(HOME_BUY)}`); } else { showSession(); return; } }
        render();
      }
      await playHand();
      if (checkEnd()) return;
      await wait(900);
    }
  } catch (e) { if (!(e instanceof Abort)){ console.error(e); toast('Something went wrong with that hand. Start a new table from settings.'); } }
}

function askRebuy(){
  const net = -heroP().buyins * HOME_BUY;
  $('#rebuyTxt').textContent = `You have bought in ${heroP().buyins} time${heroP().buyins > 1 ? 's' : ''} (${fmt(-net)} total). Rebuy for another ${fmt(HOME_BUY)} or cash out and see how everyone did.`;
  $('#rebuyOv').hidden = false;
  return new Promise(res => { rebuyWait = res; });
}
let rebuyWait = null;
function rebuyChoice(c){ $('#rebuyOv').hidden = true; if (rebuyWait){ const r = rebuyWait; rebuyWait = null; r(c); } }
function showSession(){
  clearTable();
  const P = S.players.map(p => ({name: p.isHuman ? p.name + ' (you)' : p.name, buy: p.buyins * HOME_BUY, stack: p.stack, net: p.stack - p.buyins * HOME_BUY, type: p.type})).sort((a, b) => b.net - a.net);
  const hero = heroP(), net = hero.stack - hero.buyins * HOME_BUY;
  prof.sessions = (prof.sessions || []).concat({ts: Date.now(), net, hands: S.handNo, buyins: hero.buyins}).slice(-50); saveLocal(PKEY, prof);
  dbWrite(() => DBX.db.doc('players/' + DBX.uid).set(Object.assign({}, prof, {name: settings.name || 'You', updatedAt: Date.now()})));
  $('#endEyebrow').textContent = `Home game · ${S.handNo} hands · Blinds ${fmt(S.sb)}/${fmt(S.bb)}`;
  $('#endPlace').textContent = (net > 0 ? '+' : '') + fmt(net);
  $('#endTitle').textContent = net > 0 ? 'You finished up for the night' : net < 0 ? 'You finished down for the night' : 'You broke even';
  $('#endPrize').textContent = `You bought in ${hero.buyins} time${hero.buyins > 1 ? 's' : ''} (${fmt(hero.buyins * HOME_BUY)}) and cashed out ${fmt(hero.stack)}.`;
  const st = S.stats, h = Math.max(1, st.hands);
  $('#endStats').innerHTML = [[st.hands, 'Hands'], [st.won, 'Pots won'], [fmt(st.biggest), 'Biggest pot'], [pc(st.vpip / h), 'Played'], [pc(st.pfr / h), 'Raised first'], [`${st.sdWon}/${st.sd}`, 'Showdowns won']].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  $('#endWho').innerHTML = '<div class="eyebrow" style="text-align:center">Cash-out sheet</div>' + P.map(r => `<div><b>${esc(r.name)}</b>: bought in ${fmt(r.buy)}, cashed out ${fmt(r.stack)}, <b style="color:${r.net > 0 ? 'var(--g-great)' : r.net < 0 ? 'var(--g-mistake)' : 'var(--ink)'}">${r.net > 0 ? '+' : ''}${fmt(r.net)}</b></div>`).join('');
  $('#againBtn').textContent = 'New session';
  $('#endOv').hidden = false;
}
function checkEnd(){
  if (MONEY){ if (S.cashOutReq){ showSession(); return true; } return false; }
  const hero = heroP(), alive = S.players.filter(p => !p.out);
  if (hero.out){ showEnd(hero.place); return true; }
  if (alive.length === 1){ hero.place = 1; showEnd(1); return true; }
  return false;
}
// the table right after a hand is paid, as it will look at the start of the next one
function saveAfterHand(){
  if (!S || !S.running) return;
  const hero = heroP();
  if (!MONEY){
    const alive = S.players.filter(p => !p.out && p.stack > 0);
    if (hero.stack <= 0 || alive.length <= 1) return;   // the tournament is ending; the normal end screen handles it
  }
  makeSnap();
  if (!MONEY){
    const busted = S.players.filter(p => !p.out && p.stack <= 0).sort((a, b) => b.start - a.start), remaining = S.players.filter(p => !p.out && p.stack > 0).length;
    busted.forEach((p, j) => { const sp = S.snap.players.find(x => x.seat === p.seat); if (sp){ sp.out = true; sp.place = remaining + 1 + j; } });
  }
  persistTable();
}
function makeSnap(){
  if (!S) return;
  S.snap = { mode: S.mode, handNo: S.handNo, button: S.button, tableNo: S.tableNo, stats: Object.assign({}, S.stats),
    players: S.players.map(p => ({seat: p.seat, name: p.name, type: p.type, color: p.color, stack: p.stack, out: p.out, place: p.place, buyins: p.buyins, avatar: p.avatar, hud: Object.assign({}, p.hud), read: !!p.read, mem: p.mem || null})),
    // your recent hands, so the history (and reviews) are still there after a resume; kept small
    history: S.history.slice(0, 12).map(h => Object.assign({}, h, {review: h.review ? Object.assign({}, h.review, {text: '', ai: ''}) : null})) };
}
// Save the table after every hand: in this browser and in your account, so another device can resume it.
function persistTable(){
  if (!S || S.online || !S.running || !S.snap || !S.handNo) return;
  const d = JSON.parse(JSON.stringify(Object.assign({}, S.snap, {ts: Date.now(), perLevel: settings.perLevel, done: false})));
  saveLocal('river-room-table', d);
  dbWrite(() => DBX.db.doc('players/' + DBX.uid + '/state/table').set(d));
}
function clearTable(){
  const d = {done: true, ts: Date.now()};
  saveLocal('river-room-table', d); resumeSnap = null;
  dbWrite(() => DBX.db.doc('players/' + DBX.uid + '/state/table').set(d));
}

/* ================= hand review ================= */
let reviewWait = null, contWait = null;
let contMsg = '';
function waitForContinue(label, allowSkip, msg){
  $('#contBtn').textContent = label; $('#contSkip').hidden = !allowSkip; contMsg = msg || '';
  return new Promise(res => { contWait = res; renderControls(); setTimeout(() => { if (contWait) $('#contBtn').focus({preventScroll: true}); }, 50); });
}
function doContinue(choice){ if (!contWait) return; const r = contWait; contWait = null; $('#contRow').hidden = true; renderControls(); r(choice || 'primary'); }
async function endOfHand(review, reviewNow){
  const gid = S.gid, held = settings.holdResult && S.history[0] && S.history[0].net !== null;
  let step = 'table';
  if (held) await wait(700);
  else { await wait(reviewNow ? 2400 : settings.revealAll ? 4500 : 2200); step = reviewNow ? 'review' : 'done'; }
  for (;;){
    guard(gid);
    if (step === 'table'){ const c = await waitForContinue(reviewNow ? 'See hand review' : 'Next hand', reviewNow); step = c === 'primary' && reviewNow ? 'review' : 'done'; }
    else if (step === 'review'){ const r = await showReview(review, true); step = r === 'back' ? 'table' : 'done'; }
    else break;
  }
  guard(gid);
}
function storyLines(){
  // event payloads differ by type (cards, parts, list...), so they are read loosely here
  const evs = /** @type {any[]} */ (S.ev);
  const hero = heroP(), lines = [], streets = ['Preflop', 'Flop', 'Turn', 'River', 'Showdown'];
  const by = [[], [], [], [], []];
  for (const e of evs) by[Math.min(4, e.st)].push(e);
  const phrase = e => {
    const who = nm(e.p), you = e.p.isHuman;
    switch (e.t){
      case 'fold': return `${who} folded`;
      case 'check': return `${who} checked`;
      case 'call': return `${who} called ${fmt(e.amt)}${e.allIn ? ' (all-in)' : ''}`;
      case 'bet': return `${who} bet ${fmt(e.to)}${e.allIn ? ' (all-in)' : ''}`;
      case 'raise': return `${who} raised to ${fmt(e.to)}${e.allIn ? ' (all-in)' : ''}`;
      case 'ret': return `${you ? 'Your' : who + "'s"} extra ${fmt(e.amt)} came back because nobody called it`;
      default: return '';
    }
  };
  const join = arr => { const out = []; let folds = [];
    const flush = () => { if (folds.length){ out.push(folds.length === 1 ? `${folds[0]} folded` : `${folds.slice(0, -1).join(', ')} and ${folds[folds.length - 1]} folded`); folds = []; } };
    for (const e of arr){ if (!e.p) continue; if (e.t === 'fold'){ folds.push(nm(e.p)); continue; } flush(); const s = phrase(e); if (s) out.push(s); }
    flush(); return out.join('. ') + (out.length ? '.' : ''); };
  if (!hero.out){
    const hp = S.heroPos;
    const V = VAR();
    const intro = V && hero.all.length ? `Game: ${esc(V.name)}. You were ${hp ? hp.name : 'at the table'} with ${icards(hero.all)}.` : `You were ${hp ? hp.name : 'at the table'} with ${icards(hero.cards)} (${esc(holeName(hero.cards[0], hero.cards[1]))}).`;
    lines.push(['Preflop', `${intro} Blinds ${fmt(S.sb)}/${fmt(S.bb)}. ` + esc(join(by[0].filter(e => e.t !== 'post' && e.t !== 'dealt')))]);
  }
  for (let st = 1; st <= 3; st++){
    const b = by[st].find(e => e.t === 'board'); if (!b) continue;
    const bc = b.cards; let made = '';
    if (!hero.folded && !hero.out && hero.cards.length) made = ` You had ${esc(describe(evaluate(hero.cards.concat(bc))))}${VAR() ? ' in the poker part' : ''}.`;
    const acts = by[st].filter(e => e.t !== 'board' && e.t !== 'reveal' && e.t !== 'board2');
    const newCards = st === 1 ? bc : [bc[bc.length - 1]];
    const b2e = by[st].find(e => e.t === 'board2');
    const b2t = b2e ? ` Board 2: ${icards(b2e.cards)}.` : '';
    lines.push([streets[st], `${icards(newCards)}${st > 1 ? ` (board ${icards(bc)})` : ''}.${b2t}${made} ${acts.length ? esc(join(acts)) : (S.revealed ? 'Everyone was all-in, so no more betting.' : '')}`]);
  }
  const sd = evs.filter(e => ['show', 'muck', 'win'].includes(e.t));
  if (sd.length){
    const parts = sd.map(e => e.t === 'show' ? (e.parts ? `${esc(nm(e.p))} showed ${e.parts.map(x => `${esc(x.label)} ${icards(x.cards)} (${esc(x.name)})`).join(', ')}` : `${esc(nm(e.p))} showed ${icards(e.cards)}: ${esc(e.name)}`) : e.t === 'muck' ? `${esc(e.p.name)} threw away (mucked) a losing hand` : `${esc(nm(e.p))} won ${fmt(e.amt)}${e.part ? ` for ${esc(e.part)} (${esc(e.name)})` : ''}${e.label && e.label !== 'pot' ? ' from the ' + e.label : ''}${e.noShow ? ' without showing, because everyone else folded' : ''}`);
    lines.push([sd.some(e => e.t === 'show') ? 'Showdown' : 'Result', parts.join('. ') + '.' + (S.explain ? ` Why: ${esc(S.explain)}.` : '')]);
  }
  const allE = evs.find(e => e.t === 'all');
  if (allE) lines.push(['All cards', allE.list.filter(x => !x.p.isHuman).map(x => `${esc(x.p.name)} ${icards(x.cards)} ${x.folded ? `folded, would have had ${esc(x.name)}` : esc(x.name) + (x.mucked ? ' (mucked)' : '')}${x.extra ? ', ' + x.extra.map(y => `${esc(y.label)} ${icards(y.cards)} (${esc(y.name)})`).join(', ') : ''}`).join('; ') + '.']);
  return lines;
}
function readTip(){
  const evs = /** @type {any[]} */ (S.ev);
  const allE = evs.find(e => e.t === 'all'), winE = evs.find(e => e.t === 'win' && e.noShow);
  if (allE && winE && !winE.p.isHuman){
    const p = winE.p, lastAgg = evs.filter(x => x.p === p && (x.t === 'bet' || x.t === 'raise')).pop();
    if (lastAgg){
      const at = evs.filter(x => x.t === 'board' && x.st <= lastAgg.st).pop(), bb = at ? at.cards : [];
      const mi = bb.length >= 3 ? madeInfo(p.cards, bb) : null, di = bb.length >= 3 ? drawInfo(p.cards, bb) : {};
      const hn = mi ? mi.name : holeName(p.cards[0], p.cards[1]);
      const weak = mi ? !mi.improves : handPct(p.cards[0], p.cards[1]) > 0.35;
      const known = p.read ? ` Your read on ${p.name}: ${TYPES[p.type].label.toLowerCase()}.` : '';
      if (weak) return `${p.name} won by betting with only ${hn}${di.fd || di.sd ? ' plus a draw' : ''}. That bet was a bluff${di.fd || di.sd ? ' (a "semi-bluff", since they could still improve)' : ''}, and it worked because everyone folded. Note it: this player will bluff.${known}`;
      return `${p.name} had ${hn} when they bet, so folding against that bet was reasonable.${known}`;
    }
  }
  const shown = evs.filter(e => e.t === 'show' && !e.p.isHuman);
  for (const e of shown){
    const p = e.p, acts = evs.filter(x => x.p === p && x.st >= 1);
    const aggro = acts.some(x => x.t === 'bet' || x.t === 'raise'), calls = acts.filter(x => x.t === 'call').length;
    const sc = evaluate(p.cards.concat(S.board)), cat = catOf(sc), bcat = catOf(evaluate(S.board));
    const weak = cat <= bcat || cat === 0;
    const known = p.read ? ` Your read on ${p.name}: ${TYPES[p.type].label.toLowerCase()}. ${TYPES[p.type].beat}` : '';
    if (aggro && weak) return `${p.name} bet without a real hand: that was a bluff. Remember it: players who bluff once will do it again, so call them down a little lighter.${known}`;
    if (calls >= 2 && cat <= 1) return `${p.name} called ${calls} bets with only ${describe(sc)}. Players who call this much are hard to bluff, but they pay off your strong hands. Bet big when you have it.${known}`;
    if (aggro && cat >= 2) return `${p.name} bet and had ${describe(sc)}. When this player bets strongly, they often have it.${known}`;
  }
  const pf = S.pfAggressor;
  if (pf && !pf.isHuman && pf.read) return `${pf.name} plays like a ${TYPES[pf.type].label.toLowerCase()}: ${TYPES[pf.type].desc} ${TYPES[pf.type].beat}`;
  return '';
}
function buildReview(totalPot){
  const hero = heroP(), net = hero.stack - hero.start;
  const decs = S.dec.map(d => ({street: ['Preflop', 'Flop', 'Turn', 'River'][d.ctx.st], words: actWords(d.act, d.ctx), hand: d.ctx.made ? (d.ctx.parts ? 'poker part ' : '') + d.ctx.made.name : d.ctx.hn, g: d.g, eq: d.ctx.eq, need: d.ctx.need, why: d.rec.why,
    raw: {st: d.ctx.st, pos: d.ctx.pos.label, pot: d.ctx.pot, toCall: d.ctx.toCall, eq: +d.ctx.eq.toFixed(3), need: +d.ctx.need.toFixed(3), act: d.act.type, to: d.act.to || 0, rec: d.rec.act, grade: d.g.grade, cat: d.g.cat || ''}}));
  const V = VAR(), sp = S.splitDec;
  if (sp) decs.unshift({street: 'Split', words: 'split your cards: ' + sp.words, hand: '', g: sp.g, eq: 0, need: 0, why: sp.g.text, raw: {st: -1, act: 'split', split: sp.words, loss: sp.loss, grade: sp.g.grade, cat: sp.g.cat || ''}});
  const worst = (sp ? [{g: sp.g}] : []).concat(S.dec).sort((a, b) => GRADE_SCORE[a.g.grade] - GRADE_SCORE[b.g.grade])[0];
  let lesson;
  if (worst && worst.g.cat && GRADE_SCORE[worst.g.grade] < 0.7) lesson = LESSONS[worst.g.cat];
  else if (S.dec.length) lesson = `Well played. ${CONCEPTS[S.handNo % CONCEPTS.length]}`;
  else lesson = CONCEPTS[S.handNo % CONCEPTS.length];
  const result = hero.folded ? (net < 0 ? `You folded and lost ${fmt(-net)}` : 'You folded') : net > 0 ? `You won ${fmt(hero.won)}` : net < 0 ? `You lost ${fmt(-net)}` : 'You broke even';
  return {no: S.handNo, blinds: `${fmt(S.sb)}/${fmt(S.bb)}`, net, result, story: storyLines(), decs, lesson, read: readTip(), game: V ? V.name : '', gameDesc: V ? V.desc : '',
    hole: (V && hero.all.length ? hero.all : hero.cards).map(cardTxt).join(''), board: S.board.map(cardTxt).join(' '), pos: S.heroPos ? (SEATSHORT[S.heroPos.key] || S.heroPos.label).toLowerCase() : '', text: S.hist.join('\n'),
    played: S.vpip || !!hero.hf.sawFlop || S.dec.some(d => GRADE_SCORE[d.g.grade] < 0.7), ts: Date.now(), pot: totalPot};
}
function wantsReview(r){ if (settings.review === 'off') return false; if (settings.review === 'all') return true; return r.played; }
function showReview(r, blocking){
  $('#rvEyebrow').textContent = `Hand #${r.no}${r.game ? ' · ' + r.game : ''} · Blinds ${r.blinds}${r.pos ? ' · Your seat: ' + r.pos : ''}`;
  $('#rvTitle').textContent = r.result;
  const ne = $('#rvNet'); ne.textContent = r.net > 0 ? '+' + fmt(r.net) : r.net < 0 ? '−' + fmt(-r.net) : '±0'; ne.className = 'rv-net ' + (r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : '');
  $('#rvStory').innerHTML = r.story.map(([s, t]) => `<li><b>${s}</b><span>${t}</span></li>`).join('');
  $('#rvDecWrap').hidden = !r.decs.length;
  $('#rvDec').innerHTML = r.decs.map(d => `<div><div class="dh"><span class="grade g-${d.g.grade}">${GRADE_LABEL[d.g.grade]}</span><span>${d.street}: you ${esc(d.words)}${d.hand ? ' with ' + esc(d.hand) : ''}</span></div><p>${esc(d.g.text)}</p>${d.g.better && GRADE_SCORE[d.g.grade] < 1 ? `<p class="better">Better: ${esc(d.g.better)}.</p>` : ''}${GRADE_SCORE[d.g.grade] < 0.7 ? `<p>${esc(d.why)}</p>` : ''}</div>`).join('');
  $('#rvLesson').textContent = r.lesson;
  $('#rvReadWrap').hidden = !r.read; $('#rvRead').textContent = r.read;
  $('#rvAiWrap').hidden = !r.ai; if (r.ai) $('#rvAi').innerHTML = mdLite(r.ai);
  showAiModel(r.aiModel);
  $('#rvNext').textContent = blocking ? 'Next hand' : 'Close';
  // a hand reviewed by the server's AI coach is cached, so asking again would give the same answer
  $('#rvAsk').hidden = !sampleFn && (serverReviewOff || !!r.ai); $('#rvAsk').disabled = false; $('#rvAsk').textContent = r.ai ? 'Ask the AI coach again' : 'Ask the AI coach';
  segment($('#rvSeg'), [['all', 'Every hand'], ['played', 'Hands I played'], ['off', 'Off']], () => settings.review, v => { settings.review = v; saveSettings(); });
  revCurrent = r;
  const ov = $('#revOv'); ov.hidden = false; ov.scrollTop = 0;
  setTimeout(() => $('#rvNext').focus(), 50);
  if (!blocking) return Promise.resolve();
  return new Promise(res => { reviewWait = res; });
}
let revCurrent = null, revCtl = null;
function closeReview(res){ $('#revOv').hidden = true; if (revCtl){ revCtl.abort(); revCtl = null; } if (reviewWait){ const r = reviewWait; reviewWait = null; r(res || 'next'); } }
function mdLite(t){
  const blocks = esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split(/\n{2,}/);
  return blocks.map(b => /^\s*[-•]\s/m.test(b) ? '<ul>' + b.split('\n').filter(x => x.trim()).map(x => `<li>${x.replace(/^\s*[-•]\s*/, '')}</li>`).join('') + '</ul>' : `<p>${b.replace(/\n/g, '<br>')}</p>`).join('');
}
function playersBrief(){ return S.players.filter(p => !p.isHuman).map(p => `${p.name}: ${TYPES[p.type].label} (${TYPES[p.type].desc})`).join('\n'); }
// Off the claude.ai host: the AI review comes from this site's own /api/review route
// (OpenRouter, free models first). Reviews are cached on this device by the same key the
// server uses, so reopening a reviewed hand never calls a model again.
let serverReviewOff = false;
const reviewMarkdown = v => `**Grade:** ${GRADE_LABEL[v.grade] || v.grade}\n\n${v.mistake ? `**Biggest mistake:** ${v.mistake}\n\n` : '**Biggest mistake:** none. Every decision was reasonable.\n\n'}**What to remember:** ${v.lesson}`;
const AI_CACHE = 'river-room-ai-reviews', AI_CACHE_MAX = 100;
function aiCacheGet(key){ const all = loadLocal(AI_CACHE, {}) || {}; return all[key] || null; }
function aiCachePut(key, entry){
  const all = loadLocal(AI_CACHE, {}) || {};
  all[key] = {...entry, at: Date.now()};
  const keys = Object.keys(all).sort((a, b) => all[a].at - all[b].at);
  while (keys.length > AI_CACHE_MAX) delete all[keys.shift()];
  saveLocal(AI_CACHE, all);
}
/** Small line under the review: which model wrote it. */
function showAiModel(m){
  const el = $('#rvAiModel');
  el.hidden = !m;
  if (m) el.textContent = `Reviewed by ${m.model} (${m.paid ? 'paid' : 'free'} model)${m.saved ? ', saved on this device' : ''}`;
}
async function serverReview(r){
  const btn = $('#rvAsk'), out = $('#rvAi');
  $('#rvAiWrap').hidden = false; showAiModel(null); out.textContent = 'The AI coach is reviewing this hand…'; btn.disabled = true;
  const note = (reason, retryAfter) => {
    const coach = ' The review above is from the app\'s own coach.';
    if (reason === 'not_configured'){ serverReviewOff = true; btn.hidden = true; out.textContent = 'AI reviews are not set up on this site yet.' + coach; return; }
    out.textContent = reason === 'rate_limited' ? `Too many reviews in a short time. Try again in ${retryAfter || 60} seconds.` + coach
      : reason === 'paid_cap' ? 'The free AI models are busy and today\'s limit for the paid one is used up.' + coach
      : reason === 'network' && !navigator.onLine ? 'You are offline, so the AI coach cannot review this hand.' + coach
      : 'The AI coach could not finish this review.' + coach;
  };
  const done = (review, m) => { r.ai = reviewMarkdown(review); r.aiModel = m; out.innerHTML = mdLite(r.ai); showAiModel(m); btn.hidden = true; };
  revCtl = new AbortController();
  try {
    const body = {hand: r.text.slice(0, 8000), decisions: r.decs.map(d => d.raw).slice(0, 20), money: MONEY, ...(r.game ? {game: r.game.slice(0, 80), gameDesc: (r.gameDesc || '').slice(0, 600)} : {})};
    const key = await reviewKey(body);
    const saved = aiCacheGet(key);
    if (saved){ done(saved.review, {model: saved.model, paid: saved.paid, saved: true}); return; }
    const res = await fetch('/api/review', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: revCtl.signal});
    if (!res.ok){ const j = await res.json().catch(() => ({})); note(j.reason, j.retryAfter); return; }
    let n = 0, asking = '';
    const ev = await readReviewEvents(res,
      t => { n += t.length; out.textContent = `The AI coach is reviewing this hand${asking}… (${n} characters so far)`; },
      model => { n = 0; asking = ` (asking ${model})`; out.textContent = `The AI coach is reviewing this hand${asking}…`; });
    if (ev.review){ done(ev.review, {model: ev.model, paid: !!ev.paid}); aiCachePut(key, {review: ev.review, model: ev.model, paid: !!ev.paid}); }
    else note(ev.fallback);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    note('network');
  } finally { btn.disabled = false; revCtl = null; }
}
async function askClaudeReview(){
  const r = revCurrent; if (!r) return;
  if (!sampleFn) return serverReview(r);
  const btn = $('#rvAsk'), out = $('#rvAi');
  $('#rvAiWrap').hidden = false; out.textContent = 'Thinking…'; btn.disabled = true;
  revCtl = new AbortController();
  const prompt = `You are a friendly, expert poker coach helping a beginner become a strong No-Limit Texas Hold'em player. They are practicing ${MONEY ? 'their real friendly home cash game ($10 buy-in, blinds $0.10/$0.20, everyone tends to just call before the flop and bets small) against computer versions of their friends' : 'in a Sit & Go tournament against computer players'}.

Opponent styles (for your understanding only; refer to them by behaviour the student could notice, and do not reveal the labels):
${playersBrief()}

${r.game ? `This hand was a dealer's choice home game, not plain Hold'em. Game: ${r.game}. Rules: ${r.gameDesc} 3 Patti ranks: Trail (three of a kind) > Pure sequence (3 in a row, same suit) > Sequence > Color (same suit) > Pair > High card; A-K-Q is the top sequence, then A-2-3. The "split" decision is how the student divided their cards between the parts.\n\n` : ''}Hand history (the student is "${settings.name || 'You'}"):
${r.text}

The app's own analysis of each student decision (eq = estimated win chance against the opponents' likely hands, need = pot odds needed to call):
${JSON.stringify(r.decs.map(d => d.raw))}

Write a coaching review in very simple, encouraging English for a complete beginner who does not know poker terms. Use short sentences and everyday words; if you must use a poker word, explain it in a few words. Use these bold labels, each a short paragraph:
**What happened:** 2-3 sentences.
**Your decisions:** go through each decision in order: say if it was right, why, and what a strong player would do. Explain any poker term you use in a few words.
**What to remember:** one concrete habit to practice next.
Keep it under 260 words. No headings other than the bold labels.`;
  try {
    const {text} = await sampleFn(prompt, {signal: revCtl.signal, onText: ({text}) => { out.innerHTML = mdLite(text); }});
    r.ai = text; out.innerHTML = mdLite(text); btn.textContent = 'Ask the AI coach again';
  } catch (e) {
    if (e && e.code === 'cancelled') return;
    const msg = {not_granted: 'Claude coaching is not allowed for this page. You can still use the built-in review above.', rate_limited: 'Too many requests right now. Try again in a minute.', sampling_disabled: 'Claude is not available on this account.'}[e && e.code];
    out.textContent = (e && e.text ? e.text + '\n\n' : '') + (msg || 'Claude could not finish the review. Try again.');
    if (e && (e.code === 'not_granted' || e.code === 'sampling_disabled')) btn.hidden = true;
  } finally { btn.disabled = false; revCtl = null; }
}

/* ================= progress (saved for you and for Claude) ================= */
const PKEY = 'river-room-progress';
const blankProf = () => ({hands: 0, vpip: 0, pfr: 0, threeOpp: 0, three: 0, cbetOpp: 0, cbet: 0, agg: 0, calls: 0, sawFlop: 0, wtsd: 0, wsd: 0, fcbOpp: 0, fcb: 0,
  dec: {great: 0, good: 0, fine: 0, mistake: 0, blunder: 0}, leaks: {}, recent: [], mistakes: [], tournaments: [], net: 0});
let prof = Object.assign(blankProf(), loadLocal(PKEY, {}));
let DBX = null, sampleFn = null, wq = Promise.resolve();
function dbWrite(fn){ if (!DBX) return; wq = wq.then(fn).catch(e => { if (e && e.code === 'quota_exceeded') toast('Saved-hand storage is full, so new hands are not being saved.'); }); }
function recordProgress(r){
  const hero = heroP(), f = hero.hf;
  prof.hands++; if (f.vpip) prof.vpip++; if (f.pfr) prof.pfr++; if (f.threeOpp) prof.threeOpp++; if (f.three) prof.three++;
  if (f.cbetOpp) prof.cbetOpp++; if (f.cbet) prof.cbet++; if (f.sawFlop) prof.sawFlop++; if (f.sawFlop && f.sd) prof.wtsd++; if (f.wsd) prof.wsd++;
  if (f.fcbSeen){ prof.fcbOpp++; if (f.fcbFold) prof.fcb++; }
  prof.agg += S.dec.filter(d => d.ctx.st > 0 && d.act.type === 'raise').length;
  prof.calls += S.dec.filter(d => d.ctx.st > 0 && d.act.type === 'call').length;
  prof.net += r.net;
  for (const d of r.decs){
    prof.dec[d.g.grade]++;
    if (d.g.cat && GRADE_SCORE[d.g.grade] < 0.7) prof.leaks[d.g.cat] = (prof.leaks[d.g.cat] || 0) + 1;
    prof.recent.push(GRADE_SCORE[d.g.grade]);
    if (GRADE_SCORE[d.g.grade] < 0.7) prof.mistakes.push({hand: r.no, ts: r.ts, street: d.street, did: d.words, with: d.hand, grade: d.g.grade, why: d.g.text});
  }
  if (prof.recent.length > 300) prof.recent = prof.recent.slice(-300);
  if (prof.mistakes.length > 40) prof.mistakes = prof.mistakes.slice(-40);
  saveLocal(PKEY, prof);
  const doc = {ts: r.ts, table: S.tableNo, hand: r.no, game: r.game || 'Hold\'em', blinds: r.blinds, pos: r.pos, hole: r.hole, board: r.board, net: r.net, result: r.result,
    decisions: r.decs.map(d => d.raw), lesson: r.lesson, history: r.text.slice(0, 6000)};
  dbWrite(() => DBX.db.collection('players/' + DBX.uid + '/hands').doc(r.ts + '-' + r.no).set(doc));
  dbWrite(() => DBX.db.doc('players/' + DBX.uid).set(Object.assign({}, prof, {name: settings.name || 'You', updatedAt: Date.now()})));
}
function recordTournament(place){
  prof.tournaments.push({ts: Date.now(), place, of: S.entrants, hands: S.handNo});
  if (prof.tournaments.length > 50) prof.tournaments = prof.tournaments.slice(-50);
  saveLocal(PKEY, prof);
  dbWrite(() => DBX.db.doc('players/' + DBX.uid).set(Object.assign({}, prof, {name: settings.name || 'You', updatedAt: Date.now()})));
}
function skill(){
  const r = prof.recent.slice(-150); if (r.length < 20) return null;
  const s = r.reduce((a, x) => a + x, 0) / r.length;
  const lv = s < 0.6 ? 'Beginner' : s < 0.72 ? 'Learning' : s < 0.82 ? 'Solid' : s < 0.9 ? 'Strong' : 'Pro-level decisions';
  return {s, lv, n: r.length};
}
function renderProgress(){
  const P = prof, h = Math.max(1, P.hands), sk = skill();
  const rate = (a, b) => b ? a / b : null;
  /** @type {Array<[string, number, [number, number], string, boolean?]>} */
  const rows = [
    ['VPIP', rate(P.vpip, P.hands), [0.2, 0.3], 'How often you put money in before the flop. Under 20% is very tight, over 30% is loose for a 6-player table.'],
    ['PFR', rate(P.pfr, P.hands), [0.15, 0.25], 'How often you raise before the flop. Strong players raise most hands they play.'],
    ['3-bet', rate(P.three, P.threeOpp), [0.05, 0.11], 'How often you re-raise when someone has already raised.'],
    ['C-bet', rate(P.cbet, P.cbetOpp), [0.5, 0.75], 'How often you bet the flop after raising before it.'],
    ['Aggression', P.calls ? P.agg / P.calls : (P.agg ? 3 : null), [1.8, 4], 'Bets and raises divided by calls after the flop. Winning players bet and raise more than they call.', true],
    ['Went to showdown', rate(P.wtsd, P.sawFlop), [0.24, 0.34], 'How often you show cards after seeing the flop. Too high means you call down too much.'],
    ['Won at showdown', rate(P.wsd, P.wtsd), [0.5, 1], 'When you show your cards, how often you win.']
  ];
  const status = (v, [lo, hi]) => v == null ? '<span class="pill" style="color:var(--muted)">Not enough hands</span>' : v < lo ? '<span class="pill" style="color:var(--g-fine)">Low</span>' : v > hi ? '<span class="pill" style="color:var(--g-fine)">High</span>' : '<span class="pill" style="color:var(--g-great)">On target</span>';
  const fmtv = (v, ratio) => v == null ? '—' : ratio ? v.toFixed(1) : pc(v);
  const leaks = Object.entries(P.leaks).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const LEAKNAME = {tight_pre: 'Folding good hands before the flop', loose_pre: 'Playing too many hands', limp: 'Limping instead of raising', call_no_odds: 'Calling without the right price', overfold: 'Folding too much when the price is good', missed_value: 'Not betting strong hands', bluff_multi: 'Bluffing into several players', passive: 'Calling when you should raise', risky_allin: 'Risky all-ins', sizing_small: 'Bets too small', free_fold: 'Folding when checking was free'};
  const totalDec = Object.values(P.dec).reduce((a, b) => a + b, 0);
  $('#progBody').innerHTML = `
    <h3>Decision quality</h3>
    ${sk ? `<div class="meter"><i style="width:${Math.round(sk.s * 100)}%"></i></div><div class="lvl"><span>Beginner</span><span>Learning</span><span>Solid</span><span>Strong</span><span>Pro</span></div><p>Level: <b style="color:var(--win)">${sk.lv}</b>. Based on your last ${sk.n} decisions graded by the coach (${pc(sk.s)} decision score).</p>` : `<p>Play a few more hands. Your level shows after 20 graded decisions (you have ${prof.recent.length}).</p>`}
    <div class="stats"><div class="stat"><b>${num(P.hands)}</b><span>Hands</span></div><div class="stat"><b>${totalDec ? pc((P.dec.great + P.dec.good) / totalDec) : '—'}</b><span>Good decisions</span></div><div class="stat"><b>${P.tournaments.length ? P.tournaments.filter(t => t.place === 1).length + '/' + P.tournaments.length : '—'}</b><span>Tournaments won</span></div></div>
    <h3>Biggest leaks</h3>
    <div class="leaks">${leaks.length ? leaks.map(([k, n]) => `<div><b>${LEAKNAME[k] || k}</b> · ${n} time${n > 1 ? 's' : ''}<br>${esc(LESSONS[k] || '')}</div>`).join('') : '<div>No leaks found yet. Keep playing and the coach will spot patterns.</div>'}</div>
    <h3>Your stats vs a winning player</h3>
    <table class="ptable">${rows.map(([n, v, band, d, ratio]) => `<tr><td>${n}</td><td>${d}<br><small style="color:var(--muted)">Target: ${ratio ? band[0] + '–' + band[1] : pc(band[0]) + '–' + pc(band[1])}</small></td><td class="n">${fmtv(v, ratio)}<br>${status(v, band)}</td></tr>`).join('')}</table>
    <h3>Coaching from Claude</h3>
    <p>Your hands are saved to this page${DBX ? '' : ' (in this browser only, because saving to your account is not available here)'}. You can also ask Claude in your chat to review them.</p>
    <div class="ai" id="planOut" hidden></div>
    ${sampleFn ? '<button class="btn-main" id="planBtn">Get my coaching plan</button>' : ''}
    <button class="btn-ghost btn-danger" id="resetProg">Reset my progress</button>`;
  const pb = $('#planBtn'); if (pb) pb.onclick = askPlan;
  $('#resetProg').onclick = e => {
    const b = e.currentTarget;
    if (b.dataset.confirm !== '1'){ b.dataset.confirm = '1'; b.textContent = 'Tap again to erase all progress'; return; }
    prof = blankProf(); saveLocal(PKEY, prof); dbWrite(() => DBX.db.doc('players/' + DBX.uid).set(Object.assign({}, prof, {updatedAt: Date.now()}))); renderProgress();
  };
}
async function askPlan(){
  const out = $('#planOut'), btn = $('#planBtn'); out.hidden = false; out.textContent = 'Thinking…'; btn.disabled = true;
  const P = prof;
  const prompt = `You are an expert poker coach. Your student is a beginner who wants to become a strong No-Limit Hold'em tournament player. They practice 6-max Sit & Gos against computer players of different styles.

Their lifetime numbers: ${JSON.stringify({hands: P.hands, VPIP: P.hands ? +(P.vpip / P.hands).toFixed(3) : null, PFR: P.hands ? +(P.pfr / P.hands).toFixed(3) : null, threeBet: P.threeOpp ? +(P.three / P.threeOpp).toFixed(3) : null, cbet: P.cbetOpp ? +(P.cbet / P.cbetOpp).toFixed(3) : null, aggressionFactor: P.calls ? +(P.agg / P.calls).toFixed(2) : null, wentToShowdown: P.sawFlop ? +(P.wtsd / P.sawFlop).toFixed(3) : null, wonAtShowdown: P.wtsd ? +(P.wsd / P.wtsd).toFixed(3) : null, decisionGrades: P.dec, leakCounts: P.leaks, tournaments: P.tournaments.slice(-10)})}

Their most recent mistakes, as graded by the app:
${JSON.stringify(P.mistakes.slice(-15))}

Write a personal coaching plan in very simple English for a complete beginner who does not know poker terms. Use short sentences and everyday words. Use these bold labels:
**Where you are now:** 2-3 sentences.
**Your top 3 leaks:** a short bullet list, each with why it costs chips and the simple rule that fixes it.
**Your plan for the next session:** 3 concrete drills or goals they can follow while playing.
**Next skill to learn:** one concept to study next.
Under 300 words. If there are very few hands, say what to focus on first instead.`;
  try { const {text} = await sampleFn(prompt, {onText: ({text}) => { out.innerHTML = mdLite(text); }}); out.innerHTML = mdLite(text); }
  catch (e) { out.textContent = (e && e.code === 'not_granted') ? 'Claude coaching is not allowed for this page.' : 'Claude could not finish the plan. Try again in a minute.'; }
  finally { btn.disabled = false; }
}

/* ================= learn ================= */
const LEARN = {
  basics: () => `
    <h3>The goal</h3><p>Win chips. In this tournament everyone starts with the same stack and the last player with chips wins. You win a hand by having the best five-card hand at the end, or by betting so that everyone else folds.</p>
    <h3>How a hand goes</h3>
    <ol><li><b>Blinds.</b> The two players left of the dealer button post forced bets: the small blind and the big blind. Later in the tournament everyone also pays a small ante.</li>
    <li><b>Preflop.</b> Everyone gets two private cards ("hole cards"). Betting starts with the player left of the big blind.</li>
    <li><b>Flop.</b> Three shared cards go face up in the middle. Another round of betting.</li>
    <li><b>Turn.</b> A fourth shared card. Betting.</li>
    <li><b>River.</b> A fifth shared card. Final betting.</li>
    <li><b>Showdown.</b> Players still in show their cards. The best five-card hand from any mix of your two cards and the five shared cards wins.</li></ol>
    <h3>Your choices on your turn</h3>
    <ul><li><b>Fold:</b> give up the hand and anything you put in.</li><li><b>Check:</b> pass without betting, only if nobody has bet.</li><li><b>Call:</b> match the current bet.</li><li><b>Bet / Raise:</b> put in more chips. Everyone must call, raise again or fold.</li><li><b>All-in:</b> bet every chip you have.</li></ul>
    <p>After each hand the button moves one seat to the left, so everyone takes turns paying the blinds.</p>`,
  ranks: () => {
    /** @type {Array<[string, string, number[]]>} */
    const ex = [['Royal Flush', 'A, K, Q, J, 10 of one suit', [50, 46, 42, 38, 34]], ['Straight Flush', 'Five in a row, same suit', [29, 25, 21, 17, 13]], ['Four of a Kind', 'Four cards of the same rank', [36, 37, 38, 39, 8]], ['Full House', 'Three of a kind plus a pair', [44, 45, 46, 20, 21]], ['Flush', 'Any five of the same suit', [48, 36, 24, 16, 4]], ['Straight', 'Five in a row, any suits', [33, 30, 27, 22, 19]], ['Three of a Kind', 'Three cards of the same rank', [20, 21, 22, 46, 6]], ['Two Pair', 'Two different pairs', [44, 45, 12, 13, 26]], ['One Pair', 'Two cards of the same rank', [48, 49, 37, 22, 10]], ['High Card', 'Nothing else: highest card plays', [50, 37, 26, 18, 5]]];
    return `<p>From best to worst. If two players have the same type of hand, the higher cards win. Suits never break ties: identical hands split the pot.</p>` + ex.map(([n, d, cards], i) => `<div class="rank"><b>${i + 1}</b><div><div class="rn">${n}</div><div class="rd">${d}</div></div><div class="mini">${cards.map(c => cardHTML(c)).join('')}</div></div>`).join('');
  },
  betting: () => `
    <h3>No-limit betting</h3><p>You can bet any amount from the minimum up to all your chips.</p>
    <ul><li><b>Minimum bet:</b> one big blind.</li><li><b>Minimum raise:</b> at least as much as the last bet or raise. If someone bets 100, the smallest raise is to 200.</li><li><b>All-in for less:</b> if you cannot cover a bet, you can still call all-in. You can only win from each player as much as you put in.</li></ul>
    <h3>Side pots</h3><p>When a player is all-in and others keep betting, the extra chips go into a side pot that the all-in player cannot win. The table shows "Main" and "Side" amounts when this happens.</p>
    <h3>Blinds and antes go up</h3><p>Every few hands the blinds rise. That forces action: waiting for perfect cards gets more expensive, so stack size matters more and more.</p>
    <h3>Showing cards</h3><p>At showdown the last player who bet or raised shows first. Others may throw away ("muck") a losing hand without showing. When players are all-in, everyone's cards are turned over.</p>`,
  positions: () => `
    <p>Your seat compared to the dealer button decides when you act. Acting later is a big advantage: you see what others do before you decide.</p>
    <ul><li><b>SB, small blind:</b> posts half a bet, acts last before the flop but first after it. A tough seat.</li><li><b>BB, big blind:</b> posts a full bet and acts last before the flop.</li><li><b>UTG, under the gun:</b> first to act before the flop. Play only strong hands here.</li><li><b>HJ, hijack:</b> middle position.</li><li><b>CO, cutoff:</b> one seat before the button. Play more hands.</li><li><b>BTN, button:</b> acts last after the flop. The best seat: play the most hands here.</li></ul>
    <p>Rule of thumb for raising when everyone before you folded: about 15% of hands UTG, 20% in the hijack, 28% in the cutoff, 45% on the button.</p>`,
  hands: () => {
    const R = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2], tier = p => p <= 0.08 ? ['#f4d47e', 'Raise from any seat'] : p <= 0.15 ? ['#cfe08a', 'Raise from early seats'] : p <= 0.2 ? ['#8fd0a6', 'Raise from middle seats'] : p <= 0.28 ? ['#7fbcd6', 'Raise from the cutoff'] : p <= 0.45 ? ['#a99ad6', 'Raise on the button'] : ['#3a4440', 'Usually fold'];
    let cells = '';
    for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++){
      const a = R[i], b = R[j], s = j > i ? 1 : 0, hi = Math.max(a, b), lo = Math.min(a, b);
      const p = PCT[(hi * 15 + lo) * 2 + (hi !== lo && s ? 1 : 0)], [c] = tier(p);
      cells += `<div style="background:${c};${p > 0.45 ? 'color:#9aa8a1' : ''}" title="${LOGR[hi]}${LOGR[lo]}${hi === lo ? '' : s ? 's' : 'o'}: top ${Math.round(p * 100)}%">${LOGR[hi]}${LOGR[lo]}${hi === lo ? '' : s ? 's' : 'o'}</div>`;
    }
    return `<p>Which starting hands to raise when everyone before you has folded. "s" means suited (same suit), "o" means offsuit. Pairs run down the diagonal.</p><div class="grid-wrap"><div class="grid13">${cells}</div></div><div class="legend">${[0.05, 0.12, 0.18, 0.25, 0.4, 0.8].map(p => { const [c, t] = tier(p); return `<span><i style="background:${c}"></i>${t}</span>`; }).join('')}</div><p>Facing a raise, play much tighter: re-raise with the very best hands, call with good ones, fold the rest.</p>`;
  },
  strategy: () => `
    <h3>1. Play tight, then aggressive</h3><p>Play fewer, better hands, and when you play, bet and raise rather than call. Calling wins only at showdown; betting can also win when others fold.</p>
    <h3>2. Pot odds</h3><p>Before calling, compare the price with your chance to win. Calling 50 into a pot that becomes 200 means you need to win 25% of the time. The game shows "You need X% to call" on every decision.</p>
    <h3>3. Count outs</h3><p>Outs are the cards that improve you. A flush draw has 9 outs, an open-ended straight draw has 8. On the flop, outs × 4 ≈ your chance to hit by the river; on the turn, outs × 2.</p>
    <h3>4. Think in ranges</h3><p>Ask "what hands would this player bet like this?" A tight player's raise means a narrow, strong range. A maniac's raise can be anything.</p>
    <h3>5. Value bet and bluff with a reason</h3><p>Bet strong hands so worse hands pay you. Bluff rarely, against one opponent, when the story makes sense.</p>
    <h3>6. Stack size</h3><p>Below about 12 big blinds, stop calling raises and switch to all-in or fold before the flop.</p>`,
  players: () => {
    const seen = S ? S.players.filter(p => !p.isHuman) : [];
    return `<p>Every tournament, players are dealt one of these styles at random. Watch their stats (VPIP = how often they play, PFR = how often they raise) and how they bet to work out who is who. After about 15 hands you get a read.</p>` +
      Object.values(TYPES).filter(t => !t.home).map(t => `<h3>${t.label}</h3><p>${t.desc} <b>How to beat them:</b> ${t.beat}</p>`).join('') +
      (seen.length ? `<h3>Your reads at this table</h3><ul>${seen.map(p => `<li><b>${esc(p.name)}</b>: ${p.read ? TYPES[p.type].label : 'no read yet'}${p.hud.hands >= 4 ? ` (${hudText(p)})` : ''}</li>`).join('')}</ul>` : '');
  },
  glossary: () => `<dl class="terms">${[
    ['Blinds', 'Forced bets that start the pot.'], ['Ante', 'A small forced bet from every player, later in tournaments.'], ['Button', 'The dealer seat. It acts last after the flop.'], ['Limp', 'Just calling the big blind instead of raising.'], ['3-bet', 'A re-raise of the first raise before the flop.'], ['C-bet', 'Continuation bet: a flop bet by the player who raised before the flop.'], ['Check-raise', 'Checking, then raising after someone bets.'], ['Slow-play', 'Playing a very strong hand weakly to trap opponents.'], ['Semi-bluff', 'Betting with a draw: you can win now or improve later.'], ['Value bet', 'A bet you want a worse hand to call.'], ['Pot odds', 'The price of a call compared to the pot.'], ['Equity', 'Your share of the pot if all cards were dealt out: your chance to win.'], ['Outs', 'Cards that improve your hand.'], ['Range', 'All the hands a player could have, given how they played.'], ['VPIP', 'Voluntarily put money in pot: how often a player plays a hand.'], ['PFR', 'Preflop raise: how often a player raises before the flop.'], ['Muck', 'Throwing away your cards without showing them.'], ['Tilt', 'Playing badly after a frustrating loss.'], ['Stack', 'The chips a player has.'], ['Big blinds (BB)', 'Stack sizes are often counted in big blinds: 1,000 chips at 50/100 is 10 BB.']
  ].map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl>`
};
LEARN.home = () => `
    <p>At your home game the dealer picks the game for each hand ("dealer's choice"). In every game except Simple poker you get more than 2 cards. <b>You keep all of them during the betting and split them into parts at the showdown.</b> Until then you can rearrange them any time: tap your cards. Everyone still in the hand shows. Betting is exactly like normal poker, and each part wins its own equal share of the pot. Win every part and you take the whole pot. In the 8-card game, winning 2 of the 3 parts is enough to take the whole pot.</p>
    ${VAR_ORDER.map(k => `<h3>${VARIANTS[k].name}</h3><p>${VARIANTS[k].desc}</p>`).join('')}
    <h3>Who usually picks what</h3><ul><li><b>Rohit:</b> mostly Poker + 3 Patti, sometimes Two boards.</li><li><b>Krish:</b> mostly 8 cards (two 3 Patti), sometimes Poker + 3 Patti. He usually puts his stronger 3 Patti 2nd, but switches sometimes so he is hard to predict.</li><li><b>Nikhil:</b> 7 cards (hand poker) or Simple poker.</li><li><b>Venky:</b> mostly Poker + 3 Patti, sometimes Simple poker.</li><li><b>You:</b> you pick when you have the dealer chip.</li></ul>
    <h3>3 Patti hands, best to worst</h3>
    <div class="tp-ranks">${/** @type {Array<[string, string, number[]]>} */ ([['Trail', 'Three of a kind', [48, 49, 50]], ['Pure sequence', '3 in a row, same suit', [45, 41, 37]], ['Sequence', '3 in a row, any suits', [44, 41, 38]], ['Color', '3 of the same suit', [47, 31, 11]], ['Pair', 'Two of the same rank', [36, 37, 18]], ['High card', 'None of the above', [50, 33, 13]]]).map(([n, d, cards]) => `<div><b>${n}</b> <span>${d}</span></div><div class="mini">${cards.map(c => cardHTML(c)).join('')}</div>`).join('')}</div>
    <p>A-K-Q is the best sequence, then A-2-3, then K-Q-J and down to 4-3-2. When two hands are the same type, the higher cards win.</p>
    <h3>How to split well</h3><ul><li>3 Patti: a pair, a sequence or three of one suit wins most of the time. Three random high cards usually lose.</li><li>Poker: two high cards, a pair, or two cards of the same suit that are close together.</li><li>Do not put everything into one part: a decent hand in every part often beats one great part and one terrible part.</li><li>8 cards: you choose which 3 Patti plays 1st and which plays 2nd. Most players put the stronger one 1st; putting it 2nd can beat their weaker hand, but your weak one then meets their strong one.</li><li>The best split can change as table cards come out, so look again at the showdown.</li><li>Not sure? Tap Hint: it shows your arrangement next to the best all-round split, the strongest poker split and the strongest 3 Patti split, so you can pick.</li></ul>`;
const LEARN_TABS = [['basics', 'Basics'], ['home', 'Home games'], ['ranks', 'Hand ranks'], ['betting', 'Betting'], ['positions', 'Positions'], ['hands', 'Starting hands'], ['strategy', 'Strategy'], ['players', 'Player types'], ['glossary', 'Glossary']];
function openLearn(tab){
  tab = tab || loadLocal('river-room-tab', {t: 'basics'}).t;
  $('#learnTabs').innerHTML = LEARN_TABS.map(([k, l]) => `<button type="button" role="tab" data-k="${k}" aria-selected="${k === tab}">${l}</button>`).join('');
  $('#learnBody').innerHTML = LEARN[tab] ? LEARN[tab]() : '';
  $('#learnOv').hidden = false;
}
$('#learnTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; saveLocal('river-room-tab', {t: b.dataset.k}); openLearn(b.dataset.k); });

/* ================= turn timer ================= */
function tick(){
  requestAnimationFrame(tick);
  if (!S || S.toAct < 0) return;
  const p = S.players[S.toAct]; if (!p || !p.el) return;
  const left = Math.max(0, 1 - (performance.now() - S.turnStart) / S.turnLen);
  const bar = /** @type {HTMLElement | null} */ (p.el.querySelector('.timer i'));
  if (bar){ bar.style.transform = `scaleX(${p.isHuman && settings.timer === 0 ? 1 : left})`; bar.classList.toggle('low', left < 0.3 && !(p.isHuman && settings.timer === 0)); }
  if (p.isHuman && pending && settings.timer > 0){
    if (left < 0.3 && !S.warned){ S.warned = true; Snd.tick(); }
    if (left <= 0){ lg(`${p.name} has timed out`); submit(pending.o.canCheck ? {type: 'check'} : {type: 'fold'}); }
  }
}
requestAnimationFrame(tick);

/* ================= panels ================= */
function renderHistory(){
  const list = $('#hlist');
  if (!S || !S.history.length){ list.innerHTML = '<p class="empty">Every hand is recorded here in the same format online poker rooms use. Open any hand to see its review again.</p>'; return; }
  list.innerHTML = S.history.map(h => `<details><summary><span>Hand #${h.no}</span><span class="hb">${h.blinds}</span><span class="hr ${h.net > 0 ? 'pos' : h.net < 0 ? 'neg' : ''}">${h.net == null ? '' : (h.net > 0 ? '+' : '') + fmt(h.net)}</span></summary><pre>${esc(h.text)}</pre><div class="hbtns">${h.review ? `<button type="button" data-rev="${h.no}">Review this hand</button>` : ''}<button type="button" data-copy="${h.no}">Copy hand</button></div></details>`).join('');
}
$('#hlist').addEventListener('click', e => {
  const rb = e.target.closest('[data-rev]');
  if (rb){ const h = S.history.find(x => x.no === +rb.dataset.rev); if (h && h.review){ $('#drawer').classList.remove('open'); showReview(h.review, false); } return; }
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const h = S.history.find(x => x.no === +b.dataset.copy); if (!h) return;
  const fallback = () => { const pre = b.closest('details').querySelector('pre'); const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected. Press Ctrl+C'; };
  try { navigator.clipboard.writeText(h.text).then(() => { b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy hand', 1500); }, fallback); } catch (err) { fallback(); }
});
function segment(el, items, get, set){
  el.innerHTML = items.map(([v, l, sm]) => `<button type="button" data-v="${v}" aria-pressed="${String(get() === v)}">${l}${sm ? `<small>${sm}</small>` : ''}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('button'); if (!b) return; const v = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v; set(v); $$('button', el).forEach(x => x.setAttribute('aria-pressed', String(x === b))); };
}
/* ---- home game roster: who is at the table, and who you play (src/engine/roster.ts) ---- */
/** The saved roster if it is still valid, else Sumer and the four friends. */
function rosterNow(){ return validRoster(settings.roster) || DEFAULT_ROSTER.map(c => ({...c})); }
/** The character you play: the saved pick if it is still at the table, else the first one. */
function heroIdNow(r){ return r.some(c => c.id === settings.heroId) ? settings.heroId : r[0].id; }
let rosterEditing = null;
const faceHTML = c => c.avatar && AV[c.avatar] ? avatarSVG(c.avatar, c.color) : `<span class="ini" style="background:${c.color}">${esc(c.name.charAt(0).toUpperCase())}</span>`;
function setRoster(r, heroId){
  settings.roster = r; settings.heroId = r.some(c => c.id === heroId) ? heroId : r[0].id;
  saveSettings(); setupTable(null); renderHomeRoster();
}
function renderHomeRoster(focus){
  const r = rosterNow(), hero = heroIdNow(r), el = $('#homeRoster');
  const changed = r.length !== DEFAULT_ROSTER.length || r.some((c, i) => c.id !== DEFAULT_ROSTER[i].id || c.name !== DEFAULT_ROSTER[i].name);
  el.innerHTML = `<fieldset class="roster-pick"><legend>Who do you play as?</legend>` + r.map(c => {
    const me = c.id === hero, editing = rosterEditing === c.id;
    return `<div class="rp${me ? ' me' : ''}" data-id="${c.id}">`
      + `<label class="rp-main"><input type="radio" name="rpHero" value="${c.id}"${me ? ' checked' : ''}><span class="mini-av">${faceHTML(c)}</span>`
      + `<span class="rp-text"><span class="rp-line"><b>${esc(c.name)}</b>${me ? '<em class="rp-you">You</em>' : ''}</span><small title="${esc(TYPES[c.type].desc)}">${me ? 'You play this seat' : 'Computer plays: ' + esc(styleLabel(c.type))}</small></span></label>`
      + (editing
        ? `<span class="rp-tools"><input type="text" class="rp-name" maxlength="12" value="${esc(c.name)}" aria-label="New name for ${esc(c.name)}"><button type="button" class="rp-btn" data-act="save">Save</button><button type="button" class="rp-btn" data-act="cancel">Cancel</button></span>`
        : `<span class="rp-tools"><button type="button" class="rp-btn" data-act="rename" aria-label="Rename ${esc(c.name)}">Rename</button><button type="button" class="rp-btn" data-act="remove" aria-label="Remove ${esc(c.name)}"${r.length <= ROSTER_MIN ? ' disabled' : ''}>Remove</button></span>`)
      + `</div>`;
  }).join('') + `</fieldset>`
    + (r.length < ROSTER_MAX ? `<div class="rp-add"><input type="text" id="rpNewName" maxlength="12" placeholder="Add a player" aria-label="New player's name"><select id="rpNewStyle" aria-label="How the computer plays them">${STYLES.map(t => `<option value="${t}">Plays like: ${esc(styleLabel(t))}</option>`).join('')}</select><button type="button" class="rp-btn" id="rpAdd">Add</button></div>` : `<p class="rp-note">The table is full (${ROSTER_MAX} seats).</p>`)
    + `<p class="rp-err" id="rosterErr" role="alert"></p>`
    + (changed ? `<button type="button" class="rp-reset" id="rpReset">Reset to the original five</button>` : '');
  if (focus) { const f = el.querySelector(focus); if (f) f.focus(); }
}
function rosterError(msg){ const e = $('#rosterErr'); if (e) e.textContent = msg; }
function rosterResult(res, heroId, focus){
  if (!res.ok) { rosterError(res.error); return false; }
  rosterEditing = null; setRoster(res.roster, heroId); if (focus) renderHomeRoster(focus);
  return true;
}
$('#homeRoster').addEventListener('change', e => {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (t.name === 'rpHero') { const r = rosterNow(); setRoster(r, t.value); renderHomeRoster(`input[value="${t.value}"]`); }
});
$('#homeRoster').addEventListener('click', e => {
  const b = /** @type {HTMLElement} */ (e.target).closest('button');
  if (!b) return;
  const r = rosterNow(), hero = heroIdNow(r), row = b.closest('.rp'), id = row && row.getAttribute('data-id');
  const act = b.getAttribute('data-act');
  if (act === 'rename') { rosterEditing = id; renderHomeRoster('.rp-name'); }
  else if (act === 'cancel') { rosterEditing = null; renderHomeRoster(`.rp[data-id="${id}"] [data-act="rename"]`); }
  else if (act === 'save') rosterResult(renameCharacter(r, id, /** @type {HTMLInputElement} */ (row.querySelector('.rp-name')).value), hero, `.rp[data-id="${id}"] [data-act="rename"]`);
  else if (act === 'remove') rosterResult(removeCharacter(r, id), id === hero ? null : hero, '#rpNewName');
  else if (b.id === 'rpAdd') rosterResult(addCharacter(r, /** @type {HTMLInputElement} */ ($('#rpNewName')).value, /** @type {HTMLSelectElement} */ ($('#rpNewStyle')).value), hero, '#rpNewName');
  else if (b.id === 'rpReset') { rosterEditing = null; setRoster(DEFAULT_ROSTER.map(c => ({...c})), 'sumer'); }
});
$('#homeRoster').addEventListener('keydown', e => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.classList.contains('rp-name')) {
    if (e.key === 'Enter') { e.preventDefault(); /** @type {HTMLElement} */ (t.closest('.rp').querySelector('[data-act="save"]')).click(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); /** @type {HTMLElement} */ (t.closest('.rp').querySelector('[data-act="cancel"]')).click(); }
  } else if (t.id === 'rpNewName' && e.key === 'Enter') { e.preventDefault(); $('#rpAdd').click(); }
});
function renderRoster(){ $('#roster').innerHTML = S.players.map(p => `<span><i style="--pc:${p.color}"></i>${esc(p.isHuman ? (settings.name || 'You') : p.name)}</span>`).join(''); }
function startModeUI(){
  const home = settings.mode === 'home';
  $('#startEyebrow').textContent = home ? 'Home cash game · Dealer\'s choice' : 'No-Limit Texas Hold\'em · Sit & Go';
  $('#homeInfo').hidden = !home; $('#tourneyFields').hidden = home; $('#tourneyLede').hidden = home; $('#roster').hidden = home;
  $('#nameIn').value = home ? homeName() : settings.name;
  if (home) segment($('#gamesSeg'), [['dealer', "Dealer's choice", '3 Patti, two boards...'], ['holdem', 'Simple poker', "Just Hold'em"]], () => settings.games, v => { settings.games = v; saveSettings(); });
  // your name comes from the character you play in the home game
  $('#nameIn').closest('label').hidden = home;
  if (home) renderHomeRoster();
}
function buildStart(hasSnap){
  segment($('#modeSeg'), [['tourney', 'Tournament', 'Sit & Go vs strangers'], ['home', 'Home game', 'Your friends, real chips']], () => settings.mode, v => { settings.mode = v; saveSettings(); setupTable(null); renderRoster(); startModeUI(); });
  startModeUI();
  segment($('#oppSeg'), [[1,'1'],[2,'2'],[3,'3'],[4,'4'],[5,'5']], () => settings.opp, v => { settings.opp = v; saveSettings(); setupTable(null); renderRoster(); });
  segment($('#stackSeg'), [[1500,'1,500'],[3000,'3,000'],[5000,'5,000']], () => settings.stack, v => { settings.stack = v; saveSettings(); setupTable(null); renderRoster(); });
  segment($('#lvlSeg'), [[6,'Turbo','6 hands'],[10,'Regular','10 hands'],[15,'Deep','15 hands']], () => settings.perLevel, v => { settings.perLevel = v; saveSettings(); });
  if (settings.mode !== 'home') $('#nameIn').value = settings.name;
  $('#resumeBtn').hidden = !hasSnap;
  renderRoster();
  updateResumeBtn();
}
function buildSettings(){
  $('#quitBtn').textContent = S && S.online ? 'Leave the online table' : MONEY ? 'Cash out and end session' : 'Leave tournament';
  // online, the game type and the turn timer belong to the table
  $('#timerSeg').closest('.row').hidden = !!(S && S.online);
  $('#optSound').checked = settings.sound; $('#optFour').checked = settings.fourColor; $('#optEq').checked = settings.showEq;
  $('#optHint').checked = settings.hints; $('#optHud').checked = settings.hud; $('#optReveal').checked = settings.revealAll; $('#optHold').checked = settings.holdResult;
  $('#gamesRow').hidden = !MONEY || !!(S && S.online);
  if (MONEY) segment($('#gamesSeg2'), [['dealer', "Dealer's choice"], ['holdem', 'Simple only']], () => settings.games, v => { settings.games = v; saveSettings(); toast(v === 'holdem' ? 'From the next hand: simple poker only' : "From the next hand: dealer's choice"); });
  segment($('#paceSeg'), [['learn','Learning'],['normal','Normal'],['fast','Fast']], () => settings.pace, v => { settings.pace = v; saveSettings(); });
  segment($('#timerSeg'), [[0,'Off'],[30,'30s'],[60,'60s'],[120,'2 min']], () => settings.timer, v => { settings.timer = v; saveSettings(); if (pending && S.toAct >= 0){ S.turnStart = performance.now(); S.turnLen = v > 0 ? v * 1000 : 1e12; } });
  segment($('#reviewSeg'), [['all','Every hand'],['played','Played'],['off','Off']], () => settings.review, v => { settings.review = v; saveSettings(); });
}
function applyPrefs(){
  document.body.classList.toggle('two-color', !settings.fourColor);
  const sb = $('#soundBtn');
  sb.innerHTML = settings.sound
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
  sb.setAttribute('aria-pressed', String(settings.sound)); sb.setAttribute('aria-label', settings.sound ? 'Sound on' : 'Sound off');
  if (S) render();
}
function showEnd(place){
  clearTable();
  const n = S.entrants, pool = n * BUYIN, pays = n >= 4 ? [0.65, 0.35] : [1];
  const prize = place <= pays.length ? pool * pays[place - 1] : 0;
  recordTournament(place);
  $('#endPlace').textContent = ordinal(place);
  $('#endEyebrow').textContent = `Table ${S.tableNo} · ${n} players · Hand #${S.handNo}`;
  $('#endTitle').textContent = place === 1 ? 'You won the tournament' : place <= pays.length ? `You finished ${ordinal(place)} and cashed` : `You finished ${ordinal(place)} of ${n}`;
  $('#endPrize').textContent = prize > 0 ? `Prize: $${prize.toFixed(2)} from a $${pool} pool` : `Paid places: top ${pays.length}. Prize pool $${pool}.`;
  const st = S.stats, h = Math.max(1, st.hands);
  $('#endStats').innerHTML = [[st.hands, 'Hands'], [st.won, 'Pots won'], [fmt(st.biggest), 'Biggest pot'], [pc(st.vpip / h), 'VPIP'], [pc(st.pfr / h), 'Preflop raise'], [`${st.sdWon}/${st.sd}`, 'Showdowns won']].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  $('#endWho').innerHTML = '<div class="eyebrow" style="text-align:center">Who you played</div>' + S.players.filter(p => !p.isHuman).map(p => `<div><b>${esc(p.name)}</b> was a <b>${TYPES[p.type].label.toLowerCase()}</b>${p.read ? ' (you had the read)' : ''}. ${TYPES[p.type].desc} <i>${TYPES[p.type].beat}</i></div>`).join('');
  $('#againBtn').textContent = 'Play again';
  $('#endOv').hidden = false;
  if (place === 1) celebrate();
}
function celebrate(){
  if (REDUCED) return;
  Snd.bigPot(0);
  for (let i = 0; i < 46; i++){
    const d = DENOMS[i % DENOMS.length], el = document.createElement('div');
    el.className = 'confetti'; el.innerHTML = `<i class="chip" style="--c:${d[1]};${d[2] ? `--e:${d[2]};` : ''}font-size:18px;position:relative;display:block"></i>`;
    el.style.left = (Math.random() * 100) + 'vw'; document.body.appendChild(el);
    const a = el.animate([{transform: 'translateY(0) rotate(0)'}, {transform: `translateY(${innerHeight + 80}px) rotate(${(Math.random() * 2 - 1) * 720}deg)`}], {duration: 1800 + Math.random() * 1800, delay: Math.random() * 900, easing: 'cubic-bezier(.3,.1,.6,1)', fill: 'forwards'});
    a.finished.then(() => el.remove(), () => el.remove());
  }
}

/* ================= wiring ================= */
let foldArm = 0;
$('#bFold').onclick = () => {
  if (!pending) return;
  if (pending.o.canCheck && Date.now() - foldArm > 3000){
    foldArm = Date.now(); $('#bFold .t').textContent = 'Tap again to fold';
    toast('Checking is free here. Tap Fold again only if you really want to fold.');
    setTimeout(() => { if (Date.now() - foldArm >= 2900) $('#bFold .t').textContent = 'Fold'; }, 3000);
    return;
  }
  foldArm = 0; submit({type: 'fold'});
};
$('#bCall').onclick = () => { if (pending) submit({type: pending.o.canCheck ? 'check' : 'call'}); };
$('#bRaise').onclick = () => { if (pending) submit({type: 'raise', to: $('#sizer').hidden ? pending.o.maxTo : curAmt}); };
$('#arrBtn').onclick = () => openArrange();
$('#hintBtn').onclick = () => { if ($('#hint').hidden) showHint(); else $('#hint').hidden = true; };
$('#hint').addEventListener('click', () => { $('#hint').hidden = true; });
$('#amt').addEventListener('input', e => setAmt(e.target.value));
const fromInput = v => MONEY ? Math.round(parseFloat(v) * 100) : v;
$('#amtNum').addEventListener('change', e => setAmt(fromInput(e.target.value)));
$('#amtNum').addEventListener('keydown', e => { if (e.key === 'Enter'){ setAmt(fromInput(e.target.value)); $('#bRaise').click(); } });
$('#minus').onclick = () => setAmt(curAmt - (MONEY ? 10 : S.bb));
$('#plus').onclick = () => setAmt(curAmt + (MONEY ? 10 : S.bb));
$('#presets').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setAmt(+b.dataset.v); });
$('#pre').addEventListener('click', e => { const b = e.target.closest('.pbtn'); if (!b || !S) return; S.pre = S.pre === b.dataset.pre ? null : b.dataset.pre; renderControls(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape'){
    $('#drawer').classList.remove('open');
    for (const id of ['#setOv', '#learnOv', '#progOv']) if (!$(id).hidden) $(id).hidden = true;
    if (!$('#revOv').hidden) closeReview('back');
    return;
  }
  if (!$('#revOv').hidden && e.key === 'Enter' && !/** @type {Element} */ (e.target).matches('button')){ e.preventDefault(); closeReview('next'); return; }
  if (contWait && $('#setOv').hidden && $('#learnOv').hidden && $('#progOv').hidden && (e.key === 'Enter' || e.key === ' ' || e.key.toLowerCase() === 'n') && !/** @type {Element} */ (e.target).matches('input,button')){ e.preventDefault(); doContinue('primary'); return; }
  if (!pending) return;
  if (/** @type {Element} */ (e.target).matches('input[type=text],input[type=number]')) return;
  if (!$('#revOv').hidden || !$('#learnOv').hidden || !$('#progOv').hidden || !$('#setOv').hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'f'){ e.preventDefault(); $('#bFold').click(); }
  else if (k === 'c' || k === 'k'){ e.preventDefault(); $('#bCall').click(); }
  else if (k === 'r'){ if (!$('#bRaise').hidden){ e.preventDefault(); $('#bRaise').click(); } }
  else if (k === 'h' && settings.hints){ e.preventDefault(); $('#hintBtn').click(); }
});
$('#startBtn').onclick = () => {
  Snd.init();
  if (settings.mode === 'home'){ const r = rosterNow(); settings.name = r.find(c => c.id === heroIdNow(r)).name; }
  else settings.name = ($('#nameIn').value.trim() || 'You').slice(0, 12);
  saveSettings();
  setupTable(null); $('#startOv').hidden = true; runLoop();
};
$('#rulesBtn').onclick = () => openLearn('basics');
$('#resumeBtn').onclick = () => {
  if (!resumeSnap) return; Snd.init();
  if (resumeSnap.perLevel) settings.perLevel = resumeSnap.perLevel;
  if (resumeSnap.mode) settings.mode = resumeSnap.mode;
  saveSettings(); setupTable(resumeSnap); $('#startOv').hidden = true; runLoop();
};
function validSnap(d){ return d && !d.done && d.handNo > 0 && Array.isArray(d.players) && d.players.every(p => p.type == null || TYPES[p.type]) ? d : null; }
function updateResumeBtn(){
  const b = $('#resumeBtn'); if (!b) return;
  if (!resumeSnap){ b.hidden = true; return; }
  const hero = resumeSnap.players.find(p => !p.type) || {stack: 0}, home = resumeSnap.mode === 'home';
  const stack = home ? '$' + (hero.stack / 100).toFixed(2) : num(hero.stack) + ' chips';
  const ago = resumeSnap.ts ? Math.max(1, Math.round((Date.now() - resumeSnap.ts) / 60000)) : null;
  const when = ago == null ? '' : ago < 60 ? ` · ${ago} min ago` : ago < 1440 ? ` · ${Math.round(ago / 60)} h ago` : ` · ${Math.round(ago / 1440)} d ago`;
  b.textContent = `Resume ${home ? 'home game' : 'tournament'}: hand #${resumeSnap.handNo + 1}, you have ${stack}${when}`;
  b.hidden = false;
}
$('#againBtn').onclick = () => { Snd.init(); $('#endOv').hidden = true; setupTable(null); runLoop(); };
$('#endProg').onclick = () => { renderProgress(); $('#progOv').hidden = false; };
$('#setupBtn').onclick = () => { $('#endOv').hidden = true; setupTable(null); buildStart(false); $('#startOv').hidden = false; };
$('#setBtn').onclick = () => { buildSettings(); $('#setOv').hidden = false; };
$('#setClose').onclick = () => { $('#setOv').hidden = true; };
$('#learnBtn').onclick = () => openLearn();
$('#learnClose').onclick = () => { $('#learnOv').hidden = true; };
$('#progBtn').onclick = () => { renderProgress(); $('#progOv').hidden = false; };
$('#progClose').onclick = () => { $('#progOv').hidden = true; };
for (const id of ['#setOv', '#learnOv', '#progOv']) $(id).addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
$('#rvNext').onclick = () => closeReview('next');
$('#rvBack').onclick = () => closeReview('back');
$('#contBtn').onclick = () => doContinue('primary');
$('#contSkip').onclick = () => doContinue('skip');
$('#endBack').onclick = () => { $('#endOv').hidden = true; waitForContinue('See tournament results', false, '<b>Tournament over.</b> Look at the table, then open your results.').then(c => { if (c === 'primary') $('#endOv').hidden = false; }); };
$('#rvAsk').onclick = askClaudeReview;
$('#rebuyYes').onclick = () => rebuyChoice('yes');
$('#rebuyNo').onclick = () => rebuyChoice('no');
$('#quitBtn').onclick = () => {
  if (S && S.online){ $('#setOv').hidden = true; leaveOnline('You left the table.'); return; }
  if (S && MONEY && S.running){
    $('#setOv').hidden = true; S.cashOutReq = true; S.paused = false;
    if (contWait) doContinue('skip');
    if (S.handActive) toast('You will cash out when this hand ends.'); 
    return;
  } $('#setOv').hidden = true; $('#act').hidden = true; setupTable(null); buildStart(false); $('#startOv').hidden = false; };
$('#optSound').onchange = e => { settings.sound = e.target.checked; if (settings.sound) Snd.init(); saveSettings(); applyPrefs(); };
$('#optFour').onchange = e => { settings.fourColor = e.target.checked; saveSettings(); applyPrefs(); };
$('#optEq').onchange = e => { settings.showEq = e.target.checked; saveSettings(); if (S) render(); };
$('#optHint').onchange = e => { settings.hints = e.target.checked; saveSettings(); $('#hintBtn').hidden = !settings.hints; };
$('#optHold').onchange = e => { settings.holdResult = e.target.checked; saveSettings(); };
$('#optReveal').onchange = e => { settings.revealAll = e.target.checked; saveSettings(); };
$('#optHud').onchange = e => { settings.hud = e.target.checked; saveSettings(); if (S) render(); };
$('#soundBtn').onclick = () => { settings.sound = !settings.sound; if (settings.sound) Snd.init(); saveSettings(); applyPrefs(); };
$('#pauseBtn').onclick = () => {
  if (!S || !S.running) return;
  S.paused = !S.paused; const b = $('#pauseBtn');
  b.setAttribute('aria-pressed', String(S.paused));
  b.title = S.paused ? 'Resume dealing' : 'Pause after this hand';
  b.innerHTML = S.paused ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  toast(S.paused ? (S.handActive ? 'Pausing after this hand' : 'Paused') : 'Dealing resumes');
  renderControls();
};
$('#histBtn').onclick = () => { renderHistory(); $('#drawer').classList.add('open'); };
$('#histClose').onclick = () => $('#drawer').classList.remove('open');

// A saved table to resume (from this browser, or from the account when inside Claude).
/** @type {any} */
let resumeSnap = null;
// Connect to saved progress and Claude coaching when the page runs inside Claude.
(async () => {
  if (!window.claude || typeof window.claude.use !== 'function') return;
  try {
    const [db, user, sample] = await Promise.all([window.claude.use('db'), window.claude.use('user'), window.claude.use('sample')]);
    if (sample) sampleFn = sample;
    if (db && user){
      const uid = await user.id();
      if (uid){
        DBX = {db, uid};
        const snap = await db.doc('players/' + uid).get();
        if (snap.exists){ const d = snap.data(); if (d && (d.hands || 0) > (prof.hands || 0)){ prof = Object.assign(blankProf(), JSON.parse(JSON.stringify(d))); saveLocal(PKEY, prof); } }
        const ts = await db.doc('players/' + uid + '/state/table').get();
        if (ts.exists){
          const d = validSnap(JSON.parse(JSON.stringify(ts.data())));
          const localTs = (loadLocal('river-room-table', {}) || {}).ts || 0;
          if (d && (!resumeSnap || (d.ts || 0) >= (resumeSnap.ts || 0))){ resumeSnap = d; if (!S || !S.running) updateResumeBtn(); }
          else if (!d && (ts.data() || {}).done && (ts.data().ts || 0) > localTs && resumeSnap && !resumeSnap.fromHot){ resumeSnap = null; updateResumeBtn(); }
        }
      }
    }
  } catch (e) { /* run without saving to the account */ }
})();

if (window.claude && window.claude.hot && window.claude.hot.snapshot){
  try { window.claude.hot.snapshot(() => ({snap: S && S.running ? S.snap : null})); } catch (e) {}
}

/* ================= online: the same table, dealt by the server ================= */
// The server (server/src/room.ts) runs the engine and sends each person their own redacted copy
// of the game plus each engine step (src/net/wire.ts). This screen replays those steps with the
// same animations as single-player, and answers what the server asks *you*: your action, your
// dealer's choice, your split, your rebuy. Your answers go to the server, never to a local engine.
const MP_SERVER = import.meta.env.VITE_MP_SERVER_URL || 'http://localhost:8080';
const OKEY = 'river-room-online', WAKE_NOTICE_MS = 1500, WAKE_LIMIT_MS = 120000;
/** @type {any} */
let ON = null;
let sockP = null, olMode = 'create', olGames = null, olPeek = null, olPick = null, everConnected = false, rosterHome = null;

function onlineSession(x){ if (x) saveLocal(OKEY, x); else { try { localStorage.removeItem(OKEY); } catch (e) {} } }
function olStatus(t){ $('#olConn').textContent = t; }
function olError(t){ $('#olErr').textContent = t || ''; }
function waking(on){ $('#olWake').hidden = !on; if (on) olStatus('Waking up the server…'); }

/** The socket (one per page). Connects on first use; the free server may need a minute to wake. */
function socket(){
  if (sockP) return sockP;
  sockP = import('socket.io-client').then(({io}) => {
    const sock = io(MP_SERVER, {transports: ['websocket']});
    const started = Date.now();
    const wakeT = setTimeout(() => { if (!sock.connected) waking(true); }, WAKE_NOTICE_MS);
    sock.on('connect', () => {
      everConnected = true; clearTimeout(wakeT); waking(false); olStatus('Connected');
      // after a dropped connection, take the seat back
      if (ON && ON.token) sock.emit('resume', {code: ON.code, token: ON.token}, r => { if (!r || !r.ok) leaveOnline('That table has closed.', true); });
    });
    sock.on('disconnect', () => { olStatus('Reconnecting…'); if (S && S.online) toast('Connection lost. Reconnecting…', 2400); });
    sock.on('connect_error', () => {
      if (!everConnected && Date.now() - started < WAKE_LIMIT_MS) { waking(true); return; }
      waking(false); olStatus('Cannot reach the game server');
    });
    sock.on('table', m => { if (!ON) return; ON.queue.push(m); pump(); });
    sock.on('removed', m => leaveOnline(m && m.reason === 'out_of_chips' ? 'You ran out of chips and did not rebuy, so the computer took your seat. Your buy-ins stay in the table\'s ledger.' : 'The computer took your seat.', true));
    return sock;
  });
  return sockP;
}
/** Send and wait for the reply; waits for a connection first (up to two minutes while the server wakes). */
async function call(ev, msg){
  const sock = await socket();
  if (!sock.connected) {
    const ok = await new Promise(res => { const t = setTimeout(() => { sock.off('connect', on); res(false); }, everConnected ? 8000 : WAKE_LIMIT_MS); const on = () => { clearTimeout(t); res(true); }; sock.once('connect', on); });
    if (!ok) return {ok: false, error: 'no answer from the server'};
  }
  return new Promise(res => sock.timeout(10000).emit(ev, msg, (err, r) => res(err ? {ok: false, error: 'no answer from the server'} : r)));
}

/* ---- lobby ---- */
function openLobby(mode, code){
  olMode = mode; olError('');
  $('#startOv').hidden = true;
  $('#onlineOv').hidden = false;
  $('#olCreate').hidden = mode !== 'create';
  $('#olJoin').hidden = mode !== 'join';
  $('#olTitle').textContent = mode === 'join' ? `Join table ${code}` : 'Play online with friends';
  $('#olLede').textContent = mode === 'join'
    ? 'A friend invited you to their table. Pick who you play; the computer plays everyone nobody picks, in their own style.'
    : 'Start a table and share the invite link. Everyone picks who they play; the computer plays the rest, each in their own style. The server deals and keeps everyone\'s cards private.';
  if (mode === 'create') {
    // the same roster editor as the home game, moved into the lobby while it is open
    const r = $('#homeRoster');
    if (!rosterHome) rosterHome = {parent: r.parentNode, next: r.nextSibling};
    $('#olRosterHost').appendChild(r);
    renderHomeRoster();
    if (!olGames) olGames = settings.games === 'holdem' ? 'holdem' : 'dealer';
    segment($('#olGamesSeg'), [['dealer', "Dealer's choice", '3 Patti, two boards...'], ['holdem', 'Simple poker', "Just Hold'em"]], () => olGames, v => { olGames = v; });
  } else void peekTable(code);
  void socket();
  history.replaceState(null, '', mode === 'join' ? `/?join=${code}` : '/?online');
}
function closeLobby(){
  $('#onlineOv').hidden = true;
  if (rosterHome) { rosterHome.parent.insertBefore($('#homeRoster'), rosterHome.next); rosterHome = null; renderHomeRoster(); }
}
async function peekTable(code){
  $('#olPick').innerHTML = '<legend>Who do you play as?</legend><p class="fine">Looking up the table…</p>';
  $('#olJoinBtn').disabled = true;
  const r = await call('peek', {code});
  if (!r || !r.ok) { $('#olPick').innerHTML = ''; olError(r && r.error === 'no such room' ? 'No table with that code: it may have closed. Ask your friend for a new link, or start your own table.' : 'Could not reach the table: ' + (r ? r.error : 'no answer')); return; }
  olPeek = r;
  const free = r.roster.filter(c => !c.taken);
  if (!olPick || !free.some(c => c.id === olPick)) olPick = free[0] ? free[0].id : null;
  $('#olPick').innerHTML = `<legend>Who do you play as?</legend>` + r.roster.map(c => `<div class="rp${c.taken ? ' taken' : ''}${c.id === olPick ? ' me' : ''}" data-id="${c.id}">`
    + `<label class="rp-main"><input type="radio" name="olPick" value="${c.id}"${c.taken ? ' disabled' : ''}${c.id === olPick ? ' checked' : ''}><span class="mini-av">${faceHTML(c)}</span>`
    + `<span class="rp-text"><span class="rp-line"><b>${esc(c.name)}</b>${c.taken ? '<em class="rp-taken">Taken</em>' : ''}</span><small>${c.taken ? 'Someone is playing this seat' : 'The computer plays: ' + esc(c.style)}</small></span></label></div>`).join('')
    + (free.length ? '' : '<p class="fine">Everyone at this table is taken.</p>');
  $('#olJoinBtn').disabled = !olPick;
  $('#olJoinBtn').textContent = olPick ? `Join as ${r.roster.find(c => c.id === olPick).name}` : 'Join the table';
}
$('#olPick').addEventListener('change', e => { olPick = /** @type {HTMLInputElement} */ (e.target).value; if (olPeek) { $$('#olPick .rp').forEach(el => el.classList.toggle('me', el.getAttribute('data-id') === olPick)); $('#olJoinBtn').textContent = `Join as ${olPeek.roster.find(c => c.id === olPick).name}`; } });
$('#olCreateBtn').onclick = async () => {
  const r = rosterNow(), hero = heroIdNow(r), btn = $('#olCreateBtn');
  btn.disabled = true; olError('');
  const res = await call('create', {character: hero, games: olGames, roster: r.map(c => ({id: c.id, name: c.name, type: c.type, color: c.color}))});
  btn.disabled = false;
  if (!res.ok) { olError('Could not start the table: ' + res.error); return; }
  enterOnline(res.code, res.token);
};
$('#olJoinBtn').onclick = async () => {
  const code = olPeek && olPeek.code, btn = $('#olJoinBtn');
  if (!code || !olPick) return;
  btn.disabled = true; olError('');
  const res = await call('join', {code, character: olPick});
  btn.disabled = false;
  if (!res.ok) { olError(res.error === 'no such room' ? 'That table has closed.' : res.error); void peekTable(code); return; }
  enterOnline(res.code, res.token);
};
$('#olToCreate').onclick = () => openLobby('create');
$('#olBack').onclick = () => { closeLobby(); history.replaceState(null, '', '/'); buildStart(!!resumeSnap); $('#startOv').hidden = false; };
$('#onlineBtn').addEventListener('click', e => { e.preventDefault(); openLobby('create'); });

/* ---- at the table ---- */
function enterOnline(code, token){
  ON = {code, token, queue: [], busy: false, lastSeq: 0, answering: null, done: new Set(), msg: null, saved: {revealAll: settings.revealAll}};
  onlineSession({code, token});
  // stop any single-player game; the next message from the server builds the online table
  if (pending) submit(null);
  GID++; S = null;
  history.replaceState(null, '', `/?join=${code}`);
  $('#olCreate').hidden = true; $('#olJoin').hidden = true;
  $('#olTitle').textContent = `Table ${code}`;
  $('#olLede').textContent = 'You are in. Taking your seat…';
}
/** Leave the online table (or lose it), back to the lobby or the start screen. */
function leaveOnline(msg, lost){
  if (!ON) return;
  const code = ON.code;
  if (!lost) void call('leave', {});
  cancelAnswer();
  settings.revealAll = ON.saved.revealAll;
  ON = null; onlineSession(null);
  GID++; S = null;
  $('#tableBtn').hidden = true; $('#pauseBtn').hidden = false; $('#tableOv').hidden = true; $('#act').hidden = true;
  $$('#dealOv,#splitOv,#rebuyOv,#revOv').forEach(el => { el.hidden = true; });
  setupTable(null);
  openLobby('create');
  olError(msg || '');
  void code;
}
async function pump(){
  if (!ON || ON.busy) return;
  ON.busy = true;
  try {
    while (ON && ON.queue.length) {
      const m = ON.queue.shift();
      ON.msg = m;
      if (m.you < 0) { waitingForSeat(m); continue; }
      hydrate(m);
      const fresh = m.step && m.seq > ON.lastSeq;
      if (fresh) { ON.lastSeq = m.seq; await onlineStep(decodeStep(m.step, /** @type {any} */ (S.players)), m); }
      else { render(); renderInfo(); renderControls(); }
      if (ON) { syncAsk(m); renderTablePanel(); }
    }
  } catch (e) { if (!(e instanceof Abort)) console.error(e); }
  finally { if (ON) ON.busy = false; }
  if (ON && ON.queue.length) void pump();
}
/** You joined during a hand: you sit down when it ends. */
function waitingForSeat(m){
  const me = m.roster.find(c => c.you);
  $('#onlineOv').hidden = false; $('#olCreate').hidden = true; $('#olJoin').hidden = true;
  $('#olTitle').textContent = `Table ${m.code}`;
  $('#olLede').textContent = `You are in${me ? ' as ' + me.name : ''}. You sit down when the current hand ends.`;
}
function hydrate(m){
  if (!S || !S.online) {
    GID++; MONEY = true;
    settings.revealAll = false;
    S = /** @type {any} */ ({gid: GID, online: true, history: [], dec: [], decPending: [], decPre: null, feed: [], pre: null, heroEq: null, paused: false, running: true, splitDec: null, hintBest: null, snap: null,
      tablesReady: Promise.resolve(), rs: new Streams(null), btab: new Map(), lastThreat: null, stats: {hands: 0, won: 0, vpip: 0, pfr: 0, biggest: 0, sd: 0, sdWon: 0}, layoutKey: '', handNo: -1, players: []});
    S.tables = new Tables(S.rs);
    bindGame(S, true, settings);
    const myGid = GID;
    S.tablesReady = compute({type: 'tables', seed: null}).then(t => { if (S && S.gid === myGid) S.tables.adopt(t); }).catch(err => console.error(err));
    closeLobby();
    $('#startOv').hidden = true;
    $('#tableBtn').hidden = false; $('#pauseBtn').hidden = true;
    renderHistory(); renderFeed();
    toast(`You are playing as ${m.roster.find(c => c.you).name}. Invite friends from the players button at the top.`, 4200);
  }
  const d = decodeGame(m.game, /** @type {any} */ (S.players));
  if (S.handNo !== d.handNo) { S.dec = []; S.decPending = []; S.decPre = null; S.splitDec = null; S.hintBest = null; S.heroEq = null; S.pre = null; }
  // the computer players' public base style (for chat and pacing); other people get none, so
  // the app never puts words in a real person's mouth
  for (const p of /** @type {any[]} */ (d.players)) p.persona = p.type && TYPES[p.type] ? TYPES[p.type] : Object.assign({}, TYPES.sumer, {chat: 0, slow: 0, quickFold: false});
  Object.assign(S, d);
  S.settings = Object.assign({}, settings, {games: m.games, revealAll: false});
  S.mode = 'home'; S.money = true;
  const key = S.players.map(p => [p.seat, p.name, p.avatar, p.color, p.isHuman].join(':')).join('|');
  if (key !== S.layoutKey) { S.layoutKey = key; buildSeats(); layout(); }
}
async function onlineStep(s, m){
  const me = heroP();
  if (s.kind === 'act') {
    S.turnStart = performance.now(); S.turnLen = m.wait && m.wait.deadline ? Math.max(1000, m.wait.deadline - Date.now()) : 30000; S.warned = false;
    render(); renderControls(); return;
  }
  if (s.kind === 'plans') {
    render();
    if (!S.tipArr && me && !me.out) { S.tipArr = true; toast('Your cards are in the order they were dealt. Tap them to arrange them your way; tap Hint for ideas. Your final split happens at the showdown.', 6000); }
    return;
  }
  if (s.kind === 'pause') { await pauseFx(s, {hero: me, prevLevel: S.level}); return; }
  render(); renderControls();
}
/** Start answering what the server asks you, once per question; close it if the server moved on. */
function syncAsk(m){
  const a = m.ask, key = a ? a.kind + ':' + a.deadline : null;
  if (ON.answering && ON.answering !== key) cancelAnswer();
  if (!a || ON.answering === key || ON.done.has(key)) return;
  ON.answering = key;
  void answerAsk(a, key);
}
async function answerAsk(a, key){
  const me = heroP();
  let ev = null, val = null;
  try {
    if (!me) return;
    if (a.kind === 'act') {
      const o = options(me), pot = potTotal();
      S.turnStart = performance.now(); S.turnLen = Math.max(1000, a.deadline - Date.now()); S.warned = false;
      S.decPre = {snap: toPlain(S), pi: me.i, label: S.rs.label(S.handNo, 'coach'), hint: null};
      const res = await humanAction(me, {need: o.toCall > 0 ? o.toCall / (pot + o.toCall) : 0, pos: posInfo(me), eq: null});
      if (res) { ev = 'act'; val = res; }
    } else if (a.kind === 'variant') {
      const v = await pickVariant(me, a.variants);
      if (v) { ev = 'variant'; val = {variant: v}; }
    } else if (a.kind === 'split') {
      const sp = await heroSplit(me, a.k, 'final');
      if (sp) { try { gradeSplit(me, sp, a.k); } catch (e) { console.error(e); } ev = 'split'; val = {groups: sp}; }
    } else if (a.kind === 'rebuy') {
      const c = await askRebuy();
      if (c) { ev = 'rebuy'; val = {yes: c === 'yes'}; }
    }
  } finally {
    if (ON && ON.answering === key) ON.answering = null;
  }
  if (ON && ev) {
    ON.done.add(key);
    const r = await call(ev, val);
    if (r && !r.ok && ON) toast(r.error, 2600);
  }
}
/** The server answered for you (time ran out) or moved on: close whatever is waiting for you. */
function cancelAnswer(){
  if (pending) submit(null);
  if (dealWait) { const r = dealWait; dealWait = null; $('#dealOv').hidden = true; r(null); }
  if (splitWait) { const r = splitWait; splitWait = null; $('#splitOv').hidden = true; spState = null; r(null); }
  if (rebuyWait) { const r = rebuyWait; rebuyWait = null; $('#rebuyOv').hidden = true; r(null); }
  if (ON) ON.answering = null;
}

/* ---- the table panel: invite link, players (the creator edits them), settle up ---- */
const inviteUrl = code => `${location.origin}/?join=${code}`;
function renderTablePanel(){
  if (!ON || !ON.msg || $('#tableOv').hidden) return;
  const m = ON.msg, link = inviteUrl(m.code);
  $('#tpCode').textContent = m.code;
  const a = $('#tpLink');
  if (a.getAttribute('href') !== link) { a.setAttribute('href', link); a.textContent = link.replace(/^https?:\/\//, ''); }
  $('#tpWho').textContent = m.creator ? `You started this table, so you manage the players.${m.pendingEdits ? ' Your changes apply when this hand ends.' : ' Changes made during a hand apply when it ends.'}` : 'The person who started the table manages the players.';
  $('#tpRoster').innerHTML = m.roster.map(c => `<div class="rp${c.you ? ' me' : ''}" data-id="${c.id}"><span class="rp-main"><span class="mini-av">${faceHTML(c)}</span><span class="rp-text"><span class="rp-line"><b>${esc(c.name)}</b>${c.you ? '<em class="rp-you">You</em>' : c.taken ? `<em class="rp-taken">${c.connected ? 'Playing' : 'Away'}</em>` : ''}</span><small>${c.taken ? (c.you ? 'You play this seat' : 'A person plays this seat') : 'The computer plays: ' + esc(c.style)}</small></span></span>`
    + (m.creator ? `<span class="rp-tools"><button type="button" class="rp-btn" data-act="rename" aria-label="Rename ${esc(c.name)}">Rename</button>${c.taken ? '' : `<button type="button" class="rp-btn" data-act="remove" aria-label="Remove ${esc(c.name)}"${m.roster.length <= ROSTER_MIN ? ' disabled' : ''}>Remove</button>`}</span>` : '')
    + `</div>`).join('');
  $('#tpAdd').hidden = !m.creator || m.roster.length >= ROSTER_MAX;
  if (!$('#tpNewStyle').options.length) $('#tpNewStyle').innerHTML = STYLES.map(t => `<option value="${t}">Plays like: ${esc(styleLabel(t))}</option>`).join('');
}
$('#tableBtn').onclick = () => { $('#tableOv').hidden = false; renderTablePanel(); $('#tpSettleOut').hidden = true; setTimeout(() => $('#tpClose').focus(), 50); };
$('#tpClose').onclick = () => { $('#tableOv').hidden = true; };
$('#tpCopy').onclick = async () => {
  if (!ON) return;
  try { await navigator.clipboard.writeText(inviteUrl(ON.code)); $('#tpCopy').textContent = 'Copied'; } catch (e) { $('#tpCopy').textContent = 'Select the link to copy it'; }
  setTimeout(() => { $('#tpCopy').textContent = 'Copy'; }, 2500);
};
$('#tpLeave').onclick = () => leaveOnline('You left the table.');
async function rosterEdit(msg){
  $('#tpErr').textContent = '';
  const r = await call('roster', msg);
  if (!r.ok) { $('#tpErr').textContent = r.error; return false; }
  if (r.queued) toast('Done. It applies when this hand ends.', 2400);
  return true;
}
$('#tpRoster').addEventListener('click', async e => {
  const b = /** @type {HTMLElement} */ (e.target).closest('button'); if (!b || !ON) return;
  const row = b.closest('.rp'), id = row.getAttribute('data-id'), c = ON.msg.roster.find(x => x.id === id);
  if (b.getAttribute('data-act') === 'rename') {
    const name = prompt(`New name for ${c.name}`, c.name);
    if (name !== null && name.trim() !== c.name) await rosterEdit({op: 'rename', id, name});
  } else if (b.getAttribute('data-act') === 'remove') await rosterEdit({op: 'remove', id});
});
$('#tpAddBtn').onclick = async () => { if (await rosterEdit({op: 'add', name: /** @type {HTMLInputElement} */ ($('#tpNewName')).value, type: /** @type {HTMLSelectElement} */ ($('#tpNewStyle')).value})) /** @type {HTMLInputElement} */ ($('#tpNewName')).value = ''; };
$('#tpNewName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#tpAddBtn').click(); } });
$('#tpSettle').onclick = async () => {
  const out = $('#tpSettleOut');
  out.hidden = false; out.textContent = 'Adding it up…';
  const r = await call('settle', {});
  if (!r.ok) { out.textContent = 'Could not load the settlement: ' + r.error; return; }
  const signed = c => (c > 0 ? '+' : c < 0 ? '−' : '') + fmt(Math.abs(c));
  const people = r.transfers.filter(t => t.from !== 'Computer players' && t.to !== 'Computer players');
  const house = r.transfers.filter(t => t.from === 'Computer players' || t.to === 'Computer players');
  out.innerHTML = `<table><caption class="sr">Balance per player</caption><thead><tr><th scope="col">Player</th><th scope="col">Up or down</th></tr></thead><tbody>${r.balances.map(b => `<tr><td>${esc(b.name)}</td><td class="${b.net < 0 ? 'neg' : 'pos'}">${signed(b.net)}</td></tr>`).join('')}</tbody></table>`
    + `<ul class="tp-pay">${people.length ? people.map(t => `<li><b>${esc(t.from)}</b> pays <b>${esc(t.to)}</b> ${fmt(t.amount)}</li>`).join('') : '<li>Nobody owes anybody.</li>'}</ul>`
    + `<p class="fine">${[...house.map(t => t.to === 'Computer players' ? `${esc(t.from)} lost ${fmt(t.amount)} to the computer players (no payment).` : `${esc(t.to)} won ${fmt(t.amount)} from the computer players (nobody pays this).`),
      r.stored ? 'Totals come from the saved buy-in ledger.' : 'Totals come from this table session.',
      r.saved ? `Saved for this table: ${r.saved.hands} finished hand${r.saved.hands === 1 ? '' : 's'}, ${r.saved.buyins} buy-in${r.saved.buyins === 1 ? '' : 's'} and rebuys, ${r.saved.cashouts} cash-out${r.saved.cashouts === 1 ? '' : 's'}.` : ''].filter(Boolean).join(' ')}</p>`;
  if (r.matchesMemory !== undefined) out.dataset.matchesMemory = String(r.matchesMemory);
};

/** On load: back to an online table you were at, or the lobby an invite link points to. */
async function startOnlineFromUrl(){
  const q = new URLSearchParams(location.search), join = (q.get('join') || q.get('code') || '').trim().toUpperCase(), saved = loadLocal(OKEY, null);
  if (saved && saved.code && saved.token && (!join || join === saved.code)) {
    openLobby('join', saved.code);
    $('#olJoin').hidden = true; $('#olLede').textContent = 'Taking your seat back…';
    const r = await call('resume', {code: saved.code, token: saved.token});
    if (r && r.ok) { enterOnline(saved.code, saved.token); return; }
    onlineSession(null);
    if (!join) { openLobby('create'); olError('Your last online table has closed.'); return; }
  }
  if (/^[A-Z2-9]{6}$/.test(join)) openLobby('join', join);
  else if (q.has('online')) openLobby('create');
}

function start(data){
  const hot = data && validSnap(data.snap) ? Object.assign({}, data.snap, {fromHot: true, ts: Date.now()}) : null;
  resumeSnap = hot || validSnap(loadLocal('river-room-table', null));
  applyPrefs();
  setupTable(null);
  buildStart(!!resumeSnap);
  updateResumeBtn();
  void startOnlineFromUrl();
}
if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start);
else start((window.claude && window.claude.hot && window.claude.hot.data) || {});
