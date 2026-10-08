import { createServer } from 'node:net';
import { io as connect } from 'socket.io-client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  createTestDb,
  emitAck,
  joinOk,
  pngImage,
  resetDb,
  startServer,
  uploadMap,
  type TestServer,
} from '../test/helpers';

const db = createTestDb();
const servers: TestServer[] = [];

beforeEach(() => resetDb(db));
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
afterAll(() => db.close());

const start = async (options?: Parameters<typeof startServer>[1]) => {
  const server = await startServer(db, options);
  servers.push(server);
  return server;
};
const limited = { config: { RATE_LIMIT: 'on' as const } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function joinedMaster(server: TestServer) {
  const { inviteCode, participantKey } = await createSession(server);
  const socket = await server.client();
  await joinOk(socket, { inviteCode, key: participantKey });
  return { inviteCode, key: participantKey, socket };
}

describe('socket rate limiting', () => {
  it('refuses events over the limit with rate_limited and recovers after a pause', async () => {
    const server = await start(limited);
    const { socket } = await joinedMaster(server);

    const answers = await Promise.all(
      Array.from({ length: 80 }, () =>
        emitAck<{ ok: boolean; error?: string }>(socket, 'token.move', {
          tokenId: 'x',
          x: 1,
          y: 1,
        }),
      ),
    );
    const refused = answers.filter((a) => a.error === 'rate_limited');
    expect(refused.length).toBeGreaterThan(20);
    expect(answers.length - refused.length).toBeGreaterThan(20); // the first ones were served

    await sleep(1200);
    expect(await emitAck(socket, 'token.move', { tokenId: 'x', x: 1, y: 1 })).toEqual({
      ok: false,
      error: 'token_not_found', // reached the handler again
    });
  });

  it('throttles session.join so passwords-by-key cannot be guessed quickly', async () => {
    const server = await start(limited);
    const { inviteCode } = await createSession(server);
    const socket = await server.client();

    const answers = [];
    for (let i = 0; i < 12; i++) {
      answers.push(
        await emitAck<{ ok: boolean; error?: string }>(socket, 'session.join', {
          inviteCode,
          key: 'x'.repeat(43),
        }),
      );
    }

    expect(answers.slice(0, 5).every((a) => a.error === 'unknown_participant')).toBe(true);
    expect(answers.slice(5).every((a) => a.error === 'rate_limited')).toBe(true);
  });

  it('drops a connection that keeps flooding, without affecting anyone else', async () => {
    const server = await start(limited);
    const { inviteCode, socket: flooder } = await joinedMaster(server);
    const bystander = await server.client();
    await joinOk(bystander, { inviteCode, displayName: 'Игрок' });
    const gone = new Promise<string>((resolve) => flooder.once('disconnect', resolve));

    for (let i = 0; i < 600; i++) flooder.emit('token.drag', { tokenId: 'x', x: i, y: 1 });
    for (let i = 0; i < 600; i++) flooder.emit('grid.update', { mapId: 'x' }, () => undefined);

    expect(await gone).toBe('io server disconnect');
    expect(bystander.connected).toBe(true);
    expect(await emitAck(bystander, 'system.ping')).toMatchObject({
      serverTime: expect.any(Number),
    });
  });

  it('closes a connection that sends an oversized message', async () => {
    const server = await start(limited);
    const { socket } = await joinedMaster(server);
    const gone = new Promise<string>((resolve) => socket.once('disconnect', resolve));

    socket.emit('token.drag', { tokenId: 'x'.repeat(300_000), x: 1, y: 1 });

    await expect(gone).resolves.toBeTruthy();
  });

  it('does not limit anything when switched off (as the other tests rely on)', async () => {
    const server = await start();
    const { socket } = await joinedMaster(server);
    const answers = await Promise.all(
      Array.from({ length: 100 }, () =>
        emitAck<{ error?: string }>(socket, 'token.move', { tokenId: 'x', x: 1, y: 1 }),
      ),
    );
    expect(answers.some((a) => a.error === 'rate_limited')).toBe(false);
  });
});

describe('HTTP rate limiting', () => {
  const post = (server: TestServer, remoteAddress: string, headers: Record<string, string> = {}) =>
    server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { displayName: 'М' },
      remoteAddress,
      headers,
    });

  it('limits session creation per address', async () => {
    const server = await start(limited);

    const codes = [];
    for (let i = 0; i < 13; i++) codes.push((await post(server, '10.0.0.1')).statusCode);

    expect(codes.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(codes.slice(10)).toEqual([429, 429, 429]);
    expect((await post(server, '10.0.0.2')).statusCode).toBe(201); // another address is unaffected
    const refused = await post(server, '10.0.0.1');
    expect(refused.json()).toEqual({ error: 'rate_limited' });
    expect(refused.headers['retry-after']).toBeDefined();
  });

  it('refuses floods of uploads before reading them, whoever sends them', async () => {
    const server = await start(limited);
    const { inviteCode } = await createSession(server);
    const image = await pngImage(8, 8);

    const codes = [];
    for (let i = 0; i < 24; i++) {
      const res = await server.app.inject({
        method: 'POST',
        url: `/api/sessions/${inviteCode}/maps`,
        headers: { 'content-type': 'image/png' },
        body: image,
        remoteAddress: '10.0.0.3',
      });
      codes.push(res.statusCode);
    }

    expect(codes.filter((c) => c === 403)).toHaveLength(20); // reached the handler (no key)
    expect(codes.filter((c) => c === 429)).toHaveLength(4);
  });

  it('ignores X-Forwarded-For unless a proxy is trusted', async () => {
    const direct = await start(limited);
    for (let i = 0; i < 10; i++)
      await post(direct, '10.0.0.4', { 'x-forwarded-for': `1.1.1.${i}` });
    expect((await post(direct, '10.0.0.4', { 'x-forwarded-for': '2.2.2.2' })).statusCode).toBe(429);

    const proxied = await start({ config: { RATE_LIMIT: 'on', TRUST_PROXY: 'true' } });
    for (let i = 0; i < 10; i++) await post(proxied, '10.0.0.5', { 'x-forwarded-for': '3.3.3.3' });
    expect((await post(proxied, '10.0.0.5', { 'x-forwarded-for': '3.3.3.3' })).statusCode).toBe(
      429,
    );
    expect((await post(proxied, '10.0.0.5', { 'x-forwarded-for': '4.4.4.4' })).statusCode).toBe(
      201,
    );
  });
});

