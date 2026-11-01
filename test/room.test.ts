// Room edge cases, without sockets: who takes a seat that a person gives up, and telling a
// person when their seat is taken back.
import { describe, expect, it } from 'vitest';
import { replacementBot, Room } from '../server/src/room';
import { HOME_FRIENDS } from '../src/engine/personas';

const FAST = { turnMs: 300, botMs: 0, pauseScale: 0, handEndMs: 5, betweenHandsMs: 5, rebuyMs: 50 };

describe('replacement computer players', () => {
  it('prefer a home-game friend who is not at the table', () => {
    const r = new Room('AAAAAA', 'Ana', { send: () => {}, log: () => {} }, FAST, 'rb-1');
    const away = r.g.players.find(p => !p.isHuman)!;
    const others = r.g.players.filter(p => p !== away);
    expect(replacementBot(others.map(p => p), -1).name).toBe(away.name);
  });
  it('never duplicate a name at the table, even when every friend is already seated', () => {
    const r = new Room('BBBBBB', 'Ana', { send: () => {}, log: () => {} }, FAST, 'rb-2');
    // all four friends are at the table; the human in seat 0 leaves
    expect(new Set(r.g.players.filter(p => !p.isHuman).map(p => p.name))).toEqual(new Set(HOME_FRIENDS.map(f => f.name)));
    const bot = replacementBot(r.g.players, 0);
    expect(r.g.players.filter(p => p.i !== 0).map(p => p.name)).not.toContain(bot.name);
    expect(bot.type).toBeTruthy();
  });
});

describe('losing a seat without asking', () => {
  it('a player out of chips who does not answer the rebuy question is told, and a computer player takes the seat', async () => {
    const removed: Array<{ token: string; reason: string }> = [];
    let busted = false;
    // Ana loses everything in the first hand (set when that hand ends); nobody answers the rebuy question
    const send = (_t: string, v: { phase: string }): void => { if (v.phase === 'handEnd' && !busted) { busted = true; r.g.players[0]!.stack = 0; } };
    const r: Room = new Room('CCCCCC', 'Ana', { send, log: () => {}, removed: (token, reason) => removed.push({ token, reason }) }, FAST, 'rb-3');
    const { token } = r.seatHuman('Ana', true)!;
    void r.run();
    const t0 = Date.now();
    while (!removed.length && Date.now() - t0 < 20_000) await new Promise(res => setTimeout(res, 20));
    r.close();
    expect(removed).toEqual([{ token, reason: 'out_of_chips' }]);
    expect(r.seats[0]!.kind).toBe('bot');
    expect(new Set(r.g.players.map(p => p.name)).size).toBe(r.g.players.length); // no duplicate names
  });
  it('a player who leaves on purpose is not sent a "removed" notice', async () => {
    const removed: string[] = [];
    const r = new Room('DDDDDD', 'Ana', { send: () => {}, log: () => {}, removed: t => removed.push(t) }, FAST, 'rb-4');
    r.seatHuman('Ana', true);
    r.leave(0);
    expect(r.seats[0]!.kind).toBe('bot');
    expect(removed).toEqual([]);
    r.close();
  });
});
