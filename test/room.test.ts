// Room edge cases, without sockets: the waiting room (computers 0-5, Start, joining by picking
// or creating a character, a full table), seats people give up, telling a person when they lose
// their seat, split validation, and roster edits keeping the table consistent.
import { describe, expect, it } from 'vitest';
import { replacementBot, Room, validSplit, type RoomHooks } from '../server/src/room';
import { newGame } from '../src/engine/engine';
import { HOME_FRIENDS } from '../src/engine/personas';
import { DEFAULT_ROSTER } from '../src/engine/roster';
import type { TableMsg } from '../server/src/protocol';

const FAST = { turnMs: 300, splitMs: 300, botMs: 0, pauseScale: 0, handEndMs: 5, betweenHandsMs: 5, rebuyMs: 50 };
const quiet = (extra: Partial<RoomHooks> = {}): RoomHooks => ({ send: () => {}, log: () => {}, ...extra });
const seat = (r: Room, ch: string, creator = false): string => {
  const s = r.seatHuman(ch, creator);
  if ('error' in s) throw new Error(s.error);
  return s.token;
};

describe('a seat a person gives up', () => {
  it('is removed; the character goes back on the list for someone else to pick', () => {
    const r = new Room('AAAAAA', DEFAULT_ROSTER, 'rohit', quiet(), FAST, 'rb-1');
    const t = seat(r, 'rohit', true);
    expect(r.g.players[0]).toMatchObject({ isHuman: true, name: 'Rohit', avatar: 'rohit' });
    const friend = r.seatHuman('sumer');
    if ('error' in friend) throw new Error(friend.error);
    expect(r.g.players).toHaveLength(5);
    r.leave(t);
    expect(r.g.players.map(p => p.name)).not.toContain('Rohit');
    expect(r.g.players).toHaveLength(4);
    expect(r.freeChars().map(c => c.name)).toContain('Rohit');
    r.close();
  });
  it('a table without a roster character for a seat never gets a duplicate name', () => {
    const g = newGame({ mode: 'home', seed: 'rb-2', settings: { name: '', opp: 4, stack: 1000, perLevel: 10, revealAll: false, games: 'holdem' } });
    expect(new Set(g.players.filter(p => !p.isHuman).map(p => p.name))).toEqual(new Set(HOME_FRIENDS.map(f => f.name)));
    const bot = replacementBot(g.players, 0);
    expect(g.players.filter(p => p.i !== 0).map(p => p.name)).not.toContain(bot.name);
  });
});

describe('losing a seat without asking', () => {
  it('a player out of chips who does not answer the rebuy question is told, and gives up the seat', async () => {
    const removed: Array<{ token: string; reason: string }> = [];
    let busted = false;
    const send = (_t: string, m: TableMsg): void => { if (m.phase === 'handEnd' && !busted) { busted = true; r.g.players[0]!.stack = 0; } };
    const r: Room = new Room('CCCCCC', DEFAULT_ROSTER, 'sumer', quiet({ send, removed: (token, reason) => removed.push({ token, reason }) }), FAST, 'rb-3', 'holdem');
    const token = seat(r, 'sumer', true);
    void r.run();
    const t0 = Date.now();
    while (!removed.length && Date.now() - t0 < 20_000) await new Promise(res => setTimeout(res, 20));
    r.close();
    expect(removed).toEqual([{ token, reason: 'out_of_chips' }]);
    expect(r.g.players.map(p => p.name)).not.toContain('Sumer');
    expect(r.seats.every(s => s.kind === 'bot')).toBe(true);
  });
  it('a player who leaves on purpose is not sent a "removed" notice', () => {
    const removed: string[] = [];
    const r = new Room('DDDDDD', DEFAULT_ROSTER, 'sumer', quiet({ removed: t => removed.push(t) }), FAST, 'rb-4');
    r.leave(seat(r, 'sumer', true));
    expect(r.g.players.map(p => p.name)).not.toContain('Sumer');
    expect(removed).toEqual([]);
    r.close();
  });
});

