// Multiplayer integration test: a real Socket.IO server and three real clients play full hands
// against two bots. Checks: nobody ever receives another player's hidden cards, the game keeps
// going when a player times out or disconnects, a reconnect with the session token gets the
// seat (and its cards) back, and bad input is rejected.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { Ack, View } from '../server/src/protocol';
import type { Room } from '../server/src/room';
import { startServer, type RunningServer } from '../server/src/server';
import { mulberry32 } from '../src/engine/rng';

const TIMING = { turnMs: 300, botMs: 0, pauseScale: 0, handEndMs: 5, betweenHandsMs: 5, rebuyMs: 100 };
let srv: RunningServer;
const leaks: string[] = [];
let viewsChecked = 0;

/** Called with every view just before the server sends it: compare with the real game state. */
function inspect(room: Room, v: View): void {
  viewsChecked++;
  // someone waiting for a seat (still held by a bot this hand) owns no cards yet: for them
  // every seat, including the one they will take, follows the public rule
  const seated = room.seats[v.you]?.kind === 'human';
  for (const s of v.seats) {
    const p = room.g.players[s.seat]!;
    if (s.seat === v.you && seated && s.cards) {
      if (JSON.stringify(s.cards) !== JSON.stringify(p.cards)) leaks.push(`seat ${v.you} got wrong own cards`);
      continue;
    }
    if (s.cards && !(p.shown && !p.folded && !p.mucked)) leaks.push(`hand ${v.handNo}: ${seated ? 'seat ' + v.you : 'a player waiting for seat ' + v.you} saw seat ${s.seat}'s hidden cards`);
  }
}

