// Prisma configuration: schema location, migrations, and the database URL for the Prisma CLI.
// The CLI (migrate) uses the direct connection when one is given (DIRECT_DATABASE_URL, Neon's
// non-pooled string); the running server connects with DATABASE_URL (pooled) in store.ts.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '' },
});
