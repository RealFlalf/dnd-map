import Fastify from 'fastify';
import { Server } from 'socket.io';
import type { Config } from './config';
import type { Db } from './db';
import { registerRealtime, type IoServer } from './realtime';

export interface AppDeps {
  config: Config;
  db: Db;
}

export async function buildApp({ config, db }: AppDeps) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      await db.ping();
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.error(err, 'database health check failed');
      return reply.code(503).send({ status: 'degraded', db: 'unavailable' });
    }
  });

  const io: IoServer = new Server(app.server, {
    cors: { origin: config.CORS_ORIGIN },
  });
  registerRealtime(io);

  // Open websockets would otherwise keep the HTTP server from closing.
  app.addHook('preClose', async () => {
    io.local.disconnectSockets(true);
  });
  app.addHook('onClose', async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  return Object.assign(app, { io });
}
