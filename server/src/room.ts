// One table: the engine's game plus who sits where, which sockets are attached, and the loop
// that drives hands. The server is the only place the deck and hole cards exist; clients get
// per-seat views (view.ts) and can only send actions for their own seat, on their own turn.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { botAction } from '../../src/ai/bots.js';
import { cardTxt } from '../../src/engine/cards.js';
import { planSplit } from '../../src/ai/split.js';
import { HOME_BUY, makePlayer, newGame, options, playHand, type Action } from '../../src/engine/engine.js';
import { HOME_FRIENDS } from '../../src/engine/personas.js';
import type { Game, Player } from '../../src/engine/state.js';
import type { LogLine, View } from './protocol.js';
import { buildView, type SeatMeta } from './view.js';

export interface Timing {
  /** Time a human has to act before the server checks or folds for them. */
  turnMs: number;
  /** Delay before a bot acts, so people can follow along. */
  botMs: number;
  /** Multiplier on the engine's animation pauses. */
  pauseScale: number;
  handEndMs: number;
  betweenHandsMs: number;
  /** Time to answer a rebuy question; no answer means no rebuy. */
  rebuyMs: number;
}
export const LIVE_TIMING: Timing = { turnMs: 30_000, botMs: 900, pauseScale: 0.5, handEndMs: 4_000, betweenHandsMs: 1_500, rebuyMs: 30_000 };

