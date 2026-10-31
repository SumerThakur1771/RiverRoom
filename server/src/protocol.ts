// The multiplayer protocol: what clients may send (validated with zod) and what they receive.
import { z } from 'zod';

export const Name = z.string().trim().min(1).max(16).regex(/^[\p{L}\p{N} ._'-]+$/u, 'letters, numbers and spaces only');
export const Code = z.string().trim().toUpperCase().regex(/^[A-Z2-9]{6}$/);
export const Token = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

export const CreateMsg = z.object({ name: Name });
export const JoinMsg = z.object({ code: Code, name: Name });
export const ResumeMsg = z.object({ code: Code, token: Token });
export const ActMsg = z.object({ type: z.enum(['fold', 'check', 'call', 'raise']), to: z.number().int().min(0).max(1e9).optional() });
export const RebuyMsg = z.object({ yes: z.boolean() });

export type Ack = { ok: true; code?: string; token?: string; seat?: number } | { ok: false; error: string };

/** One seat as one particular client sees it. `cards` is null unless they may see them. */
export interface SeatView {
  seat: number; name: string; kind: 'human' | 'bot'; connected: boolean;
  stack: number; bet: number; folded: boolean; allIn: boolean; label: string;
  /** Cards this client is allowed to see: their own, or cards turned face up. */
  cards: number[] | null;
  /** How many cards the player holds (shown face down when `cards` is null). */
  cardCount: number;
  handName: string; won: number; buyins: number;
}
export interface TurnView { seat: number; deadline: number; options?: { toCall: number; canCheck: boolean; canRaise: boolean; minTo: number; maxTo: number } }
export interface View {
  code: string; you: number; handNo: number; street: number; board: number[]; pot: number; currentBet: number;
  button: number; sb: number; bb: number; seats: SeatView[]; turn: TurnView | null;
  phase: 'waiting' | 'playing' | 'handEnd'; rebuy: boolean; msg: string;
}
export interface LogLine { hand: number; text: string }
