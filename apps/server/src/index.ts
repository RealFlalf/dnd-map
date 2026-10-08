import { existsSync } from 'node:fs';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const app = await buildApp({ config, db });

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await db.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.error(err);
  await db.close();
  process.exit(1);
}
