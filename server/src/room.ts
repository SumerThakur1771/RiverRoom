// One table: the engine's game plus who plays which character, the sockets attached, and the
// loop that drives hands. The server is the only place the deck and hole cards exist; each
// client gets its own redacted copy of the game (src/net/wire.ts) and can only answer what the
// table is asking *them*: their action, their dealer's choice, their split, their rebuy.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { botAction, botFinalSplit, initPlans, pickVariantFor, practiceSplits } from '../../src/ai/bots.js';
import { planSplit } from '../../src/ai/split.js';
import { cardTxt } from '../../src/engine/cards.js';
import { HOME_BUY, makePlayer, newGame, options, playHand, type Action, type Step } from '../../src/engine/engine.js';
import { HOME_FRIENDS, NAMES, TYPES } from '../../src/engine/personas.js';
import { addCharacter, removeCharacter, renameCharacter, styleLabel, type Character, type RosterResult } from '../../src/engine/roster.js';
import type { Game, Player } from '../../src/engine/state.js';
import { VAR } from '../../src/engine/table.js';
import { VARIANTS, variantFits, type Split, type VariantKey } from '../../src/engine/variants.js';
import { encodeGame, encodeStep, type WireStep } from '../../src/net/wire.js';
import { balancesFrom, settle, type Balance, type LedgerRow, type Transfer } from '../../src/ledger/settle.js';
import type { AskView, LogLine, PeekView, RosterView, TableMsg, WaitView } from './protocol.js';

export interface Timing {
  /** Time a person has to act (and to pick a game) before the server answers for them. */
  turnMs: number;
  /** Time a person has to arrange their split at the showdown. */
  splitMs: number;
  /** Delay before a computer player acts, so people can follow along. */
  botMs: number;
  /** Multiplier on the engine's animation pauses. */
  pauseScale: number;
  handEndMs: number;
  betweenHandsMs: number;
  /** Time to answer a rebuy question; no answer means no rebuy. */
  rebuyMs: number;
}
export const LIVE_TIMING: Timing = { turnMs: 30_000, splitMs: 45_000, botMs: 900, pauseScale: 0.5, handEndMs: 4_000, betweenHandsMs: 1_500, rebuyMs: 30_000 };

export interface Seat { kind: 'human' | 'bot'; connected: boolean; token: string | null; name: string; /** join order, for passing on the creator role */ since?: number }
export interface RoomHooks {
  /** Called with each client's new message. */
  send: (token: string, msg: TableMsg) => void;
  log: (line: LogLine) => void;
  /** Ledger and history events (stored by the database layer when there is one). */
  record?: (e: RoomRecord) => void;
  /** A player lost their seat without asking to leave (out of chips and no rebuy). */
  removed?: (token: string, reason: 'out_of_chips' | 'removed') => void;
}
export type RoomRecord =
  | { t: 'buyin'; code: string; name: string; token: string; amount: number }
  | { t: 'cashout'; code: string; name: string; token: string; amount: number }
  | { t: 'hand'; code: string; handNo: number; lines: string[]; results: Array<{ name: string; token: string | null; net: number }> }
  | { t: 'close'; code: string };
export type RosterEdit = { op: 'rename'; id: string; name: string } | { op: 'add'; name: string; type: string } | { op: 'remove'; id: string };

/**
 * A computer player for a seat that has no character (kept for tables made before rosters):
 * a home-game friend not at the table yet, else a generic player whose name is not taken.
 */
export function replacementBot(players: readonly Player[], seat: number): { name: string; type: string; color: string; avatar: string | null } {
  const atTable = new Set(players.filter(p => p.i !== seat).map(p => p.name));
  const friend = HOME_FRIENDS.find(f => !atTable.has(f.name));
  if (friend) return friend;
  const generic = Object.keys(TYPES).filter(k => !TYPES[k]!.home);
  const [name, color] = NAMES.find(([n]) => !atTable.has(n)) ?? [`Player ${seat + 1}`, '#8e9f96'];
  return { name, type: generic[seat % generic.length]!, color, avatar: null };
}

