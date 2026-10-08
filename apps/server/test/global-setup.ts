import { execSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

/** Creates the test database if needed and brings it to the latest migration. */
export default function setup(project: TestProject): void {
  const databaseUrl = project.config.env.DATABASE_URL;
  if (!databaseUrl?.includes('test')) {
    throw new Error(`Refusing to run tests against a non-test database: ${databaseUrl}`);
  }
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
