import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'node:path';
import { Server } from 'socket.io';
import { registerCharacterRoutes } from './characters/routes';
import { createCharacterService } from './characters/service';
import type { Config } from './config';
import type { Db } from './db';
import { registerMapRoutes } from './maps/routes';
import { createMapService } from './maps/service';
import { createLocalStorage } from './maps/storage';
import { runCleanup } from './maintenance/cleanup';
import { createHttpLimiter, type HttpRuleName } from './rate-limit';
import { registerRealtime, type IoServer } from './realtime';
import { registerSessionRoutes } from './sessions/routes';
import { createSessionService } from './sessions/service';
import { createObstacleService } from './obstacles/service';
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
  const obstacles = createObstacleService(db.prisma);
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

  // Production: one process serves the API, the realtime connection and the web app.
  if (config.WEB_DIST_DIR) {
    await app.register(fastifyStatic, {
      root: path.resolve(config.WEB_DIST_DIR),
      wildcard: false,
      setHeaders(reply, filePath) {
        // Built assets have content hashes in their names; index.html must always be fresh.
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
        reply.header(
          'Cache-Control',
          immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
    // Client-side routes (/s/ABCD2345) all load the same page.
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/api/') &&
        !req.url.startsWith('/socket.io')
      ) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

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
    obstacles,
    rateLimit,
    log: app.log,
  });
  registerMapRoutes(app, { sessions, maps, storage, realtime });
  registerCharacterRoutes(app, { sessions, characters, storage, realtime });

  // Numbers for monitoring; nothing in here identifies a session or a person.
  const startedAt = Date.now();
  app.get('/api/metrics', async () => {
    const sockets = await io.fetchSockets();
    const sessionsOnline = new Set(sockets.flatMap((s) => s.data.session?.sessionId ?? []));
    return {
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      connections: sockets.length,
      sessionsOnline: sessionsOnline.size,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  });

  // Periodic cleanup of expired sessions and orphaned files. The first run waits a minute so a
  // restart is not slowed down; runs never overlap.
  let cleanupTimer: NodeJS.Timeout | undefined;
  let cleanupRunning: Promise<void> | null = null;
  if (config.CLEANUP_INTERVAL_MINUTES > 0) {
    const cleanup = () => {
      if (cleanupRunning) return;
      cleanupRunning = runCleanup(db.prisma, storage, {
        sessionTtlMs: config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
        orphanGraceMs: 60 * 60 * 1000,
        isActive: async (sessionId) => (await io.in(sessionId).fetchSockets()).length > 0,
      })
        .then((report) => app.log.info(report, 'cleanup finished'))
        .catch((err: unknown) => app.log.error(err, 'cleanup failed'))
        .finally(() => (cleanupRunning = null));
    };
    const first = setTimeout(() => {
      cleanup();
      cleanupTimer = setInterval(cleanup, config.CLEANUP_INTERVAL_MINUTES * 60 * 1000);
      cleanupTimer.unref();
    }, 60 * 1000);
    first.unref();
    app.addHook('onClose', async () => {
      clearTimeout(first);
      clearInterval(cleanupTimer);
      await cleanupRunning;
    });
  }

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
