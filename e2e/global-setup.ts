import { execSync } from 'node:child_process';
import path from 'node:path';
import { E2E_DATABASE_URL } from './playwright.config';

/** Brings the e2e database to the latest migration and empties it. */
export default function globalSetup(): void {
  if (!E2E_DATABASE_URL.includes('e2e')) {
    throw new Error(`Refusing to run e2e tests against ${E2E_DATABASE_URL}`);
  }
  const server = path.resolve(import.meta.dirname, '../apps/server');
  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL };
  execSync('pnpm exec prisma migrate deploy', { cwd: server, env, stdio: 'pipe' });
  execSync(`pnpm exec prisma db execute --url "${E2E_DATABASE_URL}" --stdin`, {
    cwd: server,
    env,
    stdio: 'pipe',
    input: 'TRUNCATE sessions, participants, maps, tokens, event_log RESTART IDENTITY CASCADE;',
  });
}