describe('splits sent by a person', () => {
  it('must use exactly their own cards, in the right group sizes', () => {
    const r = new Room('EEEEEE', DEFAULT_ROSTER, 'sumer', quiet(), FAST, 'rb-5');
    const g = r.g;
    g.variant = 'std'; // Poker + 3 Patti: a 2-card and a 3-card group
    const p = g.players[0]!;
    p.all = [10, 20, 30, 40, 50];
    expect(validSplit(g, p, [[50, 10], [20, 40, 30]])).toBe(true);
    expect(validSplit(g, p, [[10, 20, 30], [40, 50]])).toBe(false); // wrong sizes
    expect(validSplit(g, p, [[10, 20], [30, 40, 51]])).toBe(false); // not their card
    expect(validSplit(g, p, [[10, 10], [20, 30, 40]])).toBe(false); // a card twice
    expect(validSplit(g, p, [[10, 20], [30, 40]])).toBe(false); // missing a group card
    g.variant = 'holdem';
    expect(validSplit(g, p, [[10, 20]])).toBe(false); // nothing to split in Hold'em
    r.close();
  });
});

describe('roster edits between hands', () => {
  it('removing a character re-numbers the seats and keeps the button with the same player', () => {
    const r = new Room('FFFFFF', DEFAULT_ROSTER, 'sumer', quiet(), FAST, 'rb-6');
    const creator = seat(r, 'sumer', true);
    const g = r.g;
    g.button = 3;
    const buttonName = g.players[3]!.name;
    const victim = g.players[1]!.name, victimId = r.chars[1]!.id;
    expect(r.editRoster(creator, { op: 'remove', id: victimId })).toEqual({ ok: true, queued: false });
    expect(g.players.map(p => p.name)).not.toContain(victim);
    expect(g.players.every((p, i) => p.i === i)).toBe(true);
    expect(g.players[g.button]!.name).toBe(buttonName);
    expect(r.seats.map(s => s.name)).toEqual(g.players.map(p => p.name));
    expect(r.chars.map(c => c.name)).toEqual(g.players.map(p => p.name));
    // the creator's own seat token still resolves to their seat
    expect(g.players[r.seatOf(creator)]!.name).toBe('Sumer');
    r.close();
  });
  it('adding a character gives them a free seat at the table, up to six', () => {
    const r = new Room('GGGGGG', DEFAULT_ROSTER, 'sumer', quiet(), FAST, 'rb-7');
    const creator = seat(r, 'sumer', true);
    expect(r.editRoster(creator, { op: 'add', name: 'Asha', type: 'krish' }).ok).toBe(true);
    expect(r.g.players).toHaveLength(6);
    expect(new Set(r.g.players.map(p => p.seat)).size).toBe(6);
    expect(r.editRoster(creator, { op: 'add', name: 'Zed', type: 'krish' })).toEqual({ ok: false, error: 'The table seats 6.' });
    r.close();
  });
  it('leaving answers an open question at once (the table never waits on someone who is gone)', async () => {
    const r = new Room('HHHHHH', DEFAULT_ROSTER, 'sumer', quiet(), { ...FAST, turnMs: 60_000 }, 'rb-8', 'holdem');
    const token = seat(r, 'sumer', true);
    let asked = false;
    (r.hooks as { send: RoomHooks['send'] }).send = (_t, m) => { if (m.ask) asked = true; };
    void r.run();
    const t0 = Date.now();
    while (!asked && Date.now() - t0 < 10_000) await new Promise(res => setTimeout(res, 10));
    expect(asked).toBe(true);
    const h = r.g.handNo;
    r.leave(token);
    // with the 60 s turn timer the hand would stall; leaving answers for them and the hand ends
    const t1 = Date.now();
    while (r.g.handNo === h && r.g.handActive && Date.now() - t1 < 5_000) await new Promise(res => setTimeout(res, 10));
    expect(Date.now() - t1).toBeLessThan(5_000);
    r.close();
  });
});

