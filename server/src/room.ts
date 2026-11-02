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
import { addCharacter, cleanName, DEFAULT_ROSTER, renameCharacter, ROSTER_MAX, STYLES, styleLabel, type Character } from '../../src/engine/roster.js';
import type { Game, Player } from '../../src/engine/state.js';
import { VAR } from '../../src/engine/table.js';
import { VARIANTS, variantFits, type Split, type VariantKey } from '../../src/engine/variants.js';
import { encodeGame, encodeStep, type WireStep } from '../../src/net/wire.js';
import { balancesFrom, settle, type Balance, type LedgerRow, type Transfer } from '../../src/ledger/settle.js';
import type { AskView, FreeChar, LogLine, PeekView, RosterView, TableMsg, WaitView } from './protocol.js';

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
  /** A person lost their seat without asking to leave (out of chips, removed by the creator, or no seat left). */
  removed?: (token: string, reason: RemovedReason) => void;
}
export type RemovedReason = 'out_of_chips' | 'removed' | 'full';
export type RoomRecord =
  | { t: 'buyin'; code: string; name: string; token: string; amount: number }
  | { t: 'cashout'; code: string; name: string; token: string; amount: number }
  | { t: 'hand'; code: string; handNo: number; lines: string[]; results: Array<{ name: string; token: string | null; net: number }> }
  | { t: 'close'; code: string };
export type RosterEdit = { op: 'rename'; id: string; name: string } | { op: 'add'; name: string; type: string } | { op: 'remove'; id: string };
/** Turn timer choices in seconds; 0 = no timer. */
export const TIMER_CHOICES = [0, 15, 30, 60] as const;
export type TimerSec = (typeof TIMER_CHOICES)[number];
/** With no turn timer, how long a disconnected person's question waits before the server answers for them. */
export const AWAY_GRACE_MS = 20_000;
/** Names for extra computer players once every listed character is already at the table. */
const SPARE_NAMES = ['Asha', 'Kabir', 'Meera', 'Dev', 'Zoya', 'Arjun', 'Isha', 'Rahul'];

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
const botSeat = (name: string): Seat => ({ kind: 'bot', connected: false, token: null, name });

/** Omit, applied to each member of a union. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Ask = { kind: AskView['kind']; seat: number; deadline: number; timer: NodeJS.Timeout | undefined; resolve: (v: unknown) => void; fallback: () => unknown; view: AskView };
/** Someone who picked a character and sits down between hands. `replace`: the computer-played character whose seat they take. */
interface Joiner { seat: Seat; char: Character; replace: string | null }

/**
 * Before the creator starts the game the table is a waiting room: people sit down as they join,
 * the creator picks how many computers play (none at all is fine) and the turn timer, and
 * presses Start. After that, people who join sit down between hands, and a person who leaves
 * gives up their seat (their character goes back on the list for others to pick).
 */