describe('server restart', () => {
  it('loses nothing: maps, grid, tokens and files are all there for the next server', async () => {
    const first = await start();
    const { inviteCode, participantKey: masterKey } = await createSession(first);
    const master = await first.client();
    await joinOk(master, { inviteCode, key: masterKey });
    const player = await first.client();
    const alice = await joinOk(player, { inviteCode, displayName: 'Алиса' });

    const mapId = (
      (await uploadMap(first, inviteCode, masterKey, await pngImage(700, 350))).json() as {
        mapId: string;
      }
    ).mapId;
    await emitAck(master, 'grid.update', { mapId, scale: 90, visible: false });
    const monster = await emitAck<{ token: { id: string } }>(master, 'token.create', {
      mapId,
      icon: 'dragon',
      x: 300,
      y: 100,
      visible: false,
    });
    const hero = await emitAck<{ token: { id: string } }>(player, 'character.place', {
      mapId,
      x: 100,
      y: 100,
    });
    await emitAck(player, 'character.setIcon', { icon: 'wizard' });
    const before = (await joinOk(await first.client(), { inviteCode, key: masterKey })).state;

    const uploadsDir = first.uploadsDir;
    servers.splice(servers.indexOf(first), 1);
    // keep the files: the "restarted" server uses the same directory
    const firstClose = first.app.close();
    await firstClose;

    const second = await start({ uploadsDir });
    const after = (await joinOk(await second.client(), { inviteCode, key: masterKey })).state;
    expect(after).toEqual(before);
    expect(after.tokens.map((t) => t.id).sort()).toEqual([monster.token.id, hero.token.id].sort());
    expect(after.maps[0]!.grid).toMatchObject({ scale: 90, visible: false });

    // The returning player still owns the character and the hidden monster is still hidden from them.
    const again = await second.client();
    const rejoined = await joinOk(again, { inviteCode, key: alice.participantKey! });
    expect(rejoined.state.tokens.map((t) => t.id)).toEqual([hero.token.id]);
    expect(rejoined.self.icon).toBe('builtin:wizard');
    expect(
      await emitAck(again, 'token.move', { tokenId: hero.token.id, x: 300, y: 200 }),
    ).toMatchObject({ ok: true });

    const file = await second.app.inject({ method: 'GET', url: after.maps[0]!.imageUrl });
    expect(file.statusCode).toBe(200);
  });

  it('is survived by a client that reconnects on its own and joins again', async () => {
    const port = await freePort();
    const first = await start({ port });
    const { inviteCode, participantKey } = await createSession(first);
    const mapId = (
      (await uploadMap(first, inviteCode, participantKey, await pngImage(200, 200))).json() as {
        mapId: string;
      }
    ).mapId;

    const client = connect(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnectionDelay: 50,
      reconnectionDelayMax: 100,
    });
    const states: number[] = [];
    // A server that shuts down gracefully kicks its clients; socket.io then does not reconnect on its own.
    client.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') setTimeout(() => client.connect(), 100);
    });
    client.on('connect', () => {
      // what the web client does after every (re)connect
      void client
        .timeout(3000)
        .emitWithAck('session.join', { inviteCode, key: participantKey })
        .then((r) => {
          if (r.ok) states.push(r.state.version);
        });
    });
    while (states.length < 1) await sleep(20);

    const uploadsDir = first.uploadsDir;
    servers.splice(servers.indexOf(first), 1);
    await first.app.close();
    expect(client.connected).toBe(false);

    const second = await start({ port, uploadsDir });
    while (states.length < 2) await sleep(20);
    expect(states[1]).toBe(states[0]);
    expect(await emitAck(client as never, 'state.sync')).toMatchObject({ currentMapId: mapId });
    client.close();
    void second;
  });
});
