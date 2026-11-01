// The Socket.IO server: invite-code rooms, session tokens for reconnecting, input validation
// and per-socket message limits. Game logic lives in room.ts and the shared engine.
import { createServer, type Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { DEFAULT_ROSTER, validRoster } from '../../src/engine/roster.js';
import { ActMsg, CreateMsg, JoinMsg, PeekMsg, RebuyMsg, ResumeMsg, RosterMsg, SplitMsg, VariantMsg, type Ack, type TableMsg } from './protocol.js';
import { LIVE_TIMING, newCode, Room, type RoomRecord, type Timing } from './room.js';
import type { Store } from './store.js';

export interface ServerOptions {
  port?: number;
  /** Allowed browser origins for CORS (the deployed site and local dev). */
  origins: string[];
  timing?: Timing;
  /** Fixed seed for tests (deterministic decks); null in production. */
  seed?: string | null;
  record?: (e: RoomRecord) => void;
  /** Postgres storage (rooms, hands, ledger); without it settlements use the in-memory ledger. */
  store?: Store;
  /** Tests only: see every message just before it is sent, with the room's real state. */
  inspect?: (room: Room, msg: TableMsg) => void;
  /** Close a room after this long with nobody connected. */
  idleMs?: number;
}
export interface RunningServer { http: HttpServer; io: Server; rooms: Map<string, Room>; port: number; close: () => Promise<void> }

// a session is a token in a room; the seat is looked up from the token each time (seats can move
// when the creator removes a character)
interface Session { code: string; token: string }

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const http = createServer((req, res) => {
    // version: the deployed commit (Render sets RENDER_GIT_COMMIT), so checks can wait for a deploy
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size, storage: !!opts.store, version: (process.env.RENDER_GIT_COMMIT ?? '').slice(0, 7) || null })); return; }
    res.writeHead(404); res.end();
  });
  const io = new Server(http, { cors: { origin: opts.origins }, maxHttpBufferSize: 4096, pingInterval: 10_000, pingTimeout: 8_000 });
  const rooms = new Map<string, Room>();
  const sockets = new Map<string, Socket>(); // session token -> socket
  const timing = opts.timing ?? LIVE_TIMING;

  const makeRoom = (roster: Parameters<typeof validRoster>[0], character: string, games: 'dealer' | 'holdem'): Room | string => {
    const r = validRoster(roster ?? DEFAULT_ROSTER);
    if (!r) return 'that list of players cannot be used';
    // the creator plays seat 0: put their character first
    const mine = r.findIndex(c => c.id === character);
    if (mine < 0) return 'pick one of the players';
    let code = newCode();
    while (rooms.has(code)) code = newCode();
    const room = new Room(code, r, character, {
      send: (token, msg) => { opts.inspect?.(room, msg); sockets.get(token)?.emit('table', msg); },
      log: line => io.to(code).emit('log', line),
      record: e => { opts.record?.(e); void opts.store?.record(e); },
      removed: (token, reason) => { sockets.get(token)?.emit('removed', { reason }); sockets.delete(token); },
    }, timing, opts.seed ? opts.seed + ':' + code : null, games);
    rooms.set(code, room);
    return room;
  };
  const idle = new Map<string, NodeJS.Timeout>();
  const checkIdle = (room: Room): void => {
    clearTimeout(idle.get(room.code));
    if (room.humansConnected() > 0) return;
    idle.set(room.code, setTimeout(() => {
      if (room.humansConnected() > 0) return;
      room.finish();
      rooms.delete(room.code);
    }, opts.idleMs ?? 15 * 60_000));
  };

  io.on('connection', socket => {
    let session: Session | null = null;
    // at most 20 messages a second per socket; more than that and the socket is dropped
    let budget = 20, last = Date.now();
    socket.use((_packet, next) => {
      const now = Date.now();
      budget = Math.min(20, budget + ((now - last) / 1000) * 20);
      last = now;
      if (budget < 1) { socket.disconnect(true); return; }
      budget--;
      next();
    });
    const attach = (room: Room, token: string): void => {
      if (session) return;
      session = { code: room.code, token };
      sockets.get(token)?.disconnect(true); // only one live connection per seat
      sockets.set(token, socket);
      void socket.join(room.code);
      room.setConnected(token, true);
      clearTimeout(idle.get(room.code));
      const m = room.messageFor(token);
      if (m) { opts.inspect?.(room, m); socket.emit('table', m); }
    };
    const reply = (ack: unknown, body: Ack): void => { if (typeof ack === 'function') (ack as (b: Ack) => void)(body); };
    const bad = (ack: unknown, error: string): void => reply(ack, { ok: false, error });
    const current = (): Room | undefined => (session ? rooms.get(session.code) : undefined);

    socket.on('create', (msg: unknown, ack: unknown) => {
      const m = CreateMsg.safeParse(msg);
      if (!m.success || session) return bad(ack, m.success ? 'already in a room' : 'invalid request');
      const room = makeRoom(m.data.roster, m.data.character, m.data.games);
      if (typeof room === 'string') return bad(ack, room);
      const r = room.seatHuman(m.data.character, true);
      if ('error' in r) return bad(ack, r.error);
      reply(ack, { ok: true, code: room.code, token: r.token, seat: r.seat });
      attach(room, r.token);
      void room.run();
    });
    socket.on('peek', (msg: unknown, ack: unknown) => {
      const m = PeekMsg.safeParse(msg);
      if (!m.success) return bad(ack, 'invalid code');
      const room = rooms.get(m.data.code);
      if (!room) return bad(ack, 'no such room');
      if (typeof ack === 'function') (ack as (b: unknown) => void)(room.peek());
    });
    socket.on('join', (msg: unknown, ack: unknown) => {
      const m = JoinMsg.safeParse(msg);
      if (!m.success || session) return bad(ack, m.success ? 'already in a room' : 'invalid code or player');
      const room = rooms.get(m.data.code);
      if (!room) return bad(ack, 'no such room');
      const r = room.seatHuman(m.data.character);
      if ('error' in r) return bad(ack, r.error);
      reply(ack, { ok: true, code: room.code, token: r.token, seat: r.seat });
      attach(room, r.token);
      void room.run();
    });
    socket.on('resume', (msg: unknown, ack: unknown) => {
      const m = ResumeMsg.safeParse(msg);
      if (!m.success || session) return bad(ack, 'invalid session');
      const room = rooms.get(m.data.code);
      const seat = room ? room.seatOf(m.data.token) : -1;
      if (!room || seat < 0) return bad(ack, 'session not found');
      reply(ack, { ok: true, code: room.code, seat });
      attach(room, m.data.token);
    });
    // answers to what the table asks this person
    const answer = (kind: 'act' | 'variant' | 'split' | 'rebuy', value: unknown, ack: unknown): void => {
      const room = current();
      if (!room || !session) return bad(ack, 'not in a room');
      const err = room.answer(session.token, kind, value);
      reply(ack, err ? { ok: false, error: err } : { ok: true });
    };
    socket.on('act', (msg: unknown, ack: unknown) => {
      const m = ActMsg.safeParse(msg);
      if (!m.success) return bad(ack, 'invalid action');
      answer('act', m.data.type === 'raise' ? { type: 'raise', to: m.data.to ?? 0 } : { type: m.data.type }, ack);
    });
    socket.on('variant', (msg: unknown, ack: unknown) => {
      const m = VariantMsg.safeParse(msg);
      if (!m.success) return bad(ack, 'invalid game');
      answer('variant', m.data.variant, ack);
    });
    socket.on('split', (msg: unknown, ack: unknown) => {
      const m = SplitMsg.safeParse(msg);
      if (!m.success) return bad(ack, 'invalid split');
      answer('split', m.data.groups, ack);
    });
    socket.on('rebuy', (msg: unknown, ack: unknown) => {
      const m = RebuyMsg.safeParse(msg);
      if (!m.success) return bad(ack, 'invalid');
      answer('rebuy', m.data.yes, ack);
    });
    socket.on('roster', (msg: unknown, ack: unknown) => {
      const m = RosterMsg.safeParse(msg);
      const room = current();
      if (!m.success) return bad(ack, 'invalid change');
      if (!room || !session) return bad(ack, 'not in a room');
      const r = room.editRoster(session.token, m.data);
      reply(ack, r.ok ? { ok: true, queued: r.queued } : r);
    });
    socket.on('settle', async (_msg: unknown, ack: unknown) => {
      const room = current();
      if (!room) return bad(ack, 'not in a room');
      try {
        const s = opts.store ? await opts.store.settlement(room.code, room.onTable()) : room.settlement();
        // with storage: what the database holds for this room, and whether its ledger gives the
        // same balances as the room's own memory
        let extra = {};
        if (opts.store) {
          const mem = new Map(room.settlement().balances.map(b => [b.name, b.net]));
          const matchesMemory = s.balances.length === mem.size && s.balances.every(b => mem.get(b.name) === b.net);
          extra = { saved: await opts.store.saved(room.code), matchesMemory };
        }
        if (typeof ack === 'function') (ack as (b: unknown) => void)({ ok: true, ...s, stored: !!opts.store, ...extra });
      } catch (err) {
        bad(ack, 'could not compute the settlement');
        console.error(err);
      }
    });
    socket.on('leave', (_msg: unknown, ack: unknown) => {
      const room = current();
      if (!session) return bad(ack, 'not in a room');
      room?.leave(session.token);
      sockets.delete(session.token);
      void socket.leave(session.code);
      reply(ack, { ok: true });
      if (room) checkIdle(room);
      session = null;
    });
    socket.on('disconnect', () => {
      if (!session) return;
      if (sockets.get(session.token) === socket) {
        sockets.delete(session.token);
        const room = rooms.get(session.code);
        if (room) { room.setConnected(session.token, false); checkIdle(room); }
      }
    });
  });

  await new Promise<void>(resolve => http.listen(opts.port ?? 0, resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 0;
  return {
    http, io, rooms, port,
    close: async () => {
      for (const r of rooms.values()) r.finish();
      await opts.store?.flush();
      for (const t of idle.values()) clearTimeout(t);
      await new Promise<void>(resolve => io.close(() => resolve()));
    },
  };
}

