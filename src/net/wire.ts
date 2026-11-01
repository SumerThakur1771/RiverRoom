// The online table's wire format: the game state and each engine step, as plain JSON, with
// everything a viewer must not see taken out. The server encodes once per viewer; the page
// decodes into a game object the single-player table screen can render as is.
//
// This file is the anti-cheat boundary, so it is a whitelist: a field reaches a client only if
// it is listed here. Players are sent by index ({"$p": 2}) instead of by object.
import type { Step } from '../engine/engine';
import type { Game, Player } from '../engine/state';

/** A hidden card. Hidden hands keep their length, so the table can draw the right number of backs. */
export const HIDDEN = -1;

/** May `viewer` (a player index; -1 = watching, not seated) see player `p`'s cards? */
export function canSee(p: Player, viewer: number): boolean {
  return p.i === viewer || (p.shown && !p.folded && !p.mucked);
}

/** Facts anyone at the table can see. */
const PUBLIC_PLAYER = [
  'i', 'seat', 'name', 'type', 'color', 'avatar', 'stack', 'out', 'place', 'buyins', 'start', 'vis', 'folded', 'allIn', 'bet', 'total',
  'acted', 'actedAt', 'raiseLocked', 'label', 'shown', 'justShown', 'mucked', 'revealed', 'won', 'winner', 'hud', 'read', 'splitDone', 'partWin',
  // the table's read of each player's range, built from public actions only (src/engine/reads.ts)
  'rg',
] as const;
/** The hand itself and what is worked out from it: the owner's, or everyone's once shown. */
const HAND_PLAYER = ['cards', 'all', 'extra', 'parts', 'plan', 'handName', 'pname', 'pscore', 'score', 'eq', 'eqAtReveal', 'vrank'] as const;
// Per-hand play flags (hf: saw the flop, went to showdown, raised...) are public, except
// hadDraw, which comes from the player's own cards. Never sent: persona, tilt, mem, _plan, _eq
// (the computer players' private reasoning).
const PUBLIC_GAME = [
  'mode', 'money', 'handNo', 'button', 'sbIdx', 'bbIdx', 'level', 'sb', 'bb', 'ante', 'variant', 'pot', 'street', 'currentBet', 'minRaise', 'toAct',
  'lastAggressor', 'pfAggressor', 'cbetMade', 'streetRaises', 'revealed', 'tableNo', 'entrants', 'msg', 'explain', 'sideInfo', 'highlight', 'handActive',
] as const;
// Never sent: deck, nextDeck, rs, tables, btab, stats (the single-player session's own).

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type WirePlayer = Record<string, Json> & { i: number; name: string; isHuman: boolean; human: boolean };
export interface WireGame {
  players: WirePlayer[]; board: number[]; board2: number[]; boardVis: number; boardVis2: number; hist: string[]; ev: Json[]; settings: { games: string };
  handNo: number; button: number; street: number; pot: number; currentBet: number; minRaise: number; variant: string | null; msg: string;
  [k: string]: Json | WirePlayer[] | number[] | string[] | Json[] | { games: string } | undefined;
}
export type WireStep = Record<string, Json> & { kind: Step['kind'] };

/** Plain JSON copy; players become {"$p": index}. Maps, sets, functions and class instances are dropped. */
function enc(v: unknown, index: Map<object, number>, depth = 0): Json | undefined {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v as Json;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'object' || depth > 8) return undefined;
  const pi = index.get(v);
  if (pi !== undefined) return { $p: pi };
  if (Array.isArray(v)) return v.map(x => enc(x, index, depth + 1) ?? null);
  if (Object.getPrototypeOf(v) !== Object.prototype) return undefined;
  const o: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v)) { const e = enc(x, index, depth + 1); if (e !== undefined) o[k] = e; }
  return o;
}

