// Apply database migrations before the server starts (Render start command).
// Migrations use DIRECT_DATABASE_URL when it is set: Neon's pooled connection (PgBouncer in
// transaction mode) does not support the session-level locks `prisma migrate` takes, so it
// needs the direct one. The running server uses the pooled DATABASE_URL.
// Without either, the server runs without storage, so there is nothing to migrate.
import { spawnSync } from 'node:child_process';

if (!process.env.DIRECT_DATABASE_URL && !process.env.DATABASE_URL) {
  console.log('No DATABASE_URL: skipping migrations (the server will run without storage).');
  process.exit(0);
}
console.log(`Applying migrations over ${process.env.DIRECT_DATABASE_URL ? 'DIRECT_DATABASE_URL' : 'DATABASE_URL'}.`);
const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
