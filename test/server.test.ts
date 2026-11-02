// Multiplayer integration test: a real Socket.IO server and real clients playing the home game
// (dealer's choice) as characters from the roster, with the computer playing the rest.
// Checks: nobody ever receives another player's hidden cards (every message, against the
// server's real state); characters lock when picked; people choose the dealer's-choice game
// and arrange their own splits; timers answer for people who stop; reconnecting by token;
// only the creator edits the roster, between hands; the creator role passes on; the waiting
// room (nothing dealt before Start; creator-only settings; joining by code with a new character).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { VARIANTS, type VariantKey } from '../src/engine/variants';
import { HIDDEN } from '../src/net/wire';
import type { Ack, PeekView, TableMsg } from '../server/src/protocol';
import type { Room } from '../server/src/room';
import { startServer, type RunningServer } from '../server/src/server';
import { mulberry32 } from '../src/engine/rng';

// bots wait 30 ms so no client has to answer more than 20 times a second (the server's per-socket limit)
const TIMING = { turnMs: 300, splitMs: 300, botMs: 30, pauseScale: 0, handEndMs: 5, betweenHandsMs: 5, rebuyMs: 100 };
const dropped: string[] = [];
const PRIVATE = ['parts', 'extra', 'plan', 'handName', 'pname', 'pscore', 'score', 'eq', 'eqAtReveal', 'vrank'];
let srv: RunningServer;
const leaks: string[] = [];
let messagesChecked = 0;

