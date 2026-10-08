import { PROTOCOL_VERSION } from '@dnd-map/shared';
import type { HelloPayload } from '@dnd-map/shared';
import { io as connect } from 'socket.io-client';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, startServer, testConfig, type TestSocket } from '../test/helpers';
import { buildApp } from './app';

const db = createTestDb();
afterAll(() => db.close());

describe('GET /api/health', () => {
  it('returns ok when the database answers', async () => {
    const app = await buildApp({ config: testConfig, db });

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('returns 503 when the database is unreachable', async () => {
    const brokenDb = { ...db, ping: () => Promise.reject(new Error('connection refused')) };
    const app = await buildApp({ config: testConfig, db: brokenDb });

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'unavailable' });
  });
});

describe('realtime', () => {
  it('greets the client and answers pings', async () => {
    const server = await startServer(db);
    const { port } = server.app.server.address() as { port: number };
    // Connect manually: the hello event is sent right on connect and must not be missed.
    const socket: TestSocket = connect(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      autoConnect: false,
    });
    const hello = new Promise<HelloPayload>((resolve) => socket.once('system.hello', resolve));
    socket.connect();

    try {
      expect(await hello).toEqual({ protocolVersion: PROTOCOL_VERSION });
      const before = Date.now();
      const pong = await socket.timeout(2000).emitWithAck('system.ping');
      expect(pong.serverTime).toBeGreaterThanOrEqual(before);
    } finally {
      socket.disconnect();
      await server.close();
    }
  });
});
