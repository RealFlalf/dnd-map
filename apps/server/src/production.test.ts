import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createSession,
  createTestDb,
  joinOk,
  resetDb,
  startServer,
  type TestServer,
} from '../test/helpers';

const db = createTestDb();
let webDir: string;
let server: TestServer;

beforeAll(async () => {
  webDir = await mkdtemp(path.join(tmpdir(), 'dnd-map-web-'));
  await mkdir(path.join(webDir, 'assets'));
  await writeFile(path.join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(path.join(webDir, 'assets', 'index-abc123.js'), 'console.log(1)');
});
afterEach(() => server?.close());
afterAll(async () => {
  await db.close();
  await rm(webDir, { recursive: true, force: true });
});

describe('serving the web app', () => {
  it('serves index.html for the app routes and hashed assets with long caching', async () => {
    await resetDb(db);
    server = await startServer(db, { config: { WEB_DIST_DIR: webDir } });

    for (const url of ['/', '/s/ABCD2345', '/anything/else']) {
      const page = await server.app.inject({ method: 'GET', url });
      expect(page.statusCode, url).toBe(200);
      expect(page.body).toContain('<div id="root">');
      expect(page.headers['cache-control']).toBe('no-cache');
    }

    const asset = await server.app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('keeps API errors as JSON instead of answering with the page', async () => {
    server = await startServer(db, { config: { WEB_DIST_DIR: webDir } });
    const res = await server.app.inject({ method: 'GET', url: '/api/no-such-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect((await server.app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      status: 'ok',
    });
  });

  it('does not serve the web app when no directory is configured (development uses Vite)', async () => {
    server = await startServer(db);
    expect((await server.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });
});

describe('GET /api/metrics', () => {
  it('counts connections and sessions with someone online', async () => {
    await resetDb(db);
    server = await startServer(db);
    const a = await createSession(server);
    const b = await createSession(server);
    await joinOk(await server.client(), { inviteCode: a.inviteCode, key: a.participantKey });
    await joinOk(await server.client(), { inviteCode: a.inviteCode, displayName: 'Игрок' });
    await joinOk(await server.client(), { inviteCode: b.inviteCode, key: b.participantKey });
    await server.client(); // connected but not in a session

    const metrics = (await server.app.inject({ method: 'GET', url: '/api/metrics' })).json();

    expect(metrics).toMatchObject({ connections: 4, sessionsOnline: 2 });
    expect(metrics.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(metrics.memoryMb).toBeGreaterThan(0);
  });
});
