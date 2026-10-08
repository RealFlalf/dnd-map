import { PROTOCOL_VERSION } from '@dnd-map/shared';
import type { ClientToServerEvents, HelloPayload, ServerToClientEvents } from '@dnd-map/shared';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import type { Config } from './config';
import type { Db } from './db';

const config: Config = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 0,
  DATABASE_URL: 'postgresql://unused',
  CORS_ORIGIN: 'http://localhost:5173',
};

const fakeDb = (ping: () => Promise<void> = async () => {}): Db => ({
  ping,
  close: async () => {},
});

let cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe('GET /api/health', () => {
  it('returns ok when the database answers', async () => {
    const app = await buildApp({ config, db: fakeDb() });
    cleanup.push(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('returns 503 when the database is unreachable', async () => {
    const app = await buildApp({
      config,
      db: fakeDb(() => Promise.reject(new Error('connection refused'))),
    });
    cleanup.push(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'unavailable' });
  });
});

describe('realtime', () => {
  it('greets the client and answers pings', async () => {
    const app = await buildApp({ config, db: fakeDb() });
    cleanup.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = connect(
      `http://127.0.0.1:${port}`,
      { transports: ['websocket'], autoConnect: false },
    );
    cleanup.push(() => socket.disconnect());
    const hello = new Promise<HelloPayload>((resolve) => socket.once('system.hello', resolve));
    socket.connect();

    expect(await hello).toEqual({ protocolVersion: PROTOCOL_VERSION });
    const before = Date.now();
    const pong = await socket.timeout(2000).emitWithAck('system.ping');
    expect(pong.serverTime).toBeGreaterThanOrEqual(before);
  });
});