export class Room {
  readonly g: Game;
  readonly seats: Seat[];
  /** The character each seat plays (parallel to g.players and seats). */
  readonly chars: Character[];
  /** Characters not at the table: free for people to pick and for the creator's computers. */
  readonly bench: Character[];
  games: 'dealer' | 'holdem';
  /** Turn timer in seconds (0 = none); null = the server's default timing. */
  timer: TimerSec | null;
  /** How many computer players the creator wants at the table. */
  computers: number;
  /** The creator pressed Start (until the table drops below two players). */
  started = false;
  private creatorToken: string | null = null;
  private ask: Ask | null = null;
  private askSeq = 0;
  private waitingOn: WaitView | null = null;
  private phase: TableMsg['phase'] = 'waiting';
  private inHand = false;
  private pendingJoin: Joiner[] = [];
  /** Seats given up during a hand (empty between hands): who to tell, if they did not leave themselves. */
  private readonly pendingLeave = new Map<number, RemovedReason | null>();
  private pendingEdits: RosterEdit[] = [];
  /** Computer players the creator removed during a hand: they go first when the hand ends. */
  private dropFirst: string[] = [];
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
  /**
   * Chips a person has at the table. During a hand that is the stack they started it with (stack
   * plus what they have put in the pot, exact through every payout step and side pot), so settling
   * up or closing mid-hand counts the hand as not played; after it, their stack.
   */
  private chipsOf(i: number): number { const p = this.g.players[i]!; return this.inHand ? p.start : p.stack; }
  onTable(): Map<string, number> {
    const m = new Map<string, number>();
    for (const [i, s] of this.seats.entries()) if (s.kind === 'human' && s.token) m.set(s.token, this.chipsOf(i));
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
   * @param roster the creator's characters (validated by the caller)
   * @param creatorChar the character the creator plays (seat 0)
   * @param opts.computers how many computers play at first (default: every other character on the roster)
   */
  constructor(readonly code: string, roster: readonly Character[], creatorChar: string, readonly hooks: RoomHooks, readonly timing: Timing = LIVE_TIMING, seed: string | null = null, games: 'dealer' | 'holdem' = 'dealer', opts: { computers?: number; timer?: TimerSec | null } = {}) {
    this.games = games;
    this.timer = opts.timer ?? null;
    this.g = newGame({ mode: 'home', seed, settings: { name: '', opp: roster.length - 1, stack: HOME_BUY, perLevel: 10, revealAll: false, games }, roster, heroId: creatorChar });
    // which character sits where (names are unique on a roster)
    this.chars = this.g.players.map(p => ({ ...roster.find(c => c.name === p.name)! }));
    const me = this.g.players[0]!, meChar = this.chars[0]!;
    Object.assign(me, { color: meChar.color, avatar: meChar.avatar });
    // seat 0 is kept for the creator (a person with no session yet); the computer plays the rest
    this.seats = this.g.players.map((p, i) => (i === 0 ? { kind: 'human' as const, connected: false, token: null, name: p.name } : botSeat(p.name)));
    // the creator's other characters beyond the computers they asked for wait off the table,
    // followed by any of the original five not on their list, so friends can pick them
    const others = roster.filter(c => c.id !== meChar.id);
    this.computers = Math.max(0, Math.min(opts.computers ?? others.length, ROSTER_MAX - 1));
    const off = others.slice(this.computers).map(c => this.removeSeat(this.chars.findIndex(x => x.id === c.id)));
    const ids = new Set(roster.map(c => c.id)), names = new Set(roster.map(c => c.name.toLowerCase()));
    this.bench = [...off, ...DEFAULT_ROSTER.filter(c => !ids.has(c.id) && !names.has(c.name.toLowerCase())).map(c => ({ ...c }))];
    this.reconcile();
  }

  /* ---- seats ---- */
  /** Take seat i off the table; returns its character. Button stays with the same player. */
  private removeSeat(i: number): Character {
    const g = this.g;
    const [c] = this.chars.splice(i, 1);
    g.players.splice(i, 1); this.seats.splice(i, 1);
    g.players.forEach((p, k) => { p.i = k; });
    const n = g.players.length;
    if (!n) g.button = -1;
    else if (g.button >= 0) { if (i < g.button) g.button--; else if (i === g.button) g.button = (i - 1 + n) % n; }
    this.sizeChanged();
    return c!;
  }
  /** Seat a character at a free chair: a person (fresh buy-in) or, without `seat`, the computer. */
  private addSeat(c: Character, seat: Seat | null): void {
    const g = this.g, used = new Set(g.players.map(p => p.seat));
    const chair = [0, 3, 2, 4, 1, 5].find(s => !used.has(s))!;
    const p = makePlayer(g.rs, g.settings, chair, seat ? null : { name: c.name, type: c.type, color: c.color, avatar: c.avatar }, HOME_BUY);
    p.i = g.players.length;
    if (seat) Object.assign(p, { name: c.name, color: c.color, avatar: c.avatar }); else p.read = true;
    g.players.push(p);
    this.chars.push({ ...c });
    this.seats.push(seat ?? botSeat(c.name));
    this.sizeChanged();
  }
  private sizeChanged(): void {
    this.g.entrants = this.g.players.length;
    this.g.settings.opp = Math.max(0, this.g.players.length - 1);
  }
  private botIdx(): number[] { return this.seats.flatMap((s, i) => (s.kind === 'bot' ? [i] : [])); }
  private targeted(id: string): boolean { return this.pendingJoin.some(j => j.replace === id); }
  /** Seats in use once queued joins and leaves happen. */
  private seatsAfter(): number { return this.chars.length - this.pendingLeave.size + this.pendingJoin.filter(j => !j.replace).length; }
  /** People at the table (or sitting down next hand), not counting anyone leaving. */
  private people(): number { return this.seats.filter((s, i) => s.kind === 'human' && !this.pendingLeave.has(i)).length + this.pendingJoin.length; }
  maxComputers(): number { return Math.max(0, ROSTER_MAX - this.people()); }
  /** Every character on this table's list (at the table, off it, or claimed by someone sitting down). */
  private allChars(): Character[] {
    const out = [...this.chars, ...this.bench];
    for (const j of this.pendingJoin) if (!out.some(c => c.id === j.char.id)) out.push(j.char);
    return out;
  }
  /** A new character for an extra computer when nobody is left off the table. */
  private spareCharacter(): Character | null {
    const all = this.allChars();
    for (const [k, name] of SPARE_NAMES.entries()) {
      const r = addCharacter(all, name, STYLES[k % STYLES.length]!, Infinity);
      if (r.ok) return r.roster[r.roster.length - 1]!;
    }
    return null;
  }
  /** Bring the number of computer players to what the creator asked for (between hands only). */
  private reconcile(): void {
    this.computers = Math.max(0, Math.min(this.computers, this.maxComputers()));
    // computers the creator removed by name go first
    for (const id of this.dropFirst.splice(0)) {
      const i = this.chars.findIndex(c => c.id === id);
      if (i >= 0 && this.seats[i]!.kind === 'bot' && !this.targeted(id)) this.bench.push(this.removeSeat(i));
    }
    let bots = this.botIdx();
    while (bots.length > this.computers) {
      const i = [...bots].reverse().find(k => !this.targeted(this.chars[k]!.id));
      if (i === undefined) break;
      this.bench.unshift(this.removeSeat(i));
      bots = this.botIdx();
    }
    while (bots.length < this.computers && this.chars.length < ROSTER_MAX) {
      const c = this.bench.shift() ?? this.spareCharacter();
      if (!c) break;
      this.addSeat(c, null);
      bots = this.botIdx();
    }
  }

  /* ---- the roster ---- */
  private view(c: Character, s: Partial<Seat> & { kind: Seat['kind'] }, viewerToken: string | null, waiting: boolean): RosterView {
    const taken = s.kind === 'human' || waiting;
    return {
      id: c.id, name: c.name, type: c.type, style: styleLabel(c.type), color: c.color, avatar: c.avatar, original: c.original,
      taken, waiting, you: !!viewerToken && !!s.token && sameToken(s.token, viewerToken), connected: taken && !!s.connected,
    };
  }
  /** Everyone at the table, then anyone sitting down at a new seat when the hand ends. */
  rosterView(viewerToken: string | null): RosterView[] {
    const rows = this.chars.map((c, i) => {
      const j = this.pendingJoin.find(x => x.replace === c.id);
      return j ? this.view(c, j.seat, viewerToken, true) : this.view(c, this.seats[i]!, viewerToken, false);
    });
    for (const j of this.pendingJoin) if (!j.replace) rows.push(this.view(j.char, j.seat, viewerToken, true));
    return rows;
  }
  /** Characters a newcomer can pick: computer-played ones at the table, and the ones off it. */
  freeChars(): FreeChar[] {
    const atTable = this.chars.flatMap((c, i) => (this.seats[i]!.kind === 'bot' && !this.targeted(c.id) ? [{ c, seated: true }] : []));
    return [...atTable, ...this.bench.map(c => ({ c, seated: false }))].map(({ c, seated }) => ({ id: c.id, name: c.name, type: c.type, style: styleLabel(c.type), color: c.color, avatar: c.avatar, original: c.original, seated }));
  }
  /** No seat left for a newcomer: six seats in use and none played by the computer. */
  full(): boolean { return this.seatsAfter() >= ROSTER_MAX && !this.botIdx().some(i => !this.targeted(this.chars[i]!.id)); }
  /** The name of the character the person running the table plays. */
  hostName(): string | null {
    const t = this.creatorToken;
    if (!t) return null;
    const i = this.seatOf(t), j = this.joinerOf(t);
    return i >= 0 ? this.chars[i]!.name : j >= 0 ? this.pendingJoin[j]!.char.name : null;
  }
  peek(): PeekView {
    return { ok: true, code: this.code, games: this.games, started: this.started, roster: this.rosterView(null), free: this.freeChars(), full: this.full(), creatorName: this.hostName(), timer: this.timerSec() };
  }
  isCreator(token: string): boolean { return !!this.creatorToken && sameToken(this.creatorToken, token); }

  /**
   * The creator changes the players. Renames during a hand wait for it to end; added and
   * removed computers change the count the table moves to between hands.
   */
  editRoster(token: string, e: RosterEdit): { ok: true; queued: boolean } | { ok: false; error: string } {
    if (!this.isCreator(token)) return { ok: false, error: 'only the person who started the table can change the players' };
    const queued = this.inHand;
    if (e.op === 'rename') {
      const future = [...this.allChars()];
      for (const q of this.pendingEdits) if (q.op === 'rename') { const k = future.findIndex(c => c.id === q.id); if (k >= 0) future[k] = { ...future[k]!, name: cleanName(q.name) }; }
      const r = renameCharacter(future, e.id, e.name);
      if (!r.ok) return r;
      if (this.pendingJoin.some(j => !j.replace && j.char.id === e.id)) return { ok: false, error: 'That person is sitting down; rename them once they are at the table.' };
      this.pendingEdits.push(e);
      if (!queued) this.applyPendingEdits();
    } else if (e.op === 'add') {
      if (this.seatsAfter() >= ROSTER_MAX || this.computers >= this.maxComputers()) return { ok: false, error: `The table seats ${ROSTER_MAX}.` };
      const r = addCharacter(this.allChars(), e.name, e.type, Infinity);
      if (!r.ok) return r;
      this.bench.unshift(r.roster[r.roster.length - 1]!);
      this.computers++;
      if (!queued) this.reconcile();
    } else {
      const i = this.chars.findIndex(c => c.id === e.id);
      if (i < 0) return { ok: false, error: 'No such player.' };
      if (this.seats[i]!.kind === 'human' || this.targeted(e.id)) return { ok: false, error: `${this.chars[i]!.name} is being played by someone` };
      this.dropFirst.push(e.id);
      this.computers = Math.max(0, this.computers - 1);
      if (!queued) this.reconcile();
    }
    this.broadcast();
    return { ok: true, queued };
  }
  /** Table settings, creator only: the turn timer, how many computers play, and (before the first hand) the games. */
  configure(token: string, s: { timer?: TimerSec; computers?: number; games?: 'dealer' | 'holdem' }): { ok: true; queued: boolean } | { ok: false; error: string } {
    if (!this.isCreator(token)) return { ok: false, error: 'only the person who started the table can change the settings' };
    if (s.games && s.games !== this.games) {
      if (this.g.handNo > 0) return { ok: false, error: 'The games can only be changed before the first hand.' };
      this.games = s.games;
      this.g.settings.games = s.games;
    }
    if (s.timer !== undefined) {
      this.timer = s.timer;
      // a question already waiting with no deadline gets one now (someone may be away)
      const a = this.ask, ms = a ? this.limit(a.kind === 'split' ? 'split' : a.kind === 'rebuy' ? 'rebuy' : 'turn') : null;
      if (a && !a.deadline && ms !== null) {
        clearTimeout(a.timer);
        a.deadline = Date.now() + ms;
        a.timer = setTimeout(() => this.answerNow(), ms);
        a.view = { ...a.view, deadline: a.deadline };
        this.waitingOn = { seat: a.seat, kind: a.kind, deadline: a.deadline };
      }
    }
    if (s.computers !== undefined) {
      this.computers = Math.max(0, Math.min(s.computers, this.maxComputers()));
      if (!this.inHand) this.reconcile();
    }
    this.broadcast();
    return { ok: true, queued: this.inHand && s.computers !== undefined };
  }
  /** The creator starts the game (needs two players: people or computers). */
  start(token: string): { ok: true } | { ok: false; error: string } {
    if (!this.isCreator(token)) return { ok: false, error: 'only the person who started the table can start the game' };
    if (this.started) return { ok: true };
    if (this.g.players.length < 2) return { ok: false, error: 'A game needs at least 2 players: wait for a friend or add a computer.' };
    this.started = true;
    void this.run();
    return { ok: true };
  }
  /**
   * The last hand's log is kept between hands for the people who played it. Its private lines
   * ("Dealt to …", "… splits: …") are matched by name, so once seats change (someone new may now
   * play that name) they go.
   */
  private forgetPrivateLines(): void {
    this.g.hist = this.g.hist.filter(l => !l.startsWith('Dealt to ') && !/ splits?:/.test(l));
  }
  /** Apply queued renames (between hands only). */
  private applyPendingEdits(): void {
    for (const e of this.pendingEdits.splice(0)) {
      if (e.op !== 'rename') continue;
      const r = renameCharacter(this.allChars(), e.id, e.name);
      if (!r.ok) continue;
      const name = r.roster.find(c => c.id === e.id)!.name;
      const b = this.bench.find(c => c.id === e.id);
      if (b) { b.name = name; continue; }
      const i = this.chars.findIndex(c => c.id === e.id);
      if (i < 0) continue;
      this.chars[i]!.name = name;
      this.g.players[i]!.name = name;
      const s = this.seats[i]!;
      s.name = name;
      const j = this.pendingJoin.find(x => x.replace === e.id);
      if (j) { j.char.name = name; j.seat.name = name; }
      if (s.kind === 'human' && s.token) { const row = this.ledger.get(s.token); if (row) row.name = name; }
    }
  }

  /* ---- people ---- */
  /**
   * Seat a person. The creator takes seat 0 straight away. Others pick a character by id (one
   * played by the computer, whose seat they take, or one off the table) or create a new one;
   * they sit down at once between hands, else when the hand ends. Everyone starts with a
   * fresh buy-in. With six seats in use, a newcomer takes a computer player's seat.
   */
  seatHuman(pick: string | { name: string; type: string }, creator = false): { seat: number; token: string } | { error: string } {
    if (this.closed) return { error: 'no such room' };
    const token = newToken();
    if (creator) {
      if (typeof pick !== 'string' || this.chars[0]?.id !== pick) return { error: 'the creator plays seat 0' };
      const name = this.chars[0]!.name;
      this.creatorToken = token;
      this.toHuman(0, { kind: 'human', token, name, connected: true, since: ++this.joins });
      this.note({ t: 'buyin', code: this.code, name, token, amount: HOME_BUY });
      return { seat: 0, token };
    }
    let char: Character, replace: string | null = null, fromBench = -1;
    if (typeof pick === 'string') {
      const i = this.chars.findIndex(c => c.id === pick);
      fromBench = this.bench.findIndex(c => c.id === pick);
      const claimed = this.pendingJoin.find(j => j.char.id === pick);
      if (i >= 0) {
        if (this.seats[i]!.kind === 'human' || this.targeted(pick)) return { error: `${this.chars[i]!.name} is already taken` };
        char = this.chars[i]!; replace = pick;
      } else if (fromBench >= 0) char = this.bench[fromBench]!;
      else if (claimed) return { error: `${claimed.char.name} is already taken` };
      else return { error: 'no such player at this table' };
    } else {
      const r = addCharacter(this.allChars(), pick.name, pick.type, Infinity);
      if (!r.ok) return { error: r.error };
      char = r.roster[r.roster.length - 1]!;
    }
    if (!replace && this.seatsAfter() >= ROSTER_MAX) {
      const k = [...this.botIdx()].reverse().find(x => !this.targeted(this.chars[x]!.id));
      if (k === undefined) return { error: 'The table is full: six people are playing.' };
      replace = this.chars[k]!.id;
    }
    if (fromBench >= 0) this.bench.splice(fromBench, 1);
    // nobody runs the table (its creator left with nobody else there): this newcomer does
    if (!this.creatorToken) this.creatorToken = token;
    this.pendingJoin.push({ seat: { kind: 'human', token, name: char.name, connected: true, since: ++this.joins }, char: { ...char }, replace });
    if (!this.inHand) this.applySeatChanges();
    this.broadcast();
    return { seat: this.seatOf(token), token };
  }
  /** Seat for a session token, or -1 (also -1 while sitting down, or once they gave the seat up). */
  seatOf(token: string): number {
    for (const [i, s] of this.seats.entries()) if (s.token && !this.pendingLeave.has(i) && sameToken(s.token, token)) return i;
    return -1;
  }
  private joinerOf(token: string): number { return this.pendingJoin.findIndex(j => !!j.seat.token && sameToken(j.seat.token, token)); }
  /** Is this token someone at the table or sitting down? */
  has(token: string): boolean { return this.seatOf(token) >= 0 || this.joinerOf(token) >= 0; }
  setConnected(token: string, connected: boolean): void {
    const i = this.seatOf(token), j = this.joinerOf(token);
    const s = i >= 0 ? this.seats[i] : j >= 0 ? this.pendingJoin[j]!.seat : undefined;
    if (!s) return;
    s.connected = connected;
    // with no turn timer, a question to someone who dropped off waits a little, then is answered for them
    const a = this.ask;
    if (a && i >= 0 && a.seat === i && !a.deadline) {
      clearTimeout(a.timer);
      a.timer = connected ? undefined : setTimeout(() => this.answerNow(), AWAY_GRACE_MS);
    }
    this.broadcast();
  }
  /** Give up a seat (or a seat about to be taken). `reason` set: they were removed and are told so. */
  private giveUp(token: string, reason: RemovedReason | null): boolean {
    const j = this.joinerOf(token);
    if (j >= 0) {
      const [x] = this.pendingJoin.splice(j, 1);
      // their character goes back on the list unless it is a computer's at the table
      if (!this.chars.some(c => c.id === x!.char.id)) this.bench.unshift(x!.char);
      if (reason) this.hooks.removed?.(token, reason);
      this.passCreator(token);
      return true;
    }
    const seat = this.seatOf(token);
    if (seat < 0) return false;
    this.passCreator(token);
    this.pendingLeave.set(seat, null);
    this.seats[seat]!.connected = false;
    if (reason) this.hooks.removed?.(token, reason);
    if (this.ask?.seat === seat) this.answerNow();
    if (!this.inHand) this.applySeatChanges();
    return true;
  }
  leave(token: string): void {
    if (this.giveUp(token, null)) this.broadcast();
  }
  /** The creator removes a person from the table (someone away, or not answering with no timer). */
  kick(token: string, id: string): { ok: true } | { ok: false; error: string } {
    if (!this.isCreator(token)) return { ok: false, error: 'only the person who started the table can remove people' };
    // someone sitting down as this character, else the person playing it now
    const j = this.pendingJoin.find(x => x.char.id === id), i = this.chars.findIndex(c => c.id === id);
    const target = j ? j.seat : i >= 0 && this.seats[i]!.kind === 'human' && !this.pendingLeave.has(i) ? this.seats[i]! : null;
    if (!target?.token) return { ok: false, error: 'Nobody is playing that seat.' };
    if (sameToken(target.token, token)) return { ok: false, error: 'To leave yourself, use Leave the table.' };
    this.giveUp(target.token, 'removed');
    this.broadcast();
    return { ok: true };
  }
  /** When the creator leaves, whoever has been at the table longest manages it. */
  private passCreator(leaving: string): void {
    if (!this.isCreator(leaving)) return;
    const staying = [...this.seats.filter((s, i) => s.kind === 'human' && !this.pendingLeave.has(i)), ...this.pendingJoin.map(j => j.seat)]
      .filter(s => s.token && !sameToken(s.token, leaving))
      .sort((x, y) => (x.since ?? 0) - (y.since ?? 0));
    this.creatorToken = staying[0]?.token ?? null;
  }
  humansConnected(): number { return this.seats.filter(s => s.kind === 'human' && s.connected).length + this.pendingJoin.filter(j => j.seat.connected).length; }

  /** A person takes over seat i with a fresh buy-in: they play its character. */
  private toHuman(i: number, s: Seat): void {
    const g = this.g, c = this.chars[i]!, p = g.players[i]!;
    Object.assign(p, makePlayer(g.rs, g.settings, p.seat, null, HOME_BUY), { i, name: c.name, color: c.color, avatar: c.avatar });
    this.seats[i] = s;
  }
  /** The computer takes over seat i, playing its character in that character's style. */
  private toBot(i: number): void {
    const g = this.g, c = this.chars[i]!, p = g.players[i]!;
    Object.assign(p, makePlayer(g.rs, g.settings, p.seat, { name: c.name, type: c.type, color: c.color, avatar: c.avatar }, HOME_BUY), { i, read: true });
    this.seats[i] = botSeat(c.name);
  }
  /** Between hands: seats given up go, newcomers sit down, renames apply, computers match the count. */
  private applySeatChanges(): void {
    const g = this.g;
    if (this.pendingLeave.size || this.pendingJoin.length || this.pendingEdits.length) this.forgetPrivateLines();
    for (const [seat, reason] of [...this.pendingLeave].sort((x, y) => y[0] - x[0])) {
      const p = g.players[seat]!, s = this.seats[seat]!;
      if (s.kind === 'human' && s.token) {
        this.note({ t: 'cashout', code: this.code, name: s.name, token: s.token, amount: p.stack });
        if (reason) this.hooks.removed?.(s.token, reason);
      }
      this.bench.unshift(this.removeSeat(seat));
    }
    this.pendingLeave.clear();
    for (const j of this.pendingJoin.splice(0)) {
      let i = j.replace ? this.chars.findIndex((c, k) => c.id === j.replace && this.seats[k]!.kind === 'bot') : -1;
      if (i < 0 && this.chars.length >= ROSTER_MAX) i = this.botIdx().pop() ?? -1;
      if (i >= 0) {
        // they take a computer player's seat; a different character sends the computer's back on the list
        const old = this.chars[i]!;
        if (old.id !== j.char.id) this.bench.unshift(old);
        this.chars[i] = { ...j.char };
        this.toHuman(i, j.seat);
        this.computers = Math.max(0, this.computers - 1);
      } else if (this.chars.length < ROSTER_MAX) this.addSeat(j.char, j.seat);
      else {
        this.bench.unshift(j.char);
        if (j.seat.token) this.hooks.removed?.(j.seat.token, 'full');
        continue;
      }
      if (j.seat.token) this.note({ t: 'buyin', code: this.code, name: j.char.name, token: j.seat.token, amount: HOME_BUY });
    }
    this.applyPendingEdits();
    this.reconcile();
  }

  /* ---- answers from clients ---- */
  /** Answer the question the table is asking this person. Returns an error, or null. */
  answer(token: string, kind: AskView['kind'], value: unknown): string | null {
    const seat = this.seatOf(token), a = this.ask;
    if (!a || seat < 0 || a.seat !== seat || a.kind !== kind) return kind === 'act' ? 'not your turn' : `no ${kind} question for you`;
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
  /** Ask a person; `ms` null = no time limit (deadline 0). */
  private askPerson<T>(seat: number, kind: AskView['kind'], ms: number | null, view: DistOmit<AskView, 'deadline' | 'id'>, fallback: () => T): Promise<T> {
    return new Promise<T>(resolve => {
      const deadline = ms === null ? 0 : Date.now() + ms;
      const timer = ms === null ? undefined : setTimeout(() => this.answerNow(), ms);
      this.ask = { kind, seat, deadline, timer, resolve: resolve as (v: unknown) => void, fallback, view: { ...view, deadline, id: ++this.askSeq } as AskView };
      this.waitingOn = { seat, kind, deadline: deadline || null };
      this.broadcast();
    });
  }
  /** Time limits from the table's turn timer: null = none. Without a setting, the server's timing. */
  private limit(kind: 'turn' | 'split' | 'rebuy'): number | null {
    const t = this.timer;
    if (t === null) return kind === 'turn' ? this.timing.turnMs : kind === 'split' ? this.timing.splitMs : this.timing.rebuyMs;
    return t === 0 ? null : t * (kind === 'split' ? 1500 : 1000);
  }
  /** The turn timer in seconds, as people see it (0 = none). */
  timerSec(): number { const ms = this.limit('turn'); return ms === null ? 0 : Math.round(ms / 1000); }
  /** Is this seat a person who can answer right now? */
  private present(i: number): boolean {
    const s = this.seats[i]!;
    return s.kind === 'human' && !!s.token && s.connected && !this.pendingLeave.has(i);
  }

  /* ---- messages ---- */
  /** The message for whoever has this token. Someone waiting to take a seat sees no hole cards. */
  messageFor(token: string): TableMsg | null {
    const seat = this.seatOf(token), j = this.joinerOf(token);
    if (seat < 0 && j < 0) return null;
    const a = this.ask && seat >= 0 && this.ask.seat === seat ? this.ask.view : null;
    return {
      code: this.code, you: seat, character: seat >= 0 ? this.chars[seat]!.id : this.pendingJoin[j]!.char.id, creator: this.isCreator(token), host: this.hostName(), games: this.games,
      started: this.started, timer: this.timerSec(), computers: this.computers, maxComputers: this.maxComputers(),
      phase: this.phase, seq: this.seq, roster: this.rosterView(token), pendingEdits: this.pendingEdits.length,
      game: encodeGame(this.g, seat), step: this.step, ask: a, wait: this.waitingOn,
    };
  }
  broadcast(): void {
    for (const s of [...this.seats, ...this.pendingJoin.map(j => j.seat)]) {
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
    this.started = true;
    try {
      while (!this.closed) {
        this.applySeatChanges();
        if (!this.seats.some(s => s.kind === 'human')) break;
        // fewer than two players left: back to the waiting room until the creator starts again
        if (this.g.players.length < 2) { this.started = false; this.broadcast(); break; }
        // everyone's phone asleep or tab closed: wait for someone to come back rather than post
        // their blinds against the computers until the table closes
        while (!this.closed && this.humansConnected() === 0) await sleep(500);
        if (this.closed) break;
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
    this.inHand = true;
    try { await this.handLoop(flow, start); } finally { this.inHand = false; }
    if (this.closed) return;
    this.flushLog();
    // people out of chips who did not rebuy give up their seat
    for (const p of g.players) if (this.seats[p.i]!.kind === 'human' && p.stack <= 0 && !this.pendingLeave.has(p.i)) { this.passCreator(this.seats[p.i]!.token!); this.pendingLeave.set(p.i, 'out_of_chips'); }
    this.phase = 'waiting';
    this.waitingOn = null;
    this.step = null;
    this.broadcast();
  }

  private async handLoop(flow: ReturnType<typeof playHand>, start: Map<number, { stack: number; buyins: number }>): Promise<void> {
    const g = this.g;
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
          answer = await this.askPerson<Action>(i, 'act', this.limit('turn'), { kind: 'act', options: options(g, s.p) }, fb);
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
          ? await this.askPerson<VariantKey>(i, 'variant', this.limit('turn'), { kind: 'variant', variants: playable }, () => 'std')
          : this.seats[i]!.kind === 'bot' ? pickVariantFor(g, s.p) : 'std';
        if (!VARIANTS[answer as VariantKey]) answer = 'std';
      } else if (s.kind === 'plans') {
        initPlans(g, s.order);
        this.stepOut(s);
      } else if (s.kind === 'split') {
        const i = s.p.i;
        this.stepOut(s);
        answer = this.present(i)
          ? await this.askPerson<Split>(i, 'split', this.limit('split'), { kind: 'split', k: s.k }, () => planSplit(g, s.p, s.k))
          : this.seats[i]!.kind === 'bot' ? botFinalSplit(g, s.p, s.k) : planSplit(g, s.p, s.k);
      } else if (s.kind === 'practiceView') {
        practiceSplits(g); // only with the practice view on, which online tables never use
      } else if (s.kind === 'rebuy') {
        const i = s.p.i, seat = this.seats[i]!;
        this.stepOut(s);
        const yes = this.present(i) ? await this.askPerson<boolean>(i, 'rebuy', this.limit('rebuy'), { kind: 'rebuy' }, () => false) : false;
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
    for (const [i, s] of this.seats.entries()) if (s.kind === 'human' && s.token) this.note({ t: 'cashout', code: this.code, name: s.name, token: s.token, amount: this.chipsOf(i) });
    this.note({ t: 'close', code: this.code });
    this.close();
  }

  close(): void {
    this.closed = true;
    this.answerNow();
  }
}