interface Client { name: string; sock: Socket; views: View[]; token?: string; seat?: number; code?: string; quiet: boolean; acted: Set<number> }
function client(name: string): Client {
  const sock = connect(`http://localhost:${srv.port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
  const c: Client = { name, sock, views: [], quiet: false, acted: new Set() };
  wire(c);
  return c;
}
const rand = mulberry32(7);
function wire(c: Client): void {
  c.sock.on('state', (v: View) => {
    c.views.push(v);
    if (v.rebuy) c.sock.emit('rebuy', { yes: true });
    const t = v.turn;
    if (!c.quiet && t && t.seat === v.you && t.options && !c.acted.has(t.deadline)) {
      c.acted.add(t.deadline);
      const o = t.options, u = rand();
      const a = u < 0.15 ? { type: 'fold' } : u < 0.7 || !o.canRaise ? { type: o.toCall > 0 ? 'call' : 'check' } : u < 0.9 ? { type: 'raise', to: o.minTo } : { type: 'raise', to: o.maxTo };
      c.sock.emit('act', a, () => {});
    }
  });
}
const emit = (c: Client, ev: string, msg: unknown): Promise<Ack> => new Promise(r => c.sock.emit(ev, msg, r));
const until = async (cond: () => boolean, ms = 20_000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); }
};
const lastView = (c: Client): View | undefined => c.views[c.views.length - 1];

beforeAll(async () => { srv = await startServer({ origins: ['http://localhost'], timing: TIMING, seed: 'mp-test', inspect }); });
afterAll(async () => { await srv.close(); });

describe('multiplayer server', () => {
  const a = { c: null as unknown as Client }, b = { c: null as unknown as Client }, cc = { c: null as unknown as Client };

  it('rejects bad input', async () => {
    const x = client('X');
    expect(await emit(x, 'create', { name: '' })).toMatchObject({ ok: false });
    expect(await emit(x, 'join', { code: 'nope', name: 'X' })).toMatchObject({ ok: false });
    expect(await emit(x, 'join', { code: 'ABCDEF', name: 'X' })).toEqual({ ok: false, error: 'no such room' });
    expect(await emit(x, 'resume', { code: 'ABCDEF', token: 'x'.repeat(32) })).toMatchObject({ ok: false });
    expect(await emit(x, 'act', { type: 'raise', to: 100 })).toMatchObject({ ok: false });
    x.sock.close();
  });

  it('three players create and join a room by invite code; bots fill the other seats', async () => {
    a.c = client('Ana');
    const r = await emit(a.c, 'create', { name: 'Ana' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    a.c.token = r.token; a.c.code = r.code;
    expect(r.code).toMatch(/^[A-Z2-9]{6}$/);
    for (const [h, name] of [[b, 'Ben'], [cc, 'Cy']] as const) {
      h.c = client(name);
      const j = await emit(h.c, 'join', { code: r.code, name });
      expect(j.ok).toBe(true);
      if (j.ok) { h.c.token = j.token; h.c.seat = j.seat; h.c.code = j.code; }
    }
    await until(() => (lastView(cc.c)?.handNo ?? 0) >= 3);
    const v = lastView(a.c)!;
    expect(v.seats.filter(s => s.kind === 'human').map(s => s.name).sort()).toEqual(['Ana', 'Ben', 'Cy']);
    expect(v.seats.filter(s => s.kind === 'bot')).toHaveLength(2);
  });

  it('a player who stops acting is folded (or checked) for when the turn timer runs out', async () => {
    cc.c.quiet = true;
    const from = lastView(cc.c)!.handNo;
    await until(() => cc.c.views.some(v => v.turn?.seat === v.you && v.handNo > from));
    await until(() => (lastView(a.c)?.handNo ?? 0) >= from + 2);
    cc.c.quiet = false;
  });

  it('a disconnected player keeps the seat and gets it back, with the same cards, by session token', async () => {
    await until(() => { const v = lastView(b.c); return !!v && v.phase === 'playing' && !!v.seats[v.you]!.cards; });
    const before = lastView(b.c)!, myCards = before.seats[before.you]!.cards, hand = before.handNo;
    // the others stop acting for a moment so this hand is still running when Ben comes back
    a.c.quiet = true; cc.c.quiet = true;
    b.c.sock.close();
    await until(() => lastView(a.c)!.seats[before.you]!.connected === false);
    const again = client('Ben');
    const r = await emit(again, 'resume', { code: b.c.code!, token: b.c.token! });
    expect(r).toEqual({ ok: true, code: b.c.code, seat: before.you });
    await until(() => again.views.length > 0);
    const first = again.views[0]!;
    expect(first.you).toBe(before.you);
    expect(first.handNo).toBe(hand);
    expect(first.seats[first.you]!.cards).toEqual(myCards);
    await until(() => lastView(a.c)!.seats[before.you]!.connected === true);
    a.c.quiet = false; cc.c.quiet = false;
    b.c = again;
    await until(() => (lastView(again)?.handNo ?? 0) >= hand + 2);
  });

  it('a wrong token cannot take over a seat', async () => {
    const x = client('Eve');
    expect(await emit(x, 'resume', { code: a.c.code!, token: 'A'.repeat(32) })).toEqual({ ok: false, error: 'session not found' });
    x.sock.close();
  });

  it('plays many full hands without ever sending anyone hidden cards', async () => {
    await until(() => (lastView(a.c)?.handNo ?? 0) >= 12, 60_000);
    expect(leaks).toEqual([]);
    expect(viewsChecked).toBeGreaterThan(200);
    // every client did see its own cards, and some cards turned face up at showdowns
    for (const c of [a.c, b.c, cc.c]) expect(c.views.some(v => !!v.seats[v.you]!.cards)).toBe(true);
    expect([a.c, b.c, cc.c].some(c => c.views.some(v => v.seats.some(s => s.seat !== v.you && s.cards)))).toBe(true);
    console.log(`checked ${viewsChecked} views over ${lastView(a.c)!.handNo} hands: ${leaks.length} leaks`);
    for (const c of [a.c, b.c, cc.c]) c.sock.close();
  });
});
