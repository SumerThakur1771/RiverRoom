// The heavy work, in a form that can run anywhere (the compute Web Worker, the page as a
// fallback, or Node tests): opponent-model tables, bot decisions, coach hints and grades.
//
// Each job gets a plain snapshot of the game (no DOM, no functions) and returns plain data.
// Randomness comes from named seeded streams (labels chosen by the page), so the same job
// on the same snapshot gives the same answer wherever and whenever it runs. That is what
// lets the coach grade a decision later, at the end of the hand, without changing the grade.
import { botAction } from '../ai/bots';
import type { Action, ActionResult } from '../engine/engine';
import { Streams } from '../engine/rng';
import type { Player } from '../engine/state';
import { Tables } from '../engine/strength';
import type { VariantKey } from '../engine/variants';
import { bindGame, coachContext, coachRec, gradeDecision, type CoachCtx, type CoachGame, type CoachSettings, type Grade, type Rec } from './coach';

/** A cloneable copy of the game: no functions, no DOM, players referenced by object. */
export type Snapshot = Record<string, unknown> & { players: Array<Record<string, unknown>> };

/* ---- snapshots ---- */
// engine helpers, page-only state, and the coach's own snapshots (never nested)
const SKIP = new Set(['rs', 'tables', 'btab', 'snap', 'history', 'feed', 'el', 'dec', 'decPending', 'decPre', 'tablesReady']);
type Obj = Record<string, unknown>;

/** A plain, cloneable copy of the game state, with references between players kept. */
export function toPlain(g: object): Snapshot {
  const src = g as Obj & { players: Obj[] };
  const map = new Map<object, Obj>();
  const players = src.players.map(p => {
    const o: Obj = {};
    for (const k of Object.keys(p)) if (!SKIP.has(k) && typeof p[k] !== 'function') o[k] = p[k];
    map.set(p, o);
    return o;
  });
  const fix = (v: unknown, depth: number): unknown => {
    if (!v || typeof v !== 'object') return v;
    const hit = map.get(v);
    if (hit) return hit;
    if (depth > 8) return undefined;
    if (Array.isArray(v)) return v.map(x => fix(x, depth + 1));
    if (v instanceof Set || v instanceof Map || ArrayBuffer.isView(v)) return v;
    if (Object.getPrototypeOf(v) !== Object.prototype) return undefined;
    const o: Obj = {};
    for (const [k, x] of Object.entries(v)) if (!SKIP.has(k) && typeof x !== 'function') o[k] = fix(x, depth + 1);
    return o;
  };
  for (const o of players) for (const k of Object.keys(o)) o[k] = fix(o[k], 1);
  const out: Obj = {};
  for (const k of Object.keys(src)) {
    if (SKIP.has(k) || typeof src[k] === 'function') continue;
    out[k] = k === 'players' ? players : fix(src[k], 0);
  }
  return out as Snapshot;
}

const tablesBySeed = new Map<string | null, Tables>();
/** One set of opponent-model tables per table seed (null = live play, random sample). */
export function tablesFor(seed: string | null): Tables {
  let t = tablesBySeed.get(seed);
  if (!t) { t = new Tables(new Streams(seed)); tablesBySeed.set(seed, t); }
  return t;
}

/** Rebuild a working game from a snapshot. */
export function fromPlain(plain: Snapshot, seed: string | null): CoachGame {
  return Object.assign(plain, { rs: new Streams(seed), tables: tablesFor(seed), btab: new Map(), lastThreat: null }) as unknown as CoachGame;
}

/* ---- jobs ---- */
export type BuiltTables = ReturnType<Tables['exportBuilt']>;
/** Build the split-game opponent model for every variant (the 8-card one takes about 0.75 s). */
export function computeTables(seed: string | null): BuiltTables {
  const t = tablesFor(seed);
  for (const k of ['std', 'two', 'n7', 'k8'] as VariantKey[]) t.oppDist(k);
  t.h5Tab();
  return t.exportBuilt();
}

interface Common { seed: string | null; money: boolean; settings: CoachSettings }
export interface BotJob extends Common { type: 'bot'; snap: Snapshot; pi: number; label: string }
export interface HintJob extends Common { type: 'hint'; snap: Snapshot; pi: number; label: string; recLabel: string }
export interface GradeItem { pre: Snapshot; post: Snapshot; pi: number; label: string; recLabel: string; act: ActionResult }
export interface GradeJob extends Common { type: 'grade'; items: GradeItem[] }
export interface TablesJob { type: 'tables'; seed: string | null }
export type Job = BotJob | HintJob | GradeJob | TablesJob;

/** Fields a bot decision may change on its own player (split plans and bot memory). */
const BOT_FIELDS = ['hf', '_eq', 'parts', 'cards', 'extra', '_plan', '_planKey'] as const;
export type BotPatch = Partial<Pick<Player, (typeof BOT_FIELDS)[number]>>;
export function computeBot({ snap, seed, pi, label, money, settings }: Omit<BotJob, 'type'>): { action: Action; patch: BotPatch } {
  const g = fromPlain(snap, seed), p = g.players[pi]!;
  bindGame(g, money, settings);
  const action = botAction(g, p, label);
  const patch: BotPatch = {};
  for (const k of BOT_FIELDS) (patch as Record<string, unknown>)[k] = p[k];
  return { action, patch };
}

/** The coach's read of a decision and its recommendation (for the Hint panel). */
export function computeHint({ snap, seed, pi, label, recLabel, money, settings }: Omit<HintJob, 'type'>): { ctx: CoachCtx; rec: Rec } {
  const g = fromPlain(snap, seed);
  bindGame(g, money, settings);
  const ctx = g.rs.seg(label, () => coachContext(g.players[pi]!));
  const rec = g.rs.seg(recLabel, () => coachRec(ctx));
  return { ctx, rec };
}

export interface Graded { ctx: CoachCtx; act: ActionResult; rec: Rec; g: Grade }
/**
 * Grade a decision after the fact, exactly as if it had been graded at the time:
 * the read uses the state before the action, the recommendation the state right after it
 * (as the original did), with the same seeded streams.
 */
export function computeGrade({ pre, post, seed, pi, label, recLabel, act, money, settings }: GradeItem & Common): Graded {
  const g1 = fromPlain(pre, seed);
  bindGame(g1, money, settings);
  const ctx = g1.rs.seg(label, () => coachContext(g1.players[pi]!));
  // the original's read held live player objects; point them at the after-action state
  const g2 = fromPlain(post, seed);
  if (ctx.main) ctx.main = g2.players[ctx.main.i];
  if (ctx.raiser) ctx.raiser = g2.players[ctx.raiser.i] ?? null;
  bindGame(g2, money, settings);
  const rec = g2.rs.seg(recLabel, () => coachRec(ctx));
  return { ctx, act, rec, g: gradeDecision(ctx, act, rec) };
}

export function run(job: Job): unknown {
  switch (job.type) {
    case 'tables': return computeTables(job.seed);
    case 'bot': return computeBot(job);
    case 'hint': return computeHint(job);
    case 'grade': return job.items.map(it => computeGrade({ ...it, seed: job.seed, money: job.money, settings: job.settings }));
  }
}