export interface Seat extends SeatMeta { token: string | null; name: string }
export interface RoomHooks {
  /** Called with each client's new view. */
  send: (token: string, view: View) => void;
  log: (line: LogLine) => void;
  /** Ledger and history events (stored by the database layer when there is one). */
  record?: (e: RoomRecord) => void;
}
export type RoomRecord =
  | { t: 'buyin'; code: string; name: string; token: string; amount: number }
  | { t: 'cashout'; code: string; name: string; token: string; amount: number }
  | { t: 'hand'; code: string; handNo: number; lines: string[]; results: Array<{ name: string; token: string | null; net: number }> };

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newCode = (): string => Array.from(randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
export const newToken = (): string => randomBytes(24).toString('base64url');
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const sameToken = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Room {
  readonly g: Game;
  readonly seats: Seat[];
  private turn: { seat: number; deadline: number; resolve: (a: Action) => void; timer: NodeJS.Timeout } | null = null;
  private rebuyAsk: { seat: number; resolve: (yes: boolean) => void; timer: NodeJS.Timeout } | null = null;
  private phase: View['phase'] = 'waiting';
  private pendingJoin = new Map<number, Seat>();
  private pendingLeave = new Set<number>();
  private lastEv = 0;
  private running = false;
  closed = false;

  constructor(readonly code: string, creator: string, readonly hooks: RoomHooks, readonly timing: Timing = LIVE_TIMING, seed: string | null = null) {
    this.g = newGame({ mode: 'home', seed, settings: { name: creator, opp: 4, stack: HOME_BUY, perLevel: 10, revealAll: false, games: 'holdem' } });
    this.g.players[0]!.name = creator;
    this.seats = this.g.players.map(p => ({ kind: p.isHuman ? 'human' : 'bot', connected: false, token: null, name: p.name }));
  }

  /* ---- people ---- */
  /** Seat a new human (the creator gets seat 0). Returns their seat and session token, or null if full. */
  seatHuman(name: string, creator = false): { seat: number; token: string } | null {
    const token = newToken();
    if (creator) {
      Object.assign(this.seats[0]!, { kind: 'human', token, name, connected: true });
      this.hooks.record?.({ t: 'buyin', code: this.code, name, token, amount: HOME_BUY });
      return { seat: 0, token };
    }
    const free = this.seats.findIndex((s, i) => s.kind === 'bot' && !this.pendingJoin.has(i));
    if (free < 0) return null;
    const seat: Seat = { kind: 'human', token, name, connected: true };
    this.pendingJoin.set(free, seat);
    this.hooks.record?.({ t: 'buyin', code: this.code, name, token, amount: HOME_BUY });
    // between hands the seat changes hands right away; during a hand, at the next hand
    if (this.phase !== 'playing') this.applySeatChanges();
    this.broadcast();
    return { seat: free, token };
  }
  /** Seat for a session token (after a reconnect), or -1. */
  seatOf(token: string): number {
    for (const [i, s] of this.seats.entries()) if (s.token && sameToken(s.token, token)) return i;
    for (const [i, s] of this.pendingJoin) if (s.token && sameToken(s.token, token)) return i;
    return -1;
  }
  setConnected(seat: number, connected: boolean): void {
    const s = this.pendingJoin.get(seat) ?? this.seats[seat];
    if (s) s.connected = connected;
    this.broadcast();
  }
  leave(seat: number): void {
    if (this.pendingJoin.has(seat)) { this.pendingJoin.delete(seat); return; }
    this.pendingLeave.add(seat);
    this.seats[seat]!.connected = false;
    if (this.turn?.seat === seat) this.autoAct();
    if (this.phase !== 'playing') this.applySeatChanges();
    this.broadcast();
  }
  humansConnected(): number { return this.seats.filter(s => s.kind === 'human' && s.connected).length + [...this.pendingJoin.values()].filter(s => s.connected).length; }

  private applySeatChanges(): void {
    const g = this.g;
    for (const seat of this.pendingLeave) {
      const p = g.players[seat]!, s = this.seats[seat]!;
      if (s.kind === 'human' && s.token) this.hooks.record?.({ t: 'cashout', code: this.code, name: s.name, token: s.token, amount: p.stack });
      const used = new Set(g.players.filter(x => !x.isHuman).map(x => x.type));
      const friend = HOME_FRIENDS.find(f => !used.has(f.type)) ?? HOME_FRIENDS[seat % HOME_FRIENDS.length]!;
      Object.assign(p, makePlayer(g.rs, g.settings, p.seat, friend, HOME_BUY), { i: seat, read: true });
      Object.assign(s, { kind: 'bot', connected: false, token: null, name: friend.name });
    }
    this.pendingLeave.clear();
    for (const [seat, s] of this.pendingJoin) {
      const p = g.players[seat]!;
      Object.assign(p, makePlayer(g.rs, g.settings, p.seat, null, HOME_BUY), { i: seat, name: s.name });
      this.seats[seat] = s;
    }
    this.pendingJoin.clear();
  }

  /* ---- actions from clients ---- */
  act(seat: number, a: Action): string | null {
    if (!this.turn || this.turn.seat !== seat) return 'not your turn';
    const t = this.turn;
    clearTimeout(t.timer);
    this.turn = null;
    t.resolve(a);
    return null;
  }
  answerRebuy(seat: number, yes: boolean): string | null {
    if (!this.rebuyAsk || this.rebuyAsk.seat !== seat) return 'no rebuy question for you';
    const r = this.rebuyAsk;
    clearTimeout(r.timer);
    this.rebuyAsk = null;
    r.resolve(yes);
    return null;
  }
  private autoAct(): void {
    if (!this.turn) return;
    const p = this.g.players[this.turn.seat]!;
    this.act(this.turn.seat, options(this.g, p).toCall > 0 ? { type: 'fold' } : { type: 'check' });
  }

  /* ---- views ---- */
  private meta(): SeatMeta[] { return this.seats.map(s => ({ kind: s.kind, connected: s.connected })); }
  /** The view for whoever has this seat's token. Someone waiting to take a seat sees no hole cards. */
  viewFor(seat: number): View {
    const turn = this.turn ? { seat: this.turn.seat, deadline: this.turn.deadline } : null;
    const viewer = this.pendingJoin.has(seat) ? -1 : seat;
    return buildView(this.g, this.code, viewer, seat, this.meta(), turn, this.phase, this.rebuyAsk?.seat === seat);
  }
  broadcast(): void {
    for (const [i, s] of this.seats.entries()) if (s.kind === 'human' && s.token && s.connected) this.hooks.send(s.token, this.viewFor(i));
    // people waiting for the next hand watch from the seat they will take
    for (const [i, s] of this.pendingJoin) if (s.token && s.connected) this.hooks.send(s.token, this.viewFor(i));
  }
  /** Public log lines for what just happened (never anyone's hidden cards). */
  private flushLog(): void {
    const g = this.g, nm = (p: Player | undefined): string => p?.name ?? '?';
    for (const e of g.ev.slice(this.lastEv)) {
      const amt = typeof e.amt === 'number' ? (e.amt / 100).toFixed(2) : '';
      let text = '';
      switch (e.t) {
        case 'post': text = `${nm(e.p)} posts $${amt}`; break;
        case 'fold': case 'check': text = `${nm(e.p)} ${e.t}s`; break;
        case 'call': text = `${nm(e.p)} calls $${amt}${e.allIn ? ' (all-in)' : ''}`; break;
        case 'bet': case 'raise': text = `${nm(e.p)} ${e.t}s to $${((e.to as number) / 100).toFixed(2)}${e.allIn ? ' (all-in)' : ''}`; break;
        case 'board': { const b = (e.cards as number[]).map(cardTxt); text = b.length === 3 ? `Flop: ${b.join(' ')}` : `${b.length === 4 ? 'Turn' : 'River'}: ${b[b.length - 1]} (board ${b.join(' ')})`; break; }
        case 'ret': text = `$${amt} returned to ${nm(e.p)}`; break;
        case 'show': text = `${nm(e.p)} shows ${e.name as string}`; break;
        case 'muck': text = `${nm(e.p)} mucks`; break;
        case 'win': text = `${nm(e.p)} wins $${amt}`; break;
      }
      if (text) this.hooks.log({ hand: g.handNo, text });
    }
    this.lastEv = g.ev.length;
  }

  /* ---- the game loop ---- */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.closed) {
        this.applySeatChanges();
        if (!this.seats.some(s => s.kind === 'human')) break;
        await this.playOne();
        if (this.closed) break;
        await sleep(this.timing.betweenHandsMs);
      }
    } finally {
      this.running = false;
    }
  }

  private async playOne(): Promise<void> {
    const g = this.g, flow = playHand(g);
    const start = new Map(g.players.map(p => [p.i, { stack: p.stack, buyins: p.buyins }]));
    this.phase = 'playing';
    this.lastEv = 0;
    let answer: unknown;
    for (;;) {
      const r = flow.next(answer);
      answer = undefined;
      if (r.done) break;
      const s = r.value;
      this.flushLog();
      if (s.kind === 'act') {
        if (!this.seats[s.p.i]!.token || this.seats[s.p.i]!.kind === 'bot' || this.pendingLeave.has(s.p.i)) {
          this.broadcast();
          await sleep(this.timing.botMs);
          answer = this.seats[s.p.i]!.kind === 'bot' ? botAction(g, s.p) : options(g, s.p).toCall > 0 ? { type: 'fold' } : { type: 'check' };
        } else answer = await this.waitForHuman(s.p);
      } else if (s.kind === 'split') answer = planSplit(g, s.p, s.k);
      else if (s.kind === 'rebuy') answer = (await this.askRebuy(s.p)) ? 'yes' : 'no';
      else if (s.kind === 'pause') {
        if (s.what === 'handEnd') {
          this.phase = 'handEnd';
          this.broadcast();
          this.recordHand(start);
          await sleep(this.timing.handEndMs);
        } else {
          this.broadcast();
          if (s.ms) await sleep(s.ms * this.timing.pauseScale);
        }
      }
      if (this.closed) return;
    }
    this.flushLog();
    // players who chose not to rebuy leave the table; a bot takes the seat
    for (const p of g.players) if (p.isHuman && p.stack <= 0) this.pendingLeave.add(p.i);
    this.phase = 'waiting';
    this.broadcast();
  }

  private recordHand(start: Map<number, { stack: number; buyins: number }>): void {
    const g = this.g;
    this.hooks.record?.({
      t: 'hand', code: this.code, handNo: g.handNo, lines: g.hist.filter(l => !l.startsWith('Dealt to ')),
      results: g.players.map(p => ({ name: p.name, token: this.seats[p.i]!.kind === 'human' ? this.seats[p.i]!.token : null, net: p.stack - start.get(p.i)!.stack })),
    });
  }

  private waitForHuman(p: Player): Promise<Action> {
    return new Promise(resolve => {
      const deadline = Date.now() + this.timing.turnMs;
      const timer = setTimeout(() => this.autoAct(), this.timing.turnMs);
      this.turn = { seat: p.i, deadline, resolve, timer };
      this.broadcast();
    });
  }
  private askRebuy(p: Player): Promise<boolean> {
    const s = this.seats[p.i]!;
    if (s.kind !== 'human' || !s.connected) return Promise.resolve(false);
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answerRebuy(p.i, false), this.timing.rebuyMs);
      this.rebuyAsk = { seat: p.i, resolve, timer };
      this.broadcast();
    }).then(yes => {
      if (yes && s.token) this.hooks.record?.({ t: 'buyin', code: this.code, name: s.name, token: s.token, amount: HOME_BUY });
      return yes as boolean;
    });
  }

  close(): void {
    this.closed = true;
    if (this.turn) { clearTimeout(this.turn.timer); this.turn.resolve({ type: 'fold' }); this.turn = null; }
    if (this.rebuyAsk) { clearTimeout(this.rebuyAsk.timer); this.rebuyAsk.resolve(false); this.rebuyAsk = null; }
  }
}