describe('the waiting room', () => {
  const lobby = (computers: number, removed: Array<{ token: string; reason: string }> = []): { r: Room; creator: string } => {
    const r = new Room('JJJJJJ', DEFAULT_ROSTER, 'sumer', quiet({ removed: (token, reason) => removed.push({ token, reason }) }), FAST, 'rb-w', 'holdem', { computers });
    return { r, creator: seat(r, 'sumer', true) };
  };
  it('the creator picks how many computers play, from none to five', () => {
    const { r, creator } = lobby(0);
    expect(r.g.players.map(p => p.name)).toEqual(['Sumer']);
    expect(r.maxComputers()).toBe(5);
    expect(r.configure(creator, { computers: 5 })).toEqual({ ok: true, queued: false });
    expect(r.g.players).toHaveLength(6);
    // the four friends, then a new character once the list runs out
    expect(r.g.players.filter(p => !p.isHuman).map(p => p.name).slice(0, 4).sort()).toEqual(['Krish', 'Nikhil', 'Rohit', 'Venky']);
    expect(new Set(r.g.players.map(p => p.seat)).size).toBe(6);
    expect(r.configure(creator, { computers: 2 }).ok).toBe(true);
    expect(r.g.players).toHaveLength(3);
    expect(r.configure(creator, { computers: 0 }).ok).toBe(true);
    expect(r.g.players).toHaveLength(1);
    r.close();
  });
  it('nothing is dealt until the creator presses Start, which needs two players', async () => {
    const { r, creator } = lobby(0);
    expect(r.start(creator)).toMatchObject({ ok: false });
    const friend = r.seatHuman({ name: 'Asha', type: 'krish' });
    if ('error' in friend) throw new Error(friend.error);
    expect(r.start(friend.token)).toEqual({ ok: false, error: 'only the person who started the table can start the game' });
    expect(r.configure(friend.token, { computers: 3 })).toMatchObject({ ok: false });
    expect(r.kick(friend.token, 'sumer')).toMatchObject({ ok: false });
    await new Promise(res => setTimeout(res, 50));
    expect(r.g.handNo).toBe(0);
    expect(r.start(creator)).toEqual({ ok: true });
    const t0 = Date.now();
    while (r.g.handNo < 2 && Date.now() - t0 < 10_000) await new Promise(res => setTimeout(res, 10));
    expect(r.g.handNo).toBeGreaterThanOrEqual(2);
    expect(r.g.players.every(p => p.isHuman)).toBe(true);
    r.close();
  });
  it('a newcomer picks a computer-played character (taking its seat) or one off the table (a new seat)', () => {
    const { r } = lobby(2);
    const bots = r.g.players.filter(p => !p.isHuman).map(p => p.name);
    const off = r.freeChars().find(c => !c.seated)!;
    const a = r.seatHuman(r.freeChars().find(c => c.seated)!.id), b = r.seatHuman(off.id);
    if ('error' in a || 'error' in b) throw new Error('could not join');
    expect(r.g.players).toHaveLength(4); // 1 + 2 computers - 1 taken over + 1 new seat
    expect(r.computers).toBe(1);
    expect(r.g.players.filter(p => !p.isHuman)).toHaveLength(1);
    expect(bots).toContain(r.g.players[a.seat]!.name);
    expect(r.g.players[b.seat]!.name).toBe(off.name);
    expect(r.seatHuman(off.id)).toEqual({ error: `${off.name} is already taken` });
    r.close();
  });
  it('a full table: a new character takes a computer\'s seat with a fresh buy-in; six people means full', async () => {
    const { r } = lobby(5);
    void r.run();
    const t0 = Date.now();
    while (r.g.handNo < 3 && Date.now() - t0 < 10_000) await new Promise(res => setTimeout(res, 5));
    r.close();
    // between hands (the room is closed, so nothing is running): a computer has won or lost chips
    const room = r as unknown as { inHand: boolean };
    room.inHand = false;
    r.closed = false;
    const j = r.seatHuman({ name: 'Zed', type: 'rohit' });
    if ('error' in j) throw new Error(j.error);
    expect(r.g.players).toHaveLength(6);
    expect(r.g.players[j.seat]).toMatchObject({ name: 'Zed', isHuman: true, stack: 1000, buyins: 1 });
    for (const n of ['A1', 'A2', 'A3', 'A4']) expect('token' in r.seatHuman({ name: n, type: 'krish' })).toBe(true);
    expect(r.g.players.every(p => p.isHuman)).toBe(true);
    expect(r.full()).toBe(true);
    expect(r.seatHuman({ name: 'A5', type: 'krish' })).toEqual({ error: 'The table is full: six people are playing.' });
    r.close();
  });
  it('a 0-computer game that drops below two players goes back to the waiting room', async () => {
    const removed: Array<{ token: string; reason: string }> = [];
    const { r, creator } = lobby(0, removed);
    const friend = r.seatHuman({ name: 'Asha', type: 'krish' });
    if ('error' in friend) throw new Error(friend.error);
    r.start(creator);
    const t0 = Date.now();
    while (r.g.handNo < 1 && Date.now() - t0 < 5_000) await new Promise(res => setTimeout(res, 5));
    // the creator removes their friend mid-game: told at once, seat gone when the hand ends
    expect(r.kick(creator, 'sumer')).toMatchObject({ ok: false });
    expect(r.kick(creator, r.chars.find(c => c.name === 'Asha')!.id)).toEqual({ ok: true });
    expect(removed).toEqual([{ token: friend.token, reason: 'removed' }]);
    const t1 = Date.now();
    while (r.started && Date.now() - t1 < 5_000) await new Promise(res => setTimeout(res, 5));
    expect(r.started).toBe(false);
    expect(r.g.players.map(p => p.name)).toEqual(['Sumer']);
    expect(r.has(friend.token)).toBe(false);
    r.close();
  });
  it('no turn timer: questions have no deadline', async () => {
    const r = new Room('KKKKKK', DEFAULT_ROSTER, 'sumer', quiet(), FAST, 'rb-t', 'holdem', { computers: 1, timer: 0 });
    const token = seat(r, 'sumer', true);
    let ask: TableMsg['ask'] = null;
    (r.hooks as { send: RoomHooks['send'] }).send = (_t, m) => { if (m.ask) ask = m.ask; };
    r.start(token);
    const t0 = Date.now();
    while (!ask && Date.now() - t0 < 5_000) await new Promise(res => setTimeout(res, 5));
    expect(ask).toMatchObject({ deadline: 0 });
    // still waiting well past the 300 ms test timer
    await new Promise(res => setTimeout(res, 600));
    expect(r.answer(token, 'act', { type: 'fold' }) === null || r.answer(token, 'act', { type: 'check' }) === null).toBe(true);
    r.close();
  });
});

