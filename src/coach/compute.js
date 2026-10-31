// The heavy work, in a form that can run anywhere (the compute Web Worker, the page as a
// fallback, or Node tests): opponent-model tables, bot decisions, coach hints and grades.
//
// Each job gets a plain snapshot of the game (no DOM, no functions) and returns plain data.
// Randomness comes from named seeded streams (labels chosen by the page), so the same job
// on the same snapshot gives the same answer wherever and whenever it runs. That is what
// lets the coach grade a decision later, at the end of the hand, without changing the grade.
import { botAction } from '../ai/bots';
import { Streams } from '../engine/rng';
import { Tables } from '../engine/strength';
import { bindGame, coachContext, coachRec, gradeDecision } from './coach.js';

/* ---- snapshots ---- */
// engine helpers, page-only state, and the coach's own snapshots (never nested)
const SKIP = new Set(['rs', 'tables', 'btab', 'snap', 'history', 'feed', 'el', 'dec', 'decPending', 'decPre', 'tablesReady']);

/** A plain, cloneable copy of the game state, with references between players kept. */
export function toPlain(g) {
  const map = new Map();
  const players = g.players.map(p => {
    const o = {};
    for (const k of Object.keys(p)) if (!SKIP.has(k) && typeof p[k] !== 'function') o[k] = p[k];
    map.set(p, o);
    return o;
  });
  const fix = (v, depth) => {
    if (!v || typeof v !== 'object') return v;
    if (map.has(v)) return map.get(v);
    if (depth > 8) return undefined;
    if (Array.isArray(v)) return v.map(x => fix(x, depth + 1));
    if (v instanceof Set || v instanceof Map || ArrayBuffer.isView(v)) return v;
    if (Object.getPrototypeOf(v) !== Object.prototype) return undefined;
    const o = {};
    for (const k of Object.keys(v)) if (!SKIP.has(k) && typeof v[k] !== 'function') o[k] = fix(v[k], depth + 1);
    return o;
  };
  for (const o of players) for (const k of Object.keys(o)) o[k] = fix(o[k], 1);
  const out = {};
  for (const k of Object.keys(g)) {
    if (SKIP.has(k) || typeof g[k] === 'function') continue;
    out[k] = k === 'players' ? players : fix(g[k], 0);
  }
  return out;
}

const tablesBySeed = new Map();
/** One set of opponent-model tables per table seed (null = live play, random sample). */
export function tablesFor(seed) {
  let t = tablesBySeed.get(seed);
  if (!t) { t = new Tables(new Streams(seed)); tablesBySeed.set(seed, t); }
  return t;
}

/** Rebuild a working game from a snapshot. */
export function fromPlain(plain, seed) {
  return Object.assign(plain, { rs: new Streams(seed), tables: tablesFor(seed), btab: new Map(), lastThreat: null });
}

/* ---- jobs ---- */
/** Build the split-game opponent model for every variant (the 8-card one takes about 0.75 s). */
export function computeTables(seed) {
  const t = tablesFor(seed);
  for (const k of ['std', 'two', 'n7', 'k8']) t.oppDist(k);
  t.h5Tab();
  return t.exportBuilt();
}

/** Fields a bot decision may change on its own player (split plans and bot memory). */
const BOT_FIELDS = ['hf', '_eq', 'parts', 'cards', 'extra', '_plan', '_planKey'];
export function computeBot({ snap, seed, pi, label, money, settings }) {
  const g = fromPlain(snap, seed), p = g.players[pi];
  bindGame(g, money, settings);
  const action = botAction(g, p, label);
  const patch = {};
  for (const k of BOT_FIELDS) patch[k] = p[k];
  return { action, patch };
}

/** The coach's read of a decision and its recommendation (for the Hint panel). */
export function computeHint({ snap, seed, pi, label, recLabel, money, settings }) {
  const g = fromPlain(snap, seed);
  bindGame(g, money, settings);
  const ctx = g.rs.seg(label, () => coachContext(g.players[pi]));
  const rec = g.rs.seg(recLabel, () => coachRec(ctx));
  return { ctx, rec };
}

/**
 * Grade a decision after the fact, exactly as if it had been graded at the time:
 * the read uses the state before the action, the recommendation the state right after it
 * (as the original did), with the same seeded streams.
 */
export function computeGrade({ pre, post, seed, pi, label, recLabel, act, money, settings }) {
  const g1 = fromPlain(pre, seed);
  bindGame(g1, money, settings);
  const ctx = g1.rs.seg(label, () => coachContext(g1.players[pi]));
  // the original's read held live player objects; point them at the after-action state
  const g2 = fromPlain(post, seed);
  for (const k of ['main', 'raiser']) if (ctx[k] && typeof ctx[k].i === 'number') ctx[k] = g2.players[ctx[k].i];
  bindGame(g2, money, settings);
  const rec = g2.rs.seg(recLabel, () => coachRec(ctx));
  return { ctx, act, rec, g: gradeDecision(ctx, act, rec) };
}

export function run(job) {
  switch (job.type) {
    case 'tables': return computeTables(job.seed);
    case 'bot': return computeBot(job);
    case 'hint': return computeHint(job);
    case 'grade': return job.items.map(it => computeGrade({ ...it, seed: job.seed, money: job.money, settings: job.settings }));
    default: throw new Error('unknown job ' + job.type);
  }
}