/** Every message, just before it is sent, against the room's real state (rule written out independently). */
function inspect(room: Room, m: TableMsg): void {
  messagesChecked++;
  m.game.players.forEach((wp, i) => {
    const p = room.g.players[i]!;
    const visible = i === m.you || (p.shown && !p.folded && !p.mucked);
    if (visible) {
      if (JSON.stringify(wp.cards) !== JSON.stringify(p.cards)) leaks.push(`hand ${m.game.handNo}: wrong cards for seat ${i}`);
      return;
    }
    if ((wp.cards as number[]).some(c => c !== HIDDEN) || (wp.all as number[]).some(c => c !== HIDDEN)) leaks.push(`hand ${m.game.handNo}: viewer ${m.you} got ${p.name}'s cards`);
    for (const k of PRIVATE) if (k in wp) leaks.push(`hand ${m.game.handNo}: viewer ${m.you} got ${p.name}'s ${k}`);
  });
  // another player's "Dealt to" line is allowed only once their cards are face up for this viewer
  for (const l of m.game.hist) {
    const who = /^Dealt to (.+?) \[/.exec(l)?.[1];
    if (!who) continue;
    const i = room.g.players.findIndex(p => p.name === who), p = room.g.players[i];
    if (!p || !(i === m.you || (p.shown && !p.folded && !p.mucked))) leaks.push(`viewer ${m.you} got ${who}'s dealt line (${p ? `shown=${p.shown} folded=${p.folded}` : 'unknown player'})`);
  }
}

interface Client { name: string; sock: Socket; msgs: TableMsg[]; token?: string; code?: string; quiet: boolean; answered: Set<string>; variantPick?: (choices: string[]) => string; badSplitOnce?: boolean }
const stats = { variants: 0, splits: 0, badSplitRefused: 0, chosen: [] as string[] };
const rand = mulberry32(7);
function client(name: string): Client {
  const sock = connect(`http://localhost:${srv.port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
  const c: Client = { name, sock, msgs: [], quiet: false, answered: new Set() };
  sock.on('disconnect', reason => { if (reason !== 'io client disconnect') dropped.push(`${name}: ${reason}`); });
  sock.on('table', (m: TableMsg) => {
    c.msgs.push(m);
    const a = m.ask;
    if (!a || c.quiet) return;
    const key = `${a.kind}:${a.id}`;
    if (c.answered.has(key)) return;
    c.answered.add(key);
    if (a.kind === 'act') {
      const o = a.options, u = rand();
      const act = u < 0.1 ? { type: 'fold' } : u < 0.8 || !o.canRaise ? { type: o.toCall > 0 ? 'call' : 'check' } : { type: 'raise', to: o.minTo };
      sock.emit('act', act, () => {});
    } else if (a.kind === 'variant') {
      const v = c.variantPick ? c.variantPick(a.variants) : a.variants[0] ?? 'std';
      stats.variants++;
      stats.chosen.push(v);
      sock.emit('variant', { variant: v }, () => {});
    } else if (a.kind === 'split') {
      const me = m.game.players[m.you]!, all = me.all as number[], V = VARIANTS[m.game.variant as VariantKey];
      let i = 0;
      const groups = V.parts.map(pt => { const g = all.slice(i, i + pt.n); i += pt.n; return g; });
      const send = (): void => { sock.emit('split', { groups }, (r: Ack) => { if (r.ok) stats.splits++; }); };
      if (c.badSplitOnce) {
        c.badSplitOnce = false;
        const wrong = groups.map(g => g.slice());
        wrong[0]![0] = (wrong[0]![0]! + 1) % 52; // not their card
        sock.emit('split', { groups: wrong }, (r: Ack) => { if (!r.ok && r.error === 'that is not a split of your cards') stats.badSplitRefused++; send(); });
      } else send();
    } else if (a.kind === 'rebuy') sock.emit('rebuy', { yes: true }, () => {});
  });
  return c;
}
const emit = <T = Ack>(c: Client, ev: string, msg: unknown): Promise<T> => new Promise(r => c.sock.emit(ev, msg, r));
const until = async (cond: () => boolean, ms = 30_000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); }
};
const last = (c: Client): TableMsg | undefined => c.msgs[c.msgs.length - 1];
const handNo = (c: Client): number => last(c)?.game.handNo ?? 0;

beforeAll(async () => { srv = await startServer({ origins: ['http://localhost'], timing: TIMING, seed: 'mp-test', inspect }); });
afterAll(async () => { await srv.close(); });

describe('multiplayer server', () => {
  const a = { c: null as unknown as Client }, b = { c: null as unknown as Client }, cc = { c: null as unknown as Client };

  it('rejects bad input', async () => {
    const x = client('X');
    expect(await emit(x, 'create', {})).toMatchObject({ ok: false });
    expect(await emit(x, 'create', { character: 'nobody' })).toEqual({ ok: false, error: 'pick one of the players' });
    expect(await emit(x, 'create', { character: 'p1', roster: [{ id: 'p1', name: 'A', type: 'maniac' }, { id: 'p2', name: 'B', type: 'rohit' }] })).toEqual({ ok: false, error: 'that list of players cannot be used' });
    expect(await emit(x, 'join', { code: 'nope', character: 'rohit' })).toMatchObject({ ok: false });
    expect(await emit(x, 'join', { code: 'ABCDEF', character: 'rohit' })).toEqual({ ok: false, error: 'no such room' });
    expect(await emit(x, 'peek', { code: 'ABCDEF' })).toEqual({ ok: false, error: 'no such room' });
    expect(await emit(x, 'resume', { code: 'ABCDEF', token: 'x'.repeat(32) })).toMatchObject({ ok: false });
    expect(await emit(x, 'act', { type: 'raise', to: 100 })).toMatchObject({ ok: false });
    expect(await emit(x, 'roster', { op: 'remove', id: 'venky' })).toMatchObject({ ok: false });
    expect(await emit(x, 'split', { groups: [[1, 2]] })).toMatchObject({ ok: false });
    x.sock.close();
  });

  it('people pick characters; a picked character is locked; the computer plays the rest in their styles', async () => {
    a.c = client('Ana');
    a.c.variantPick = v => (v.includes('std') ? 'std' : v[0]!); // split games, so people arrange their cards
    const r = await emit(a.c, 'create', { character: 'rohit', games: 'dealer' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    a.c.token = r.token; a.c.code = r.code;
    const peek = await emit<PeekView>(a.c, 'peek', { code: r.code });
    // listed in seat order (seats are dealt at random); only the creator's character is taken
    expect(peek.roster.map(c => `${c.name}:${c.taken}`).sort()).toEqual(['Krish:false', 'Nikhil:false', 'Rohit:true', 'Sumer:false', 'Venky:false']);
    expect(peek.creatorName).toBe('Rohit');
    const thief = client('Thief');
    expect(await emit(thief, 'join', { code: r.code, character: 'rohit' })).toEqual({ ok: false, error: 'Rohit is already taken' });
    thief.sock.close();
    for (const [h, name, ch] of [[b, 'Ben', 'sumer'], [cc, 'Cy', 'krish']] as const) {
      h.c = client(name);
      h.c.variantPick = a.c.variantPick!;
      const j = await emit(h.c, 'join', { code: r.code, character: ch });
      expect(j.ok).toBe(true);
      if (j.ok) { h.c.token = j.token; h.c.code = j.code; }
    }
    cc.c.badSplitOnce = true;
    // a waiting room until the creator presses Start; only the creator can
    await new Promise(res => setTimeout(res, 100));
    expect(last(a.c)!).toMatchObject({ started: false, phase: 'waiting' });
    expect(last(a.c)!.game.handNo).toBe(0);
    expect(await emit(b.c, 'start', {})).toEqual({ ok: false, error: 'only the person who started the table can start the game' });
    expect(await emit(a.c, 'start', {})).toEqual({ ok: true });
    await until(() => handNo(cc.c) >= 3);
    const m = last(a.c)!;
    expect(m.roster.filter(x => x.taken).map(x => x.name).sort()).toEqual(['Krish', 'Rohit', 'Sumer']);
    expect(m.roster.find(x => x.you)?.name).toBe('Rohit');
    const room = srv.rooms.get(r.code!)!;
    const bots = room.g.players.filter(p => !p.isHuman);
    expect(bots.map(p => `${p.name}:${p.type}`).sort()).toEqual(['Nikhil:nikhil', 'Venky:venky']);
    expect(room.g.players.filter(p => p.isHuman).map(p => p.name).sort()).toEqual(['Krish', 'Rohit', 'Sumer']);
  });

  it('plays dealer\'s choice: people pick the game when they deal and arrange their own split; wrong splits are refused', async () => {
    await until(() => handNo(a.c) >= 14 && stats.splits >= 2, 60_000);
    expect(stats.variants).toBeGreaterThanOrEqual(1);
    expect(stats.badSplitRefused).toBe(1);
    // the game people chose is the game that was dealt
    expect(a.c.msgs.some(m => m.game.variant === 'std')).toBe(true);
  });

  it('a person who stops answering is answered for when the timer runs out (act, game, split)', async () => {
    cc.c.quiet = true;
    const from = handNo(cc.c);
    await until(() => cc.c.msgs.some(m => m.ask && m.game.handNo > from));
    await until(() => handNo(a.c) >= from + 3);
    cc.c.quiet = false;
  });

  it('a disconnected person keeps the seat and gets it back, with the same cards, by session token', async () => {
    await until(() => { const m = last(b.c); return !!m && m.phase === 'playing' && (m.game.players[m.you]!.cards as number[]).length > 0 && !(m.game.players[m.you]!.cards as number[]).includes(HIDDEN); });
    const before = last(b.c)!, myCards = before.game.players[before.you]!.cards, hand = before.game.handNo;
    a.c.quiet = true; cc.c.quiet = true; // keep this hand running while Ben is away
    b.c.sock.close();
    await until(() => last(a.c)!.roster.find(x => x.id === 'sumer')!.connected === false);
    const again = client('Ben');
    again.variantPick = b.c.variantPick;
    const r = await emit(again, 'resume', { code: b.c.code!, token: b.c.token! });
    expect(r).toEqual({ ok: true, code: b.c.code, seat: before.you });
    await until(() => again.msgs.length > 0);
    const first = again.msgs[0]!;
    expect(first.you).toBe(before.you);
    expect(first.character).toBe('sumer');
    expect(first.game.handNo).toBe(hand);
    expect(first.game.players[first.you]!.cards).toEqual(myCards);
    a.c.quiet = false; cc.c.quiet = false;
    b.c = again;
    await until(() => handNo(again) >= hand + 2);
  });

  it('a wrong token cannot take over a seat', async () => {
    const x = client('Eve');
    expect(await emit(x, 'resume', { code: a.c.code!, token: 'A'.repeat(32) })).toEqual({ ok: false, error: 'session not found' });
    x.sock.close();
  });

  it('only the creator edits the roster; changes made during a hand wait for it to end; picked characters cannot be removed', async () => {
    const code = a.c.code!, room = srv.rooms.get(code)!;
    expect(await emit(b.c, 'roster', { op: 'rename', id: 'nikhil', name: 'Nik' })).toEqual({ ok: false, error: 'only the person who started the table can change the players' });
    expect(await emit(a.c, 'roster', { op: 'remove', id: 'sumer' })).toEqual({ ok: false, error: 'Sumer is being played by someone' });
    expect(await emit(a.c, 'roster', { op: 'rename', id: 'nikhil', name: 'kRiSh' })).toEqual({ ok: false, error: 'kRiSh is already at the table.' });
    const ren = await emit(a.c, 'roster', { op: 'rename', id: 'nikhil', name: 'Nik' });
    const add = await emit(a.c, 'roster', { op: 'add', name: 'Asha', type: 'nikhil' });
    const rem = await emit(a.c, 'roster', { op: 'remove', id: 'venky' });
    expect([ren.ok, add.ok, rem.ok]).toEqual([true, true, true]);
    const h = handNo(a.c);
    await until(() => handNo(a.c) >= h + 2);
    expect(room.g.players.map(p => p.name).sort()).toEqual(['Asha', 'Krish', 'Nik', 'Rohit', 'Sumer']);
    expect(room.g.players.every((p, i) => p.i === i)).toBe(true);
    expect(new Set(room.g.players.map(p => p.seat)).size).toBe(room.g.players.length);
    expect(last(b.c)!.roster.map(x => x.name)).toEqual(room.chars.map(c => c.name));
    expect(room.g.players.find(p => p.name === 'Asha')!.type).toBe('nikhil');
    // people keep their seats and the game goes on
    expect(last(b.c)!.game.players[last(b.c)!.you]!.name).toBe('Sumer');
    await until(() => handNo(b.c) >= h + 4);
  });

  it('when the creator leaves, whoever has been at the table longest manages it; the seat goes and the character is free to pick', async () => {
    expect((await emit(a.c, 'leave', {})).ok).toBe(true);
    await until(() => last(b.c)!.creator === true);
    await until(() => !last(b.c)!.roster.some(x => x.id === 'rohit'));
    expect(last(cc.c)!.creator).toBe(false);
    const room = srv.rooms.get(a.c.code!)!;
    const h = handNo(b.c);
    await until(() => handNo(b.c) >= h + 2);
    expect(room.g.players.map(p => p.name)).not.toContain('Rohit');
    const peek = await emit<PeekView>(b.c, 'peek', { code: a.c.code! });
    expect(peek.free.find(c => c.id === 'rohit')).toMatchObject({ seated: false });
    a.c.sock.close();
  });

  it('a friend joins with the code as a new character mid-game, sits down between hands; the creator sets the timer and computers and can remove them', async () => {
    const code = cc.c.code!, room = srv.rooms.get(code)!;
    expect(await emit(cc.c, 'settings', { timer: 0 })).toEqual({ ok: false, error: 'only the person who started the table can change the settings' });
    expect(await emit(b.c, 'settings', { timer: 15 })).toMatchObject({ ok: true });
    await until(() => last(cc.c)!.timer === 15);
    const d = client('Dee');
    d.variantPick = b.c.variantPick;
    const j = await emit(d, 'join', { code, create: { name: 'Dee', type: 'venky' } });
    expect(j).toMatchObject({ ok: true });
    await until(() => d.msgs.length > 0);
    await until(() => last(d)!.you >= 0, 30_000);
    // a fresh buy-in when they sit down (the first message where they have a seat)
    const seated = d.msgs.find(m => m.you >= 0)!;
    expect(seated.game.players[seated.you]).toMatchObject({ name: 'Dee', stack: 1000, buyins: 1 });
    expect(last(b.c)!.roster.find(x => x.name === 'Dee')).toMatchObject({ taken: true });
    // the creator: no computers at all, then removes Dee
    expect(await emit(b.c, 'settings', { computers: 0 })).toMatchObject({ ok: true });
    await until(() => room.g.players.every(p => p.isHuman), 30_000);
    let removed = '';
    d.sock.on('removed', (m: { reason: string }) => { removed = m.reason; });
    const id = last(b.c)!.roster.find(x => x.name === 'Dee')!.id;
    expect(await emit(b.c, 'kick', { id })).toEqual({ ok: true });
    await until(() => removed === 'removed');
    await until(() => !room.g.players.some(p => p.name === 'Dee'), 30_000);
    d.sock.close();
  });

  it('never sent anyone a hidden card or hand detail', () => {
    expect(dropped).toEqual([]);
    expect(leaks.slice(0, 10)).toEqual([]);
    expect(messagesChecked).toBeGreaterThan(1000);
    console.log(`checked ${messagesChecked} messages: ${leaks.length} leaks; human splits ${stats.splits}, games chosen by people ${stats.variants}`);
    for (const c of [b.c, cc.c]) c.sock.close();
  });
});
