// Game state. Field names follow the original single-file game on purpose, so the existing
// rendering code can read this state with few changes.
import type { Card } from './cards';
import type { Streams } from './rng';
import type { Tables } from './strength';
import type { Split, VariantKey } from './variants';

export type Mode = 'home' | 'tourney';

export interface Persona {
  label: string; desc: string; beat: string;
  open: number; limp: number; limpTop: number; call: number; three: number; cbet: number; bluff: number; aggr: number;
  sticky: number; trap: number; cr: number; size: 'odd' | 'std' | 'big' | 'small' | 'home' | 'wild'; noise: number;
  tiltProne: number; adapt: number; tell: number; chat: number; donk: number;
  home?: boolean; raisePre?: number; bigValue?: number; bigFold?: boolean; quickFold?: boolean; stab?: number;
  overplay?: number; clueless?: boolean; slow?: number;
}

export interface Hud {
  hands: number; vpip: number; pfr: number; threeOpp: number; three: number; cbetOpp: number; cbet: number;
  agg: number; calls: number; sawFlop: number; wtsd: number; wsd: number; fcbOpp: number; fcb: number;
}
export const newHud = (): Hud => ({ hands: 0, vpip: 0, pfr: 0, threeOpp: 0, three: 0, cbetOpp: 0, cbet: 0, agg: 0, calls: 0, sawFlop: 0, wtsd: 0, wsd: 0, fcbOpp: 0, fcb: 0 });

/** What a player's actions this hand say about their cards (used to sample their range). */
export interface RangeInfo { top: number; low: number; agg: number; raised: boolean; calls: number; big: number }
/** Per-hand flags for the HUD and for bot memory. Keys like `checked1` are set dynamically. */
export interface HandFlags {
  preActed?: boolean; threeOpp?: boolean; vpip?: boolean; pfr?: boolean; three?: boolean;
  cbetOpp?: boolean; cbet?: boolean; fcbSeen?: boolean; fcbFold?: boolean; flopActed?: boolean;
  lastAggSt?: number; sawFlop?: boolean; sd?: boolean; wsd?: boolean; hadDraw?: number;
  [checked: `checked${number}`]: boolean | undefined;
}
export interface BotMemory { bluffs: number; strong: number; seen: number }

export interface Player {
  i: number; seat: number; name: string; isHuman: boolean; type: string | null; persona: Persona | null;
  color: string; avatar: string | null;
  stack: number; out: boolean; place: number; buyins: number; start: number;
  cards: Card[]; all: Card[]; extra: Card[][] | null; parts: Card[][] | null; plan: Split | null;
  splitDone: boolean; vrank: number | null; _plan: Split | null; _planKey?: string;
  vis: number; folded: boolean; allIn: boolean; bet: number; total: number; acted: boolean; raiseLocked: boolean;
  label: string; shown: boolean; justShown: boolean; mucked: boolean; revealed: boolean;
  score: number; handName: string; pscore: number[] | null; pname: string[] | null; partWin: boolean[] | null;
  won: number; winner: boolean; eq: number | null; eqAtReveal: number | null; _eq: number | null;
  hud: Hud; hf: HandFlags; rg: RangeInfo; tilt: number; read: boolean; mem: BotMemory | null;
}

export interface Pot { amount: number; eligible: Player[] }

/** Structured events, used by the hand story, bot memory and (later) the UI. */
export interface GameEvent { t: string; st?: number; p?: Player; amt?: number; [k: string]: unknown }

export interface Stats { hands: number; won: number; vpip: number; pfr: number; biggest: number; sd: number; sdWon: number }

export interface Settings {
  name: string; opp: number; stack: number; perLevel: number; revealAll: boolean; games: 'dealer' | 'holdem';
}

export interface Game {
  rs: Streams; tables: Tables; settings: Settings;
  mode: Mode; money: boolean;
  players: Player[]; handNo: number; button: number; sbIdx: number; bbIdx: number;
  level: number; sb: number; bb: number; ante: number;
  deck: Card[];
  /** Use this deck for the next hand instead of shuffling (replays and tests). */
  nextDeck: Card[] | null;
  board: Card[]; boardVis: number; board2: Card[]; boardVis2: number; variant: VariantKey | null;
  pot: number; street: number; currentBet: number; minRaise: number; toAct: number;
  lastAggressor: Player | null; pfAggressor: Player | null; cbetMade: boolean; streetRaises: number; revealed: boolean;
  hist: string[]; ev: GameEvent[];
  tableNo: number; entrants: number; stats: Stats; handActive: boolean;
  vpip: boolean; pfr: boolean; cashOutReq: boolean;
  msg: string; explain: string; sideInfo: string; highlight: Set<Card> | null;
  /** Per-hand cache of board-strength tables (cleared at the start of each hand). */
  btab: Map<string, Float64Array>;
  /** Shared side channel from the equity code, as in the original ("lastThreat"). */
  lastThreat: { behind: number; top: Array<[string, number]> } | null;
}
