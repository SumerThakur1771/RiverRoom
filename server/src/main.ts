// Entry point: PORT and ALLOWED_ORIGINS (comma-separated) from the environment.
// DATABASE_URL, when set, turns on storage (rooms, hands, buy-in ledger).
import { LIVE_TIMING } from './room.js';
import { startServer } from './server.js';
import { Store } from './store.js';

const origins = (process.env.ALLOWED_ORIGINS ?? 'https://sumer-riverroom.vercel.app,http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean);
// TIMING=fast shortens bot and animation delays (browser tests only; never set in production)
const timing = process.env.TIMING === 'fast' ? { ...LIVE_TIMING, botMs: 150, pauseScale: 0.1, handEndMs: 800, betweenHandsMs: 300 } : LIVE_TIMING;
const store = process.env.DATABASE_URL ? Store.connect(process.env.DATABASE_URL) : undefined;
const s = await startServer({ port: Number(process.env.PORT ?? 8080), origins, timing, store });
console.log(`River Room server listening on ${s.port}; allowed origins: ${origins.join(', ')}; storage: ${store ? 'Postgres' : 'none (in-memory ledger only)'}`);
const stop = async (): Promise<void> => { await s.close(); await store?.close(); process.exit(0); };
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