function encodePlayer(p: Player, viewer: number, index: Map<object, number>): WirePlayer {
  const src = p as unknown as Record<string, unknown>;
  const o: Record<string, Json> = {};
  for (const k of PUBLIC_PLAYER) { const e = enc(src[k], index, 1); if (e !== undefined) o[k] = e; }
  const hf = { ...(p.hf ?? {}) } as Record<string, unknown>;
  if (canSee(p, viewer)) {
    for (const k of HAND_PLAYER) { const e = enc(src[k], index, 1); if (e !== undefined) o[k] = e; }
  } else {
    delete hf.hadDraw;
    o.cards = p.cards.map(() => HIDDEN);
    o.all = (p.all ?? []).map(() => HIDDEN);
  }
  o.hf = enc(hf, index, 1) ?? {};
  // to the table screen, "the human" is the person looking at it; `human` says whether a person plays this seat
  return { ...o, i: p.i, name: p.name, isHuman: p.i === viewer, human: p.isHuman } as WirePlayer;
}

/** History lines another person must not see: their "Dealt to" line, and a split before it is shown. */
function privateLine(line: string, g: Game, viewer: number): boolean {
  const m = /^Dealt to (.+?) \[/.exec(line) ?? /^(.+?) splits: /.exec(line);
  if (!m) return false;
  const p = g.players.find(x => x.name === m[1]);
  return !p || !canSee(p, viewer);
}

/** The game as `viewer` may see it. */
export function encodeGame(g: Game, viewer: number): WireGame {
  const index = new Map<object, number>(g.players.map((p, i) => [p, i]));
  const src = g as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_GAME) { const e = enc(src[k], index); if (e !== undefined) out[k] = e; }
  out.players = g.players.map(p => encodePlayer(p, viewer, index));
  out.boardVis = g.boardVis;
  out.boardVis2 = g.boardVis2;
  out.board = g.board.slice(0, g.boardVis);
  out.board2 = g.board2.slice(0, g.boardVis2);
  out.hist = g.hist.filter(l => !privateLine(l, g, viewer));
  // events: drop the practice view ("all": everyone's cards); the rest are public table actions
  out.ev = g.ev.filter(e => e.t !== 'all').map(e => enc(e, index) ?? null);
  out.settings = { games: g.settings.games };
  return out as unknown as WireGame;
}

/** An engine step as `viewer` may see it (players by index). */
export function encodeStep(s: Step, g: Game): WireStep {
  const index = new Map<object, number>(g.players.map((p, i) => [p, i]));
  return (enc(s, index) ?? { kind: s.kind }) as WireStep;
}

/* ---- the page's side ---- */
type Obj = Record<string, unknown>;
/** Turn {"$p": i} back into player objects. */
function dec(v: unknown, players: Obj[]): unknown {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => dec(x, players));
  const o = v as Obj;
  if (typeof o.$p === 'number' && Object.keys(o).length === 1) return players[o.$p];
  const r: Obj = {};
  for (const [k, x] of Object.entries(o)) r[k] = dec(x, players);
  return r;
}

/**
 * Decode a game and a step into plain objects with player references restored. `keep` lists
 * page-only fields of the previous players (DOM elements) to carry over when the seat is the
 * same person.
 */
export function decodeGame(w: WireGame, prev?: ReadonlyArray<Obj>, keep: readonly string[] = ['el', 'betEl']): Obj & { players: Obj[] } {
  const players: Obj[] = w.players.map(p => ({ ...p }));
  for (const p of players) for (const k of Object.keys(p)) p[k] = dec(p[k], players);
  players.forEach((p, i) => {
    const old = prev?.[i];
    if (old && old.name === p.name && old.seat === p.seat) for (const k of keep) if (old[k] !== undefined) p[k] = old[k];
  });
  const out: Obj = { players };
  for (const [k, v] of Object.entries(w)) if (k !== 'players') out[k] = dec(v, players);
  return out as Obj & { players: Obj[] };
}
export function decodeStep(s: WireStep, players: Obj[]): Obj & { kind: Step['kind'] } {
  return dec(s, players) as Obj & { kind: Step['kind'] };
}
