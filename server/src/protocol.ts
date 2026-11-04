// The multiplayer protocol: what clients may send (validated with zod) and what they receive.
import { z } from 'zod';
import type { WireGame, WireStep } from '../../src/net/wire.js';

export const Code = z.string().trim().toUpperCase().regex(/^[A-Z2-9]{6}$/);
export const Token = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const CharId = z.string().regex(/^[a-z0-9-]{1,20}$/);
const PlayerName = z.string().min(1).max(40);
const Style = z.string().max(20);

/** A roster sent by the creator (checked again with validRoster). */
const RosterIn = z.array(z.object({ id: CharId, name: PlayerName, type: Style, color: z.string().max(9).optional(), avatar: z.string().max(20).nullable().optional() })).min(2).max(6);

const Timer = z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]);
const Computers = z.number().int().min(0).max(5);
export const CreateMsg = z.object({ character: CharId, roster: RosterIn.optional(), games: z.enum(['dealer', 'holdem']).default('dealer'), timer: Timer.optional(), computers: Computers.optional(), a23Low: z.boolean().optional() });
export const PeekMsg = z.object({ code: Code });
/** Join as a character from the table's list, or as a new character you name. */
export const JoinMsg = z.union([
  z.object({ code: Code, character: CharId }),
  z.object({ code: Code, create: z.object({ name: PlayerName, type: Style }) }),
]);
/** Creator only: turn timer, number of computer players, games (before the first hand). */
export const SettingsMsg = z.object({ timer: Timer.optional(), computers: Computers.optional(), games: z.enum(['dealer', 'holdem']).optional(), a23Low: z.boolean().optional() });
export const KickMsg = z.object({ id: CharId });
export const ResumeMsg = z.object({ code: Code, token: Token });
export const ActMsg = z.object({ type: z.enum(['fold', 'check', 'call', 'raise']), to: z.number().int().min(0).max(1e9).optional() });
export const RebuyMsg = z.object({ yes: z.boolean() });
export const VariantMsg = z.object({ variant: z.enum(['holdem', 'std', 'two', 'k8', 'n7']) });
export const SplitMsg = z.object({ groups: z.array(z.array(z.number().int().min(0).max(51)).min(1).max(8)).min(1).max(4) });
export const RosterMsg = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename'), id: CharId, name: PlayerName }),
  z.object({ op: z.literal('add'), name: PlayerName, type: Style }),
  z.object({ op: z.literal('remove'), id: CharId }),
]);

export type Ack = { ok: true; code?: string; token?: string; seat?: number; queued?: boolean } | { ok: false; error: string };

/** A character on the table's roster, as everyone sees it. */
export interface RosterView {
  id: string; name: string; type: string; style: string; color: string; avatar: string | null; original: boolean;
  /** Played by a person (or about to be, from the next hand). Nobody else can pick it. */
  taken: boolean;
  /** Sitting down when the current hand ends. */
  waiting: boolean;
  /** Played by you. */
  you: boolean;
  connected: boolean;
}
/** A character a newcomer can pick: played by the computer at the table now (`seated`), or off the table. */
export interface FreeChar { id: string; name: string; type: string; style: string; color: string; avatar: string | null; original: boolean; seated: boolean }
/** What the server is waiting for from you. `id` is unique per question; `deadline` 0 = no time limit. */
export type AskView =
  | { kind: 'act'; id: number; deadline: number; options: { toCall: number; canCheck: boolean; canRaise: boolean; minTo: number; maxTo: number; isBet: boolean } }
  | { kind: 'variant'; id: number; deadline: number; variants: string[] }
  | { kind: 'split'; id: number; deadline: number; k: number }
  | { kind: 'rebuy'; id: number; deadline: number };
/** Who the table is waiting on (anyone can see this). */
export interface WaitView { seat: number; kind: AskView['kind'] | 'bot'; deadline: number | null }

/** Everything one client gets, after every engine step and every change at the table. */
export interface TableMsg {
  code: string;
  /** Your player index in `game.players`; -1 while you wait for the current hand to end to sit down. */
  you: number;
  /** The character you play. */
  character: string;
  creator: boolean;
  /** Name of the character the person running the table plays. */
  host: string | null;
  games: 'dealer' | 'holdem';
  /** False while the table is a waiting room (before the creator presses Start, or after it drops below two players). */
  started: boolean;
  /** Turn timer in seconds; 0 = no timer. */
  timer: number;
  /** House rule: A-2-3 is the lowest 3 Patti sequence; `a23Next` is the rule from the next hand. */
  a23Low: boolean;
  a23Next: boolean;
  /** Computer players the creator asked for, and the most there is room for. */
  computers: number;
  maxComputers: number;
  phase: 'waiting' | 'playing' | 'handEnd';
  /** Increases by one with every engine step; a message with the same seq only updates the state. */
  seq: number;
  roster: RosterView[];
  /** Queued roster changes from the creator, applied when the current hand ends. */
  pendingEdits: number;
  game: WireGame;
  step: WireStep | null;
  ask: AskView | null;
  wait: WaitView | null;
}
export interface PeekView { ok: true; code: string; games: 'dealer' | 'holdem'; started: boolean; roster: RosterView[]; free: FreeChar[]; full: boolean; creatorName: string | null; timer: number }
export interface LogLine { hand: number; text: string }
