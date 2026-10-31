// Builds what one client may see. This is the anti-cheat boundary: the full game state stays
// on the server, and each client gets only public information plus its own cards.
import { options } from '../../src/engine/engine.js';
import type { Game, Player } from '../../src/engine/state.js';
import { potTotal } from '../../src/engine/table.js';
import type { SeatView, TurnView, View } from './protocol.js';

export interface SeatMeta { kind: 'human' | 'bot'; connected: boolean }

/** May `viewer` see `p`'s cards right now? Their own, or cards turned face up (showdown, all-in). */
export function canSee(p: Player, viewer: number): boolean {
  return p.i === viewer || (p.shown && !p.folded && !p.mucked);
}

/**
 * @param viewer whose cards may be shown (-1 = a spectator: nobody's own cards)
 * @param you    the seat this client sits in, or will take at the next hand
 */
export function buildView(g: Game, code: string, viewer: number, you: number, meta: SeatMeta[], turn: { seat: number; deadline: number } | null, phase: View['phase'], rebuy: boolean): View {
  const seats: SeatView[] = g.players.map(p => ({
    seat: p.i, name: p.name, kind: meta[p.i]?.kind ?? 'bot', connected: meta[p.i]?.connected ?? false,
    stack: p.stack, bet: p.bet, folded: p.folded, allIn: p.allIn, label: p.label,
    cards: p.cards.length && canSee(p, viewer) ? p.cards.slice() : null,
    cardCount: p.cards.length,
    handName: canSee(p, viewer) ? p.handName : '',
    won: p.won, buyins: p.buyins,
  }));
  let t: TurnView | null = null;
  if (turn) {
    t = { seat: turn.seat, deadline: turn.deadline };
    if (turn.seat === viewer) {
      const o = options(g, g.players[viewer]!);
      t.options = { toCall: o.toCall, canCheck: o.canCheck, canRaise: o.canRaise, minTo: o.minTo, maxTo: o.maxTo };
    }
  }
  return {
    code, you, handNo: g.handNo, street: g.street, board: g.board.slice(0, g.boardVis), pot: potTotal(g), currentBet: g.currentBet,
    button: g.button, sb: g.sb, bb: g.bb, seats, turn: t, phase, rebuy, msg: phase === 'handEnd' ? g.msg : '',
  };
}
