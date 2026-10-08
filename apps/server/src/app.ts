import Fastify from 'fastify';
import { Server } from 'socket.io';
import { registerCharacterRoutes } from './characters/routes';
import { createCharacterService } from './characters/service';
import type { Config } from './config';
import type { Db } from './db';
import { registerMapRoutes } from './maps/routes';
import { createMapService } from './maps/service';
import { createLocalStorage } from './maps/storage';
import { createHttpLimiter, type HttpRuleName } from './rate-limit';
import { registerRealtime, type IoServer } from './realtime';
import { registerSessionRoutes } from './sessions/routes';
import { createSessionService } from './sessions/service';
import { createTokenService } from './tokens/service';

export interface AppDeps {
  config: Config;
  db: Db;
}

/** Which per-address limit applies to a route (matched by method and route pattern). */
const HTTP_LIMITS: Record<string, HttpRuleName> = {
  'POST /api/sessions': 'createSession',
  'GET /api/sessions/:inviteCode': 'lookup',
  'POST /api/sessions/:inviteCode/maps': 'upload',
  'POST /api/sessions/:inviteCode/icon': 'upload',
};

/** Events are tiny; a megabyte-sized message is never legitimate. */
const MAX_SOCKET_MESSAGE_BYTES = 100_000;
/** Detects a dead connection (phone left the Wi-Fi, laptop lid closed) within ~20 s. */
const PING_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = 10_000;

export async function buildApp({ config, db }: AppDeps) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
    // Behind a reverse proxy the client address comes from X-Forwarded-For.
    trustProxy: config.TRUST_PROXY === 'true',
  });
  const sessions = createSessionService(db.prisma);
  const storage = createLocalStorage(config.UPLOADS_DIR);
  const maps = createMapService(db.prisma, storage);
  const tokens = createTokenService(db.prisma);
  const characters = createCharacterService(db.prisma, storage);
  const rateLimit = config.RATE_LIMIT === 'on';

  if (rateLimit) {
    const http = createHttpLimiter();
    // onRequest runs before the body is read, so a flood of big uploads is refused cheaply.
    app.addHook('onRequest', async (req, reply) => {
      const rule = HTTP_LIMITS[`${req.method} ${req.routeOptions.url}`];
      if (rule && !http.allow(rule, req.ip)) {
        return reply.code(429).header('Retry-After', '10').send({ error: 'rate_limited' });
      }
    });
  }

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
    maxHttpBufferSize: MAX_SOCKET_MESSAGE_BYTES,
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: PING_TIMEOUT_MS,
  });
  const realtime = registerRealtime(io, {
    sessions,
    maps,
    tokens,
    characters,
    rateLimit,
    log: app.log,
  });
  registerMapRoutes(app, { sessions, maps, storage, realtime });
  registerCharacterRoutes(app, { sessions, characters, storage, realtime });

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
