import type {
  ClientToServerEvents,
  JoinRequest,
  JoinResult,
  ParticipantView,
  ServerToClientEvents,
} from '@dnd-map/shared';
import type { AddressInfo } from 'node:net';
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

/** Starts the app on a random port; returns a factory for connected clients and a teardown. */
export async function startServer(db: Db) {
  const app = await buildApp({ config: testConfig, db });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const sockets: TestSocket[] = [];

  return {
    app,
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
    },
  };
}

export function join(socket: TestSocket, request: JoinRequest): Promise<JoinResult> {
  return socket.timeout(3000).emitWithAck('session.join', request);
}

/** Resolves with the next participant list matching the predicate. */
export function nextParticipants(
  socket: TestSocket,
  predicate: (list: ParticipantView[]) => boolean = () => true,
): Promise<ParticipantView[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('session.participants', handler);
      reject(new Error('Timed out waiting for session.participants'));
    }, 3000);
    const handler = (list: ParticipantView[]) => {
      if (!predicate(list)) return;
      clearTimeout(timer);
      socket.off('session.participants', handler);
      resolve(list);
    };
    socket.on('session.participants', handler);
  });
}
