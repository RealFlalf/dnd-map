import Fastify from 'fastify';
import { Server } from 'socket.io';
import type { Config } from './config';
import type { Db } from './db';
import { registerMapRoutes } from './maps/routes';
import { createMapService } from './maps/service';
import { createLocalStorage } from './maps/storage';
import { registerRealtime, type IoServer } from './realtime';
import { registerSessionRoutes } from './sessions/routes';
import { createSessionService } from './sessions/service';

export interface AppDeps {
  config: Config;
  db: Db;
}

export async function buildApp({ config, db }: AppDeps) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
  });
  const sessions = createSessionService(db.prisma);
  const storage = createLocalStorage(config.UPLOADS_DIR);
  const maps = createMapService(db.prisma, storage);

  app.get('/api/health', async (_req, reply) => {
    try {
      await db.ping();
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.error(err, 'database health check failed');
      return reply.code(503).send({ status: 'degraded', db: 'unavailable' });
    }
  });
  registerSessionRoutes(app, sessions);

  const io: IoServer = new Server(app.server, {
    cors: { origin: config.CORS_ORIGIN },
  });
  const realtime = registerRealtime(io, { sessions, maps, log: app.log });
  registerMapRoutes(app, { sessions, maps, storage, realtime });

  // Open websockets would otherwise keep the HTTP server from closing.
  app.addHook('preClose', async () => {
    io.local.disconnectSockets(true);
  });
  app.addHook('onClose', async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    // Disconnect handlers still write to the DB; the caller closes the DB right after app.close().
    await realtime.drain();
  });

  return Object.assign(app, { io });
}
