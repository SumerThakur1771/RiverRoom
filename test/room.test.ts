// Room edge cases, without sockets: who plays a seat a person gives up, telling a person when
// their seat is taken back, split validation, and roster edits keeping the table consistent.
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
  it('goes back to the computer playing that same character, in its own style', () => {
    const r = new Room('AAAAAA', DEFAULT_ROSTER, 'rohit', quiet(), FAST, 'rb-1');
    const t = seat(r, 'rohit', true);
    expect(r.g.players[0]).toMatchObject({ isHuman: true, name: 'Rohit', avatar: 'rohit' });
    r.leave(t);
    expect(r.g.players[0]).toMatchObject({ isHuman: false, name: 'Rohit', type: 'rohit' });
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
  it('a player out of chips who does not answer the rebuy question is told, and the computer takes the seat', async () => {
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
    expect(r.seats[0]!.kind).toBe('bot');
    expect(r.g.players[0]).toMatchObject({ name: 'Sumer', type: 'sumer' });
  });
  it('a player who leaves on purpose is not sent a "removed" notice', () => {
    const removed: string[] = [];
    const r = new Room('DDDDDD', DEFAULT_ROSTER, 'sumer', quiet({ removed: t => removed.push(t) }), FAST, 'rb-4');
    r.leave(seat(r, 'sumer', true));
    expect(r.seats[0]!.kind).toBe('bot');
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
