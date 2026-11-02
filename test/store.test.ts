// Postgres storage, end to end: a real server with a real database, three real clients.
// Runs when TEST_DATABASE_URL is set (CI uses a Postgres service container); skipped otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { TableMsg } from '../server/src/protocol';
import { startServer, type RunningServer } from '../server/src/server';
import { hashToken, Store } from '../server/src/store';
import { settle, type Balance, type Transfer } from '../src/ledger/settle';

const URL_ = process.env.TEST_DATABASE_URL;
// bots wait 30 ms so a client never gets more than 20 turns a second (the server's per-socket limit)
const TIMING = { turnMs: 300, splitMs: 300, botMs: 30, pauseScale: 0, handEndMs: 5, betweenHandsMs: 5, rebuyMs: 100 };

describe.skipIf(!URL_)('Postgres storage (rooms, hands, ledger, settlement)', () => {
  let srv: RunningServer, store: Store;
  const clients: Array<{ sock: Socket; views: TableMsg[]; token?: string; name: string }> = [];
  let code = '';
  const dropped: string[] = [];

  beforeAll(async () => {
    store = Store.connect(URL_!);
    await store.db.$executeRawUnsafe('TRUNCATE "LedgerEntry", "HandResult", "Hand", "Player", "Room" CASCADE');
    srv = await startServer({ origins: ['http://localhost'], timing: TIMING, seed: 'db-test', store });
  });
  afterAll(async () => {
    for (const c of clients) c.sock.close();
    await srv.close();
    await store.close();
  });

  const client = (name: string) => {
    const sock = connect(`http://localhost:${srv.port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
    const c = { sock, views: [] as TableMsg[], name, token: undefined as string | undefined };
    // answer each question once (the server drops sockets that flood it): call or check, rebuy,
    // Hold'em when dealing, and the computer's own split order for split games
    const answered = new Set<string>();
    sock.on('table', (m: TableMsg) => {
      c.views.push(m);
      const a = m.ask;
      if (!a || answered.has(a.kind + a.id)) return;
      answered.add(a.kind + a.id);
      if (a.kind === 'act') sock.emit('act', { type: a.options.toCall > 0 ? 'call' : 'check' }, () => {});
      else if (a.kind === 'rebuy') sock.emit('rebuy', { yes: true }, () => {});
      else if (a.kind === 'variant') sock.emit('variant', { variant: 'holdem' }, () => {});
    });
    sock.on('disconnect', reason => { if (reason !== 'io client disconnect') dropped.push(`${name}: ${reason}`); });
    clients.push(c);
    return c;
  };
  const emit = <T>(c: { sock: Socket }, ev: string, msg: unknown): Promise<T> => new Promise(r => c.sock.emit(ev, msg, r));
  const until = async (cond: () => boolean, ms = 30_000): Promise<void> => {
    const t0 = Date.now();
    while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
  };

  it('records buy-ins, hands and a cash-out, and settles from the database exactly as from memory', async () => {
    // Ana plays Sumer, Ben plays Rohit, Cy plays Krish; the computer plays Nikhil and Venky
    const a = client('Ana');
    const r = await emit<{ ok: boolean; code: string; token: string }>(a, 'create', { character: 'sumer', games: 'holdem' });
    code = r.code; a.token = r.token;
    for (const [name, character] of [['Ben', 'rohit'], ['Cy', 'krish']]) {
      const c = client(name!);
      const j = await emit<{ ok: boolean; token: string }>(c, 'join', { code, character });
      c.token = j.token;
    }
    expect(await emit(a, 'start', {})).toEqual({ ok: true });
    await until(() => (a.views[a.views.length - 1]?.game.handNo ?? 0) >= 6);
    const ben = clients[1]!;
    await emit(ben, 'leave', {});
    await until(() => (a.views[a.views.length - 1]?.game.handNo ?? 0) >= 8);

    expect(dropped).toEqual([]);
    const fromDb = await emit<{ ok: boolean; stored: boolean; balances: Balance[]; transfers: Transfer[]; saved: { hands: number; handResults: number; buyins: number; cashouts: number }; matchesMemory: boolean }>(a, 'settle', {});
    expect(fromDb.ok).toBe(true);
    expect(fromDb.stored).toBe(true);
    expect(fromDb.matchesMemory).toBe(true);
    expect(fromDb.saved.hands).toBeGreaterThanOrEqual(7);
    expect(fromDb.saved.buyins).toBeGreaterThanOrEqual(3);
    expect(fromDb.saved.cashouts).toBeLessThanOrEqual(1);
    const room = srv.rooms.get(code)!;
    const fromMemory = room.settlement();
    // same balances (order aside) whether read from Postgres or from memory
    const byName = (b: Balance[]) => Object.fromEntries(b.map(x => [x.name, x.net]));
    expect(byName(fromDb.balances)).toEqual(byName(fromMemory.balances));
    expect(fromDb.balances.reduce((s, b) => s + b.net, 0)).toBe(0);
    expect(fromDb.transfers).toEqual(settle(fromDb.balances));
    expect(Object.keys(byName(fromDb.balances))).toEqual(expect.arrayContaining(['Sumer', 'Rohit', 'Krish']));

    await store.flush();
    expect(store.failures).toBe(0); // every write went through
    const db = store.db;
    const dbRoom = await db.room.findFirstOrThrow({ where: { code } });
    const hands = await db.hand.findMany({ where: { roomId: dbRoom.id }, include: { results: true }, orderBy: { handNo: 'asc' } });
    expect(hands.length).toBeGreaterThanOrEqual(7);
    // five players, then four once Ben leaves (a person who leaves gives up their seat)
    expect(hands.every(h => h.results.length === 5 || h.results.length === 4)).toBe(true);
    expect(hands[0]!.results).toHaveLength(5);
    expect(hands[hands.length - 1]!.results).toHaveLength(4);
    expect(hands.every(h => !h.log.includes('Dealt to'))).toBe(true); // private cards are not stored
    const ledger = await db.ledgerEntry.findMany({ where: { roomId: dbRoom.id }, include: { player: true } });
    expect(ledger.filter(l => l.kind === 'BUYIN').length).toBeGreaterThanOrEqual(3);
    // Ben's (Rohit's) cash-out: the same in Postgres as in memory, and equal to his buy-ins plus his
    // stored per-hand results (the hand histories and the ledger agree)
    const benOut = ledger.filter(l => l.kind === 'CASHOUT' && l.player.name === 'Rohit');
    expect(benOut).toHaveLength(1);
    expect(benOut[0]!.amount).toBe(room.ledgerRows().find(r => r.name === 'Rohit')!.cashouts);
    const benIn = ledger.filter(l => l.kind === 'BUYIN' && l.player.name === 'Rohit').reduce((s, l) => s + l.amount, 0);
    const benNet = hands.flatMap(h => h.results).filter(r => r.playerId === benOut[0]!.playerId).reduce((s, r) => s + r.net, 0);
    expect(benOut[0]!.amount).toBe(benIn + benNet);
    // session tokens are only stored hashed
    const players = await db.player.findMany({ where: { roomId: dbRoom.id } });
    for (const c of clients) {
      expect(players.some(p => p.tokenHash === hashToken(c.token!))).toBe(true);
      expect(players.some(p => p.tokenHash === c.token || p.name === c.token)).toBe(false);
    }
    console.log(`stored ${hands.length} hands, ${ledger.length} ledger entries; settlement: ${fromDb.transfers.map(t => `${t.from} -> ${t.to} $${(t.amount / 100).toFixed(2)}`).join('; ') || 'nobody owes anything'}`);
  });
});
