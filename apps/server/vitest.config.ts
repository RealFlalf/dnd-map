import { defineConfig } from 'vitest/config';

// Integration tests run against a dedicated database, never the development one.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://dnd_map:dnd_map@localhost:5432/dnd_map_test?schema=public';

export default defineConfig({
  test: {
    env: { DATABASE_URL: testDatabaseUrl },
    globalSetup: ['./test/global-setup.ts'],
    // Test files share one database and truncate it between tests.
    fileParallelism: false,
  },
});