describe('bugs found in review (each test failed before its fix)', () => {
  const until = async (cond: () => boolean, ms = 10_000): Promise<void> => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
  it('a table whose creator left with nobody else is run by the next person to join', () => {
    const r = new Room('LLLLLL', DEFAULT_ROSTER, 'sumer', quiet(), FAST, 'rv-1', 'holdem', { computers: 1 });
    r.leave(seat(r, 'sumer', true));
    const j = r.seatHuman({ name: 'Asha', type: 'krish' });
    if ('error' in j) throw new Error(j.error);
    expect(r.isCreator(j.token)).toBe(true);
    expect(r.start(j.token)).toEqual({ ok: true });
    r.close();
  });
  it('chips on the table add up during a hand, including while the pot is being paid out', async () => {
    let worst = 0, checks = 0;
    const send = (_t: string, m: TableMsg): void => {
      if (m.phase !== 'playing') return;
      const total = [...r.onTable().values()].reduce((a, b) => a + b, 0);
      checks++; worst = Math.max(worst, Math.abs(total - 2000));
    };
    const r: Room = new Room('MMMMMM', DEFAULT_ROSTER, 'sumer', quiet({ send }), FAST, 'rv-2', 'holdem', { computers: 0 });
    const a = seat(r, 'sumer', true);
    r.seatHuman({ name: 'Asha', type: 'krish' });
    r.start(a);
    await until(() => r.g.handNo >= 4);
    r.close();
    expect(checks).toBeGreaterThan(20);
    expect(worst).toBe(0); // two people, no computers: their chips always add up to the two buy-ins
  });
  it('whoever takes a character later never sees its last hand\'s private lines', async () => {
    const r = new Room('NNNNNN', DEFAULT_ROSTER, 'sumer', quiet(), FAST, 'rv-3', 'holdem', { computers: 0 });
    const a = seat(r, 'sumer', true);
    const b = r.seatHuman('rohit');
    if ('error' in b) throw new Error(b.error);
    r.start(a);
    await until(() => r.g.hist.some(l => l.startsWith('Dealt to Rohit')));
    r.leave(b.token); // the table drops below two players and goes back to waiting
    await until(() => !r.started);
    const c = r.seatHuman('rohit');
    if ('error' in c) throw new Error(c.error);
    expect(r.messageFor(c.token)!.game.hist.filter(l => /^Dealt to|splits?:/.test(l))).toEqual([]);
    r.close();
  });
  it('turning the timer on starts the clock on a question already waiting', async () => {
    let ask: TableMsg['ask'] = null;
    const r: Room = new Room('OOOOOO', DEFAULT_ROSTER, 'sumer', quiet({ send: (_t, m) => { ask = m.ask; } }), FAST, 'rv-4', 'holdem', { computers: 1, timer: 0 });
    const a = seat(r, 'sumer', true);
    r.start(a);
    await until(() => !!ask);
    expect(ask).toMatchObject({ deadline: 0 });
    r.configure(a, { timer: 15 });
    const d = (ask as unknown as { deadline: number }).deadline;
    expect(d).toBeGreaterThan(Date.now() + 10_000);
    expect(d).toBeLessThanOrEqual(Date.now() + 15_000);
    expect(r.messageFor(a)!.wait).toMatchObject({ deadline: d });
    r.close();
  });
  it('a newcomer at a full table who leaves before sitting down puts their character back on the list', async () => {
    const r = new Room('PPPPPP', DEFAULT_ROSTER, 'sumer', quiet(), FAST, 'rv-5', 'holdem', { computers: 5 });
    const a = seat(r, 'sumer', true);
    r.start(a);
    await until(() => (r as unknown as { inHand: boolean }).inHand);
    // six seats in use: a new player is given a computer's seat, then leaves before the hand ends
    const j = r.seatHuman({ name: 'Zed', type: 'rohit' });
    if ('error' in j) throw new Error(j.error);
    expect(r.freeChars().map(c => c.name)).not.toContain('Zed');
    r.leave(j.token);
    expect(r.freeChars().map(c => c.name)).toContain('Zed');
    r.close();
  });
  it('with nobody connected the table waits instead of playing on', async () => {
    const r = new Room('QQQQQQ', DEFAULT_ROSTER, 'sumer', quiet(), FAST, 'rv-6', 'holdem', { computers: 2 });
    const a = seat(r, 'sumer', true);
    r.start(a);
    await until(() => r.g.handNo >= 1);
    r.setConnected(a, false);
    await new Promise(res => setTimeout(res, 300));
    const h = r.g.handNo;
    await new Promise(res => setTimeout(res, 600));
    expect(r.g.handNo).toBeLessThanOrEqual(h + 1);
    r.setConnected(a, true);
    await until(() => r.g.handNo >= h + 2);
    r.close();
  });
});
