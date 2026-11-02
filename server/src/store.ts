// Postgres storage (Prisma): rooms, players, hand histories and the buy-in / cash-out ledger.
// Writes are queued in order and never block or break the game: a failed write is logged.
import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { balancesFrom, settle, type Balance, type LedgerRow, type Transfer } from '../../src/ledger/settle.js';
import { PrismaClient } from './generated/prisma/client.js';
import type { RoomRecord } from './room.js';

/** Session tokens are stored only as SHA-256 hashes. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export class Store {
  private readonly roomIds = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  failures = 0;

  constructor(readonly db: PrismaClient) {}
  static connect(url: string): Store {
    return new Store(new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }));
  }

  /** Queue an event for writing. Resolves when written (or when the write failed and was logged). */
  record(e: RoomRecord): Promise<void> {
    const p = this.queue.then(() => this.write(e)).catch((err: unknown) => { this.failures++; console.error('store write failed:', err instanceof Error ? err.message : err); });
    this.queue = p;
    return p;
  }
  /** Wait for every queued write. */
  flush(): Promise<unknown> { return this.queue; }

  private async roomId(code: string): Promise<string> {
    let id = this.roomIds.get(code);
    if (!id) {
      id = (await this.db.room.create({ data: { code } })).id;
      this.roomIds.set(code, id);
    }
    return id;
  }
  private async playerId(roomId: string, name: string, token: string): Promise<string> {
    const tokenHash = hashToken(token);
    const p = await this.db.player.upsert({ where: { tokenHash }, update: { name }, create: { roomId, name, tokenHash } });
    return p.id;
  }

  private async write(e: RoomRecord): Promise<void> {
    const roomId = await this.roomId(e.code);
    if (e.t === 'buyin' || e.t === 'cashout') {
      const playerId = await this.playerId(roomId, e.name, e.token);
      if (e.amount > 0 || e.t === 'buyin') await this.db.ledgerEntry.create({ data: { roomId, playerId, kind: e.t === 'buyin' ? 'BUYIN' : 'CASHOUT', amount: e.amount } });
    } else if (e.t === 'hand') {
      const results = [];
      for (const r of e.results) results.push({ name: r.name, net: r.net, playerId: r.token ? await this.playerId(roomId, r.name, r.token) : null });
      await this.db.hand.create({ data: { roomId, handNo: e.handNo, log: e.lines.join('\n'), results: { create: results } } });
    } else if (e.t === 'close') {
      await this.db.room.update({ where: { id: roomId }, data: { closedAt: new Date() } });
      this.roomIds.delete(e.code);
    }
  }

  /** Ledger rows for a room from the database, plus chips still on the table (by session token). */
  async ledgerRows(code: string, onTableNow: ReadonlyMap<string, number> | (() => ReadonlyMap<string, number>) = new Map()): Promise<LedgerRow[]> {
    await this.flush();
    // read the chips on the table after the queued writes are in (a cash-out written meanwhile is not counted twice)
    const onTable = typeof onTableNow === 'function' ? onTableNow() : onTableNow;
    const roomId = this.roomIds.get(code);
    if (!roomId) return [];
    const players = await this.db.player.findMany({ where: { roomId }, include: { ledger: true }, orderBy: { joinedAt: 'asc' } });
    const tableByHash = new Map([...onTable].map(([t, v]) => [hashToken(t), v]));
    return players.map(p => ({
      name: p.name,
      buyins: p.ledger.filter(l => l.kind === 'BUYIN').reduce((a, l) => a + l.amount, 0),
      cashouts: p.ledger.filter(l => l.kind === 'CASHOUT').reduce((a, l) => a + l.amount, 0),
      onTable: tableByHash.get(p.tokenHash) ?? 0,
    }));
  }
  async settlement(code: string, onTable?: ReadonlyMap<string, number> | (() => ReadonlyMap<string, number>)): Promise<{ balances: Balance[]; transfers: Transfer[] }> {
    const balances = balancesFrom(await this.ledgerRows(code, onTable));
    return { balances, transfers: settle(balances) };
  }
  /** What is saved for a room, read back from the database (counts only). */
  async saved(code: string): Promise<{ hands: number; handResults: number; buyins: number; cashouts: number }> {
    await this.flush();
    const roomId = this.roomIds.get(code);
    if (!roomId) return { hands: 0, handResults: 0, buyins: 0, cashouts: 0 };
    const [hands, handResults, buyins, cashouts] = await Promise.all([
      this.db.hand.count({ where: { roomId } }),
      this.db.handResult.count({ where: { hand: { roomId } } }),
      this.db.ledgerEntry.count({ where: { roomId, kind: 'BUYIN' } }),
      this.db.ledgerEntry.count({ where: { roomId, kind: 'CASHOUT' } }),
    ]);
    return { hands, handResults, buyins, cashouts };
  }
  async close(): Promise<void> { await this.flush(); await this.db.$disconnect(); }
}
