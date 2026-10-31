// Apply database migrations before the server starts (Railway pre-deploy step).
// Without DATABASE_URL the server runs without storage, so there is nothing to migrate.
import { spawnSync } from 'node:child_process';

if (!process.env.DATABASE_URL) {
  console.log('DATABASE_URL is not set: skipping migrations (the server will run without storage).');
  process.exit(0);
}
const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