/** Is `groups` a legal split of this player's cards for the variant (right sizes, exactly their cards)? */
export function validSplit(g: Game, p: Player, groups: number[][]): groups is Split {
  const V = VAR(g);
  if (!V || groups.length !== V.parts.length) return false;
  if (groups.some((grp, j) => grp.length !== V.parts[j]!.n)) return false;
  const mine = [...p.all].sort((a, b) => a - b), got = groups.flat().sort((a, b) => a - b);
  return mine.length === got.length && mine.every((c, i) => c === got[i]);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newCode = (): string => Array.from(randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
export const newToken = (): string => randomBytes(24).toString('base64url');
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const sameToken = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Omit, applied to each member of a union. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Ask = { kind: AskView['kind']; seat: number; deadline: number; timer: NodeJS.Timeout; resolve: (v: unknown) => void; fallback: () => unknown; view: AskView };

export class Room {
  readonly g: Game;
  readonly seats: Seat[];
  /** The character each seat plays (parallel to g.players and seats). */
  readonly chars: Character[];
  games: 'dealer' | 'holdem';
  private creatorToken: string | null = null;
  private ask: Ask | null = null;
  private waitingOn: WaitView | null = null;
  private phase: TableMsg['phase'] = 'waiting';
  private pendingJoin = new Map<number, Seat>();
  private readonly leftOnPurpose = new Set<number>();
  private pendingLeave = new Set<number>();
  private pendingEdits: RosterEdit[] = [];
  private lastEv = 0;
  private seq = 0;
  private joins = 0;
  private step: WireStep | null = null;
  private running = false;
  closed = false;

  /** The ledger kept in memory (by session token), so settling up works with or without a database. */
  readonly ledger = new Map<string, { name: string; buyins: number; cashouts: number }>();

  private note(e: RoomRecord): void {
    if (e.t === 'buyin' || e.t === 'cashout') {
      const row = this.ledger.get(e.token) ?? { name: e.name, buyins: 0, cashouts: 0 };
      if (e.t === 'buyin') row.buyins += e.amount; else row.cashouts += e.amount;
      row.name = e.name;
      this.ledger.set(e.token, row);
    }
    this.hooks.record?.(e);
  }
  /** Chips each seated person has on the table now (during a hand, including what they put in the pot). */
  onTable(): Map<string, number> {
    const m = new Map<string, number>();
    for (const [i, s] of this.seats.entries()) {
      const p = this.g.players[i]!;
      if (s.kind === 'human' && s.token) m.set(s.token, p.stack + (this.phase === 'playing' ? p.total : 0));
    }
    return m;
  }
  ledgerRows(): LedgerRow[] {
    const table = this.onTable();
    return [...this.ledger].map(([token, r]) => ({ name: r.name, buyins: r.buyins, cashouts: r.cashouts, onTable: table.get(token) ?? 0 }));
  }
  settlement(): { balances: Balance[]; transfers: Transfer[] } {
    const balances = balancesFrom(this.ledgerRows());
    return { balances, transfers: settle(balances) };
  }

  /**
   * @param roster the table's characters (validated by the caller)
   * @param creatorChar the character the creator plays (seat 0)
   */
  constructor(readonly code: string, roster: readonly Character[], creatorChar: string, readonly hooks: RoomHooks, readonly timing: Timing = LIVE_TIMING, seed: string | null = null, games: 'dealer' | 'holdem' = 'dealer') {
    this.games = games;
    this.g = newGame({ mode: 'home', seed, settings: { name: '', opp: roster.length - 1, stack: HOME_BUY, perLevel: 10, revealAll: false, games }, roster, heroId: creatorChar });
    // which character sits where (names are unique on a roster)
    this.chars = this.g.players.map(p => ({ ...roster.find(c => c.name === p.name)! }));
    const me = this.g.players[0]!, meChar = this.chars[0]!;
    Object.assign(me, { color: meChar.color, avatar: meChar.avatar });
    // until the creator is seated, their character is played by the computer like everyone else
    this.seats = this.g.players.map(p => ({ kind: 'bot' as const, connected: false, token: null, name: p.name }));
    this.toBot(0);
  }

  /* ---- the roster ---- */
  rosterView(viewerToken: string | null): RosterView[] {
    return this.chars.map((c, i) => {
      const s = this.pendingJoin.get(i) ?? this.seats[i]!;
      const taken = s.kind === 'human';
      return {
        id: c.id, name: c.name, type: c.type, style: styleLabel(c.type), color: c.color, avatar: c.avatar, original: c.original,
        taken, you: !!viewerToken && !!s.token && sameToken(s.token, viewerToken), connected: taken && s.connected,
      };
    });
  }
  peek(): PeekView {
    const ci = this.creatorToken ? this.seatOf(this.creatorToken) : -1;
    return { ok: true, code: this.code, games: this.games, roster: this.rosterView(null), creatorName: ci >= 0 ? this.chars[ci]!.name : null };
  }
  isCreator(token: string): boolean { return !!this.creatorToken && sameToken(this.creatorToken, token); }

  /**
   * The creator changes the roster. Between hands it applies at once; during a hand it is queued
   * for the end of the hand. Characters someone is playing cannot be removed.
   */
  editRoster(token: string, e: RosterEdit): { ok: true; queued: boolean } | { ok: false; error: string } {
    if (!this.isCreator(token)) return { ok: false, error: 'only the person who started the table can change the players' };
    // check against the roster as it will be once the queued edits apply
    const future = this.applyEditsTo([...this.chars], this.pendingEdits);
    if (e.op === 'remove') {
      const i = this.chars.findIndex(c => c.id === e.id);
      if (i >= 0 && (this.seats[i]!.kind === 'human' || this.pendingJoin.has(i))) return { ok: false, error: `${this.chars[i]!.name} is being played by someone` };
    }
    const r = this.editResult(future, e);
    if (!r.ok) return r;
    this.pendingEdits.push(e);
    const queued = this.phase === 'playing';
    if (!queued) this.applyPendingEdits();
    this.broadcast();
    return { ok: true, queued };
  }
  private editResult(roster: readonly Character[], e: RosterEdit): RosterResult {
    return e.op === 'rename' ? renameCharacter(roster, e.id, e.name) : e.op === 'add' ? addCharacter(roster, e.name, e.type) : removeCharacter(roster, e.id);
  }
  private applyEditsTo(roster: Character[], edits: readonly RosterEdit[]): Character[] {
    for (const e of edits) { const r = this.editResult(roster, e); if (r.ok) roster = r.roster; }
    return roster;
  }
  /** Apply queued roster edits to the table (between hands only). */
  private applyPendingEdits(): void {
    const g = this.g;
    for (const e of this.pendingEdits.splice(0)) {
      const r = this.editResult(this.chars, e);
      if (!r.ok) continue;
      if (e.op === 'rename') {
        const i = this.chars.findIndex(c => c.id === e.id), name = r.roster.find(c => c.id === e.id)!.name;
        this.chars[i]!.name = name;
        g.players[i]!.name = name;
        this.seats[i]!.name = name;
        const s = this.seats[i]!;
        if (s.kind === 'human' && s.token) { const row = this.ledger.get(s.token); if (row) row.name = name; }
      } else if (e.op === 'add') {
        const c = r.roster[r.roster.length - 1]!;
        const used = new Set(g.players.map(p => p.seat));
        const seatNo = [0, 3, 2, 4, 1, 5].find(s => !used.has(s))!;
        const p = makePlayer(g.rs, g.settings, seatNo, { name: c.name, type: c.type, color: c.color, avatar: c.avatar }, HOME_BUY);
        p.i = g.players.length; p.read = true;
        g.players.push(p);
        this.chars.push({ ...c });
        this.seats.push({ kind: 'bot', connected: false, token: null, name: c.name });
      } else {
        const i = this.chars.findIndex(c => c.id === e.id);
        if (i < 0 || this.seats[i]!.kind === 'human' || this.pendingJoin.has(i)) continue;
        g.players.splice(i, 1); this.chars.splice(i, 1); this.seats.splice(i, 1);
        g.players.forEach((p, k) => { p.i = k; });
        const n = g.players.length;
        // the button stays with the same player; if it was the removed one, it moves on next hand
        if (i < g.button) g.button--;
        else if (i === g.button) g.button = (i - 1 + n) % n;
        const shifted = new Map<number, Seat>();
        for (const [k, s] of this.pendingJoin) shifted.set(k > i ? k - 1 : k, s);
        this.pendingJoin = shifted;
      }
      g.entrants = g.players.length;
      g.settings.opp = g.players.length - 1;
    }
  }

  /* ---- people ---- */
  /**
   * Seat a person as a character. The creator takes seat 0 straight away; others take a free
   * character's seat (at once between hands, else when the current hand ends).
   */
  seatHuman(charId: string, creator = false): { seat: number; token: string } | { error: string } {
    const i = this.chars.findIndex(c => c.id === charId);
    if (i < 0) return { error: 'no such player at this table' };
    if (creator && i !== 0) return { error: 'the creator plays seat 0' };
    if (this.seats[i]!.kind === 'human' || this.pendingJoin.has(i)) return { error: `${this.chars[i]!.name} is already taken` };
    const token = newToken(), name = this.chars[i]!.name;
    const seat: Seat = { kind: 'human', token, name, connected: true, since: ++this.joins };
    this.note({ t: 'buyin', code: this.code, name, token, amount: HOME_BUY });
    if (creator) { this.creatorToken = token; this.toHuman(0, seat); return { seat: 0, token }; }
    this.pendingJoin.set(i, seat);
    if (this.phase !== 'playing') this.applySeatChanges();
    this.broadcast();
    return { seat: i, token };
  }
  /** Seat for a session token (after a reconnect), or -1. */
  seatOf(token: string): number {
    for (const [i, s] of this.seats.entries()) if (s.token && sameToken(s.token, token)) return i;
    for (const [i, s] of this.pendingJoin) if (s.token && sameToken(s.token, token)) return i;
    return -1;
  }
  setConnected(token: string, connected: boolean): void {
    const i = this.seatOf(token);
    const s = this.pendingJoin.get(i) ?? this.seats[i];
    if (s) s.connected = connected;
    this.broadcast();
  }
  leave(token: string): void {
    const seat = this.seatOf(token);
    if (seat < 0) return;
    if (this.pendingJoin.has(seat)) { this.pendingJoin.delete(seat); this.passCreator(token); this.broadcast(); return; }
    this.pendingLeave.add(seat);
    this.leftOnPurpose.add(seat);
    this.seats[seat]!.connected = false;
    if (this.ask?.seat === seat) this.answerNow();
    if (this.phase !== 'playing') this.applySeatChanges();
    this.passCreator(token);
    this.broadcast();
  }
  /** When the creator leaves, whoever has been at the table longest manages the roster. */
  private passCreator(leaving: string): void {
    if (!this.isCreator(leaving)) return;
    const staying = [...this.seats.filter((s, i) => s.kind === 'human' && !this.pendingLeave.has(i)), ...this.pendingJoin.values()]
      .filter(s => s.token && !sameToken(s.token, leaving))
      .sort((x, y) => (x.since ?? 0) - (y.since ?? 0));
    this.creatorToken = staying[0]?.token ?? null;
  }
  humansConnected(): number { return this.seats.filter(s => s.kind === 'human' && s.connected).length + [...this.pendingJoin.values()].filter(s => s.connected).length; }

  /** A person takes over seat i: they play its character. */
  private toHuman(i: number, s: Seat): void {
    const g = this.g, c = this.chars[i]!, p = g.players[i]!;
    Object.assign(p, makePlayer(g.rs, g.settings, p.seat, null, HOME_BUY), { i, name: c.name, color: c.color, avatar: c.avatar });
    this.seats[i] = s;
  }
  /** The computer takes over seat i, playing its character in that character's style. */
  private toBot(i: number): void {
    const g = this.g, c = this.chars[i]!, p = g.players[i]!;
    Object.assign(p, makePlayer(g.rs, g.settings, p.seat, { name: c.name, type: c.type, color: c.color, avatar: c.avatar }, HOME_BUY), { i, read: true });
    this.seats[i] = { kind: 'bot', connected: false, token: null, name: c.name };
  }
  private applySeatChanges(): void {
    const g = this.g;
    for (const seat of this.pendingLeave) {
      const p = g.players[seat]!, s = this.seats[seat]!;
      if (s.kind === 'human' && s.token) {
        this.note({ t: 'cashout', code: this.code, name: s.name, token: s.token, amount: p.stack });
        // tell the player their seat is gone (unless they left on purpose), so their page does not sit on a stale table
        if (!this.leftOnPurpose.delete(seat)) {
          this.hooks.removed?.(s.token, p.stack <= 0 ? 'out_of_chips' : 'removed');
          this.passCreator(s.token);
        }
      }
      this.toBot(seat);
    }
    this.pendingLeave.clear();
    for (const [seat, s] of this.pendingJoin) this.toHuman(seat, s);
    this.pendingJoin.clear();
    this.applyPendingEdits();
  }

  /* ---- answers from clients ---- */
  /** Answer the question the table is asking this person. Returns an error, or null. */
  answer(token: string, kind: AskView['kind'], value: unknown): string | null {
    const seat = this.seatOf(token), a = this.ask;
    if (!a || a.seat !== seat || a.kind !== kind || this.pendingJoin.has(seat)) return kind === 'act' ? 'not your turn' : `no ${kind} question for you`;
    const p = this.g.players[seat]!;
    if (kind === 'variant' && !(a.view.kind === 'variant' && a.view.variants.includes(value as string))) return 'that game cannot be dealt now';
    if (kind === 'split' && !validSplit(this.g, p, value as number[][])) return 'that is not a split of your cards';
    clearTimeout(a.timer);
    this.ask = null;
    a.resolve(value);
    return null;
  }
  /** Answer for the person (time is up, or they left). */
  private answerNow(): void {
    const a = this.ask;
    if (!a) return;
    clearTimeout(a.timer);
    this.ask = null;
    a.resolve(a.fallback());
  }
  private askPerson<T>(seat: number, kind: AskView['kind'], ms: number, view: DistOmit<AskView, 'deadline'>, fallback: () => T): Promise<T> {
    return new Promise<T>(resolve => {
      const deadline = Date.now() + ms;
      const timer = setTimeout(() => this.answerNow(), ms);
      this.ask = { kind, seat, deadline, timer, resolve: resolve as (v: unknown) => void, fallback, view: { ...view, deadline } as AskView };
      this.waitingOn = { seat, kind, deadline };
      this.broadcast();
    });
  }
  /** Is this seat a person who can answer right now? */
  private present(i: number): boolean {
    const s = this.seats[i]!;
    return s.kind === 'human' && !!s.token && s.connected && !this.pendingLeave.has(i);
  }

  /* ---- messages ---- */
  /** The message for whoever has this token. Someone waiting to take a seat sees no hole cards. */
  messageFor(token: string): TableMsg | null {
    const seat = this.seatOf(token);
    if (seat < 0) return null;
    const pending = this.pendingJoin.has(seat), viewer = pending ? -1 : seat;
    const a = this.ask && this.ask.seat === seat && !pending ? this.ask.view : null;
    return {
      code: this.code, you: viewer, character: this.chars[seat]!.id, creator: this.isCreator(token), games: this.games,
      phase: this.phase, seq: this.seq, roster: this.rosterView(token), pendingEdits: this.pendingEdits.length,
      game: encodeGame(this.g, viewer), step: this.step, ask: a, wait: this.waitingOn,
    };
  }
  broadcast(): void {
    for (const s of [...this.seats, ...this.pendingJoin.values()]) {
      if (s.kind !== 'human' || !s.token || !s.connected) continue;
      const m = this.messageFor(s.token);
      if (m) this.hooks.send(s.token, m);
    }
  }
  /** Send a new engine step to everyone. */
  private stepOut(s: Step): void {
    this.seq++;
    this.step = encodeStep(s, this.g);
    this.broadcast();
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
      this.waitingOn = null;
      if (s.kind === 'act') {
        const i = s.p.i;
        if (this.present(i)) {
          this.stepOut(s);
          const fb = (): Action => (options(g, s.p).toCall > 0 ? { type: 'fold' } : { type: 'check' });
          answer = await this.askPerson<Action>(i, 'act', this.timing.turnMs, { kind: 'act', options: options(g, s.p) }, fb);
        } else {
          this.waitingOn = { seat: i, kind: 'bot', deadline: null };
          this.stepOut(s);
          await sleep(this.timing.botMs);
          // a person who is away or leaving: check or fold for them
          answer = this.seats[i]!.kind === 'bot' ? botAction(g, s.p) : options(g, s.p).toCall > 0 ? { type: 'fold' } : { type: 'check' };
        }
      } else if (s.kind === 'variant') {
        const i = s.p.i, alive = g.players.filter(p => !p.out).length;
        const playable = (['std', 'holdem', 'two', 'k8', 'n7'] as VariantKey[]).filter(k => variantFits(k, alive));
        this.stepOut(s);
        answer = this.present(i)
          ? await this.askPerson<VariantKey>(i, 'variant', this.timing.turnMs, { kind: 'variant', variants: playable }, () => 'std')
          : this.seats[i]!.kind === 'bot' ? pickVariantFor(g, s.p) : 'std';
        if (!VARIANTS[answer as VariantKey]) answer = 'std';
      } else if (s.kind === 'plans') {
        initPlans(g, s.order);
        this.stepOut(s);
      } else if (s.kind === 'split') {
        const i = s.p.i;
        this.stepOut(s);
        answer = this.present(i)
          ? await this.askPerson<Split>(i, 'split', this.timing.splitMs, { kind: 'split', k: s.k }, () => planSplit(g, s.p, s.k))
          : this.seats[i]!.kind === 'bot' ? botFinalSplit(g, s.p, s.k) : planSplit(g, s.p, s.k);
      } else if (s.kind === 'practiceView') {
        practiceSplits(g); // only with the practice view on, which online tables never use
      } else if (s.kind === 'rebuy') {
        const i = s.p.i, seat = this.seats[i]!;
        this.stepOut(s);
        const yes = this.present(i) ? await this.askPerson<boolean>(i, 'rebuy', this.timing.rebuyMs, { kind: 'rebuy' }, () => false) : false;
        if (yes && seat.token) this.note({ t: 'buyin', code: this.code, name: seat.name, token: seat.token, amount: HOME_BUY });
        answer = yes ? 'yes' : 'no';
      } else if (s.kind === 'pause') {
        if (s.what === 'handEnd') {
          this.phase = 'handEnd';
          this.stepOut(s);
          this.recordHand(start);
          await sleep(this.timing.handEndMs);
        } else {
          this.stepOut(s);
          if (s.ms) await sleep(s.ms * this.timing.pauseScale);
        }
      }
      if (this.closed) return;
    }
    this.flushLog();
    // players who chose not to rebuy leave the table; the computer plays their character
    for (const p of g.players) if (this.seats[p.i]!.kind === 'human' && p.stack <= 0) this.pendingLeave.add(p.i);
    this.phase = 'waiting';
    this.waitingOn = null;
    this.step = null;
    this.broadcast();
  }

  private recordHand(start: Map<number, { stack: number; buyins: number }>): void {
    const g = this.g;
    this.note({
      t: 'hand', code: this.code, handNo: g.handNo, lines: g.hist.filter(l => !l.startsWith('Dealt to ')),
      results: g.players.map(p => ({ name: p.name, token: this.seats[p.i]!.kind === 'human' ? this.seats[p.i]!.token : null, net: p.stack - (start.get(p.i)?.stack ?? p.stack) })),
    });
  }

  /** End the night: cash everyone out at their current stack, then close. */
  finish(): void {
    for (const [i, s] of this.seats.entries()) if (s.kind === 'human' && s.token) this.note({ t: 'cashout', code: this.code, name: s.name, token: s.token, amount: this.g.players[i]!.stack });
    this.note({ t: 'close', code: this.code });
    this.close();
  }

  close(): void {
    this.closed = true;
    this.answerNow();
  }
}
