import type {
  ClientToServerEvents,
  CreateSessionResponse,
  JoinRequest,
  JoinResult,
  ParticipantView,
  ServerToClientEvents,
} from '@dnd-map/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { io as connect, type Socket } from 'socket.io-client';
import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import { createDb, type Db } from '../src/db';

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const testConfig: Config = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  UPLOADS_DIR: path.join(tmpdir(), 'dnd-map-test-uploads'),
  RATE_LIMIT: 'off',
  SESSION_TTL_DAYS: 30,
  CLEANUP_INTERVAL_MINUTES: 0,
  TRUST_PROXY: 'false',
  CORS_ORIGIN: 'http://localhost:5173',
};

export function createTestDb(): Db {
  return createDb(testConfig.DATABASE_URL);
}

export async function resetDb(db: Db): Promise<void> {
  await db.prisma.$executeRawUnsafe(
    'TRUNCATE sessions, participants, maps, tokens, event_log RESTART IDENTITY CASCADE',
  );
}

/** Starts the app on a random port with its own upload directory; returns helpers and a teardown. */
export async function startServer(
  db: Db,
  options: { config?: Partial<Config>; uploadsDir?: string; port?: number } = {},
) {
  const ownsUploads = !options.uploadsDir;
  const uploadsDir = options.uploadsDir ?? (await mkdtemp(path.join(tmpdir(), 'dnd-map-test-')));
  const app = await buildApp({
    config: { ...testConfig, ...options.config, UPLOADS_DIR: uploadsDir },
    db,
  });
  await app.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  const { port } = app.server.address() as AddressInfo;
  const sockets: TestSocket[] = [];

  return {
    app,
    uploadsDir,
    port,
    async client(): Promise<TestSocket> {
      const socket: TestSocket = connect(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      return socket;
    },
    async close() {
      for (const s of sockets) s.disconnect();
      await app.close();
      if (ownsUploads) await rm(uploadsDir, { recursive: true, force: true });
    },
  };
}

export type TestServer = Awaited<ReturnType<typeof startServer>>;

export async function createSession(
  server: TestServer,
  displayName = 'Мастер',
): Promise<CreateSessionResponse> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { displayName },
  });
  if (res.statusCode !== 201) throw new Error(`createSession failed: ${res.statusCode}`);
  return res.json();
}

export function join(socket: TestSocket, request: JoinRequest): Promise<JoinResult> {
  return socket.timeout(3000).emitWithAck('session.join', request);
}

export async function joinOk(socket: TestSocket, request: JoinRequest) {
  const result = await join(socket, request);
  if (!result.ok) throw new Error(`join failed: ${result.error}`);
  return result;
}

/** A solid-colour PNG of the given size. */
export function pngImage(width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 160, b: 90 } },
  })
    .png()
    .toBuffer();
}

export async function uploadMap(
  server: TestServer,
  inviteCode: string,
  key: string | undefined,
  body: Buffer,
  contentType = 'image/png',
) {
  return server.app.inject({
    method: 'POST',
    url: `/api/sessions/${inviteCode}/maps`,
    headers: { 'content-type': contentType, ...(key && { 'x-participant-key': key }) },
    body,
  });
}

/** Resolves with the first payload of `event` that satisfies the predicate. */
export function waitFor<E extends keyof ServerToClientEvents>(
  socket: TestSocket,
  event: E,
  predicate: (...args: Parameters<ServerToClientEvents[E]>) => boolean = () => true,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler as never);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 3000);
    const handler = (...args: Parameters<ServerToClientEvents[E]>) => {
      if (!predicate(...args)) return;
      clearTimeout(timer);
      socket.off(event, handler as never);
      resolve(args[0]);
    };
    socket.on(event, handler as never);
  });
}

export function nextParticipants(
  socket: TestSocket,
  predicate: (list: ParticipantView[]) => boolean = () => true,
): Promise<ParticipantView[]> {
  return waitFor(socket, 'session.participants', predicate);
}

/** `emitWithAck` for events the test deliberately sends with invalid or unusual payloads. */
export const emitAck = <T>(socket: TestSocket, event: string, ...args: unknown[]): Promise<T> =>
  (
    socket.timeout(3000) as unknown as {
      emitWithAck: (e: string, ...a: unknown[]) => Promise<T>;
    }
  ).emitWithAck(event, ...args);

/** Everything the server sends to a socket, as text, so tests can look at the raw traffic. */
export function recordTraffic(socket: TestSocket) {
  const messages: string[] = [];
  socket.onAny((event, ...args) => messages.push(`${event} ${JSON.stringify(args)}`));
  return {
    messages,
    mark: () => messages.length,
    since: (mark: number) => messages.slice(mark).join('\n'),
  };
}
