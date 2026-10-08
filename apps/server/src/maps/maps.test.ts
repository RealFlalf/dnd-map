import {
  GRID_SCALE_DEFAULT,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  MAX_MAPS_PER_SESSION,
  type SessionState,
} from '@dnd-map/shared';
import { readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  createTestDb,
  joinOk,
  pngImage,
  resetDb,
  startServer,
  uploadMap,
  waitFor,
  type TestServer,
  type TestSocket,
} from '../../test/helpers';

const gifImage = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
    .gif()
    .toBuffer();

const db = createTestDb();
let server: TestServer;

beforeEach(async () => {
  await resetDb(db);
  server = await startServer(db);
});
afterEach(() => server.close());
afterAll(() => db.close());

/** A session with a connected master and one connected player. */
async function setup() {
  const { inviteCode, participantKey } = await createSession(server);
  const masterSocket = await server.client();
  const master = await joinOk(masterSocket, { inviteCode, key: participantKey });
  const playerSocket = await server.client();
  const player = await joinOk(playerSocket, { inviteCode, displayName: 'Игрок' });
  return {
    inviteCode,
    masterKey: participantKey,
    playerKey: player.participantKey!,
    masterSocket,
    playerSocket,
    initialState: master.state,
  };
}

async function addMap(inviteCode: string, masterKey: string, width = 64, height = 48) {
  const res = await uploadMap(server, inviteCode, masterKey, await pngImage(width, height));
  expect(res.statusCode).toBe(201);
  return (res.json() as { mapId: string }).mapId;
}

const emitAck = <T>(socket: TestSocket, event: string, ...args: unknown[]): Promise<T> =>
  (
    socket.timeout(3000) as unknown as { emitWithAck: (e: string, ...a: unknown[]) => Promise<T> }
  ).emitWithAck(event, ...args);

describe('map upload', () => {
  it('stores the map, makes it current and shows it to everyone', async () => {
    const { inviteCode, masterKey, masterSocket, playerSocket, initialState } = await setup();
    expect(initialState).toEqual({ version: 0, currentMapId: null, maps: [] });
    const masterSees = waitFor(masterSocket, 'state.snapshot');
    const playerSees = waitFor(playerSocket, 'state.snapshot');

    const mapId = await addMap(inviteCode, masterKey, 300, 200);

    for (const state of [await masterSees, await playerSees]) {
      expect(state.version).toBe(1);
      expect(state.currentMapId).toBe(mapId);
      expect(state.maps).toHaveLength(1);
      expect(state.maps[0]).toMatchObject({
        id: mapId,
        width: 300,
        height: 200,
        grid: { scale: GRID_SCALE_DEFAULT, offsetX: 0, offsetY: 0, visible: true, snap: true },
      });
    }
  });

  it('serves the original and a downscaled preview', async () => {
    const { inviteCode, masterKey } = await setup();
    await addMap(inviteCode, masterKey, 3000, 1000);
    const state = (await joinState(inviteCode, masterKey)).maps[0]!;

    const original = await server.app.inject({ method: 'GET', url: state.imageUrl });
    expect(original.statusCode).toBe(200);
    expect(original.headers['content-type']).toBe('image/png');
    expect(original.headers['cache-control']).toContain('immutable');
    expect(await sharp(original.rawPayload).metadata()).toMatchObject({
      width: 3000,
      height: 1000,
    });

    const preview = await server.app.inject({ method: 'GET', url: state.previewUrl });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/webp');
    expect(await sharp(preview.rawPayload).metadata()).toMatchObject({ width: 2048, height: 683 });
  });

  it('accepts JPEG and WebP and detects the type from the content, not the header', async () => {
    const { inviteCode, masterKey } = await setup();
    const jpeg = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    const webp = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#fff' } })
      .webp()
      .toBuffer();

    // A WebP file labelled as JPEG is still stored as WebP.
    expect((await uploadMap(server, inviteCode, masterKey, jpeg, 'image/jpeg')).statusCode).toBe(
      201,
    );
    expect((await uploadMap(server, inviteCode, masterKey, webp, 'image/jpeg')).statusCode).toBe(
      201,
    );
    const urls = (await joinState(inviteCode, masterKey)).maps.map((m) => m.imageUrl);
    expect(urls[0]).toMatch(/\.jpg$/);
    expect(urls[1]).toMatch(/\.webp$/);
  });

  it('applies the EXIF orientation to the reported size', async () => {
    const { inviteCode, masterKey } = await setup();
    const rotated = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#fff' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    await uploadMap(server, inviteCode, masterKey, rotated, 'image/jpeg');

    const map = (await joinState(inviteCode, masterKey)).maps[0]!;
    expect([map.width, map.height]).toEqual([100, 200]);
  });

  it('refuses players, strangers and unknown sessions', async () => {
    const { inviteCode, playerKey } = await setup();
    const image = await pngImage();

    expect((await uploadMap(server, inviteCode, playerKey, image)).statusCode).toBe(403);
    expect((await uploadMap(server, inviteCode, undefined, image)).statusCode).toBe(403);
    expect((await uploadMap(server, inviteCode, 'x'.repeat(43), image)).statusCode).toBe(403);
    expect((await uploadMap(server, 'ABCDEFGH', playerKey, image)).statusCode).toBe(404);
    expect(await db.prisma.map.count()).toBe(0);
    expect(await readdir(server.uploadsDir).catch(() => [])).toEqual([]);
  });

  it.each([
    [
      'text labelled as PNG',
      async () => Buffer.from('definitely not an image'),
      'image/png',
      400,
      'invalid_image',
    ],
    ['a GIF labelled as PNG', gifImage, 'image/png', 415, 'unsupported_format'],
    ['an empty body', async () => Buffer.alloc(0), 'image/png', 400, 'empty_body'],
  ])('rejects %s', async (_name, makeBody, contentType, status, error) => {
    const { inviteCode, masterKey } = await setup();

    const res = await uploadMap(server, inviteCode, masterKey, await makeBody(), contentType);

    expect(res.statusCode).toBe(status);
    if (error !== 'empty_body') expect(res.json()).toEqual({ error });
    expect(await db.prisma.map.count()).toBe(0);
  });

  it('rejects declared types other than JPEG, PNG and WebP', async () => {
    const { inviteCode, masterKey } = await setup();
    const res = await uploadMap(server, inviteCode, masterKey, await pngImage(), 'image/svg+xml');
    expect(res.statusCode).toBe(415);
  });

  it('rejects images with a side over the limit', async () => {
    const { inviteCode, masterKey } = await setup();
    const wide = await pngImage(MAX_IMAGE_SIDE + 1, 1);

    const res = await uploadMap(server, inviteCode, masterKey, wide);

    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'image_too_large' });
  });

  it('rejects bodies over the size limit', async () => {
    const { inviteCode, masterKey } = await setup();
    const res = await uploadMap(server, inviteCode, masterKey, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(res.statusCode).toBe(413);
  });

  it(`allows at most ${MAX_MAPS_PER_SESSION} maps per session`, async () => {
    const { inviteCode, masterKey } = await setup();
    const image = await pngImage(8, 8);
    for (let i = 0; i < MAX_MAPS_PER_SESSION; i++) {
      expect((await uploadMap(server, inviteCode, masterKey, image)).statusCode).toBe(201);
    }

    const res = await uploadMap(server, inviteCode, masterKey, image);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'too_many_maps' });
  });
});

describe('GET /api/files/:name', () => {
  it.each(['..%2F..%2Fpackage.json', 'package.json', 'not-a-uuid.png', '..%5C..%5Cwindows.png'])(
    'does not serve %s',
    async (name) => {
      const res = await server.app.inject({ method: 'GET', url: `/api/files/${name}` });
      expect(res.statusCode).toBe(404);
    },
  );

  it('returns 404 for a well-formed name that does not exist', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/files/00000000-0000-4000-8000-000000000000.png',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('grid.update', () => {
  it('saves the grid, tells the others and bumps the version', async () => {
    const { inviteCode, masterKey, masterSocket, playerSocket } = await setup();
    const mapId = await addMap(inviteCode, masterKey);
    await waitFor(masterSocket, 'state.snapshot');
    const playerSees = waitFor(playerSocket, 'grid.changed');

    const result = await emitAck<{ ok: true; version: number; grid: unknown }>(
      masterSocket,
      'grid.update',
      {
        mapId,
        scale: 50,
        offsetX: 12.5,
        visible: false,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      version: 2,
      grid: { scale: 50, offsetX: 12.5, offsetY: 0, visible: false, snap: true },
    });
    expect(await playerSees).toEqual({ version: 2, mapId, grid: result.grid });
    const stored = await db.prisma.map.findUniqueOrThrow({ where: { id: mapId } });
    expect(stored).toMatchObject({ gridScale: 50, gridOffsetX: 12.5, gridVisible: false });
  });

  it('keeps the offset inside one cell', async () => {
    const { inviteCode, masterKey, masterSocket } = await setup();
    const mapId = await addMap(inviteCode, masterKey);

    const result = await emitAck<{ ok: true; grid: { offsetX: number; offsetY: number } }>(
      masterSocket,
      'grid.update',
      { mapId, scale: 40, offsetX: 130, offsetY: -10 },
    );

    expect(result.grid.offsetX).toBe(10);
    expect(result.grid.offsetY).toBe(30);
  });

  it('survives a reconnect: the next join returns the saved grid', async () => {
    const { inviteCode, masterKey, masterSocket } = await setup();
    const mapId = await addMap(inviteCode, masterKey);
    await emitAck(masterSocket, 'grid.update', { mapId, scale: 90, snap: false });
    masterSocket.disconnect();

    const state = await joinState(inviteCode, masterKey);

    expect(state.maps[0]!.grid).toMatchObject({ scale: 90, snap: false });
  });

  it('is refused for players and changes nothing', async () => {
    const { inviteCode, masterKey, playerSocket } = await setup();
    const mapId = await addMap(inviteCode, masterKey);

    const result = await emitAck(playerSocket, 'grid.update', { mapId, scale: 10 });

    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect((await db.prisma.map.findUniqueOrThrow({ where: { id: mapId } })).gridScale).toBe(
      GRID_SCALE_DEFAULT,
    );
  });

  it.each([
    [{ scale: 5 }],
    [{ scale: 501 }],
    [{ scale: 'big' }],
    [{ offsetX: Number.POSITIVE_INFINITY }],
    [{ visible: 'yes' }],
    [{}],
  ])('rejects invalid values %j', async (patch) => {
    const { inviteCode, masterKey, masterSocket } = await setup();
    const mapId = await addMap(inviteCode, masterKey);

    const result = await emitAck<{ ok: boolean; error?: string }>(masterSocket, 'grid.update', {
      mapId,
      ...patch,
    });

    // `{}` is a valid no-op update, everything else must be refused.
    if (Object.keys(patch).length === 0) expect(result.ok).toBe(true);
    else expect(result).toEqual({ ok: false, error: 'invalid_request' });
  });

  it("cannot touch another session's map", async () => {
    const mine = await setup();
    const other = await setup();
    const foreignMapId = await addMap(other.inviteCode, other.masterKey);

    const result = await emitAck(mine.masterSocket, 'grid.update', {
      mapId: foreignMapId,
      scale: 99,
    });

    expect(result).toEqual({ ok: false, error: 'map_not_found' });
    expect((await db.prisma.map.findUniqueOrThrow({ where: { id: foreignMapId } })).gridScale).toBe(
      GRID_SCALE_DEFAULT,
    );
  });

  it('requires joining a session first', async () => {
    const lonely = await server.client();
    expect(await emitAck(lonely, 'grid.update', { mapId: 'x', scale: 50 })).toEqual({
      ok: false,
      error: 'not_joined',
    });
  });
});

describe('map.select and map.delete', () => {
  it('lets the master switch between uploaded maps', async () => {
    const { inviteCode, masterKey, masterSocket, playerSocket } = await setup();
    const first = await addMap(inviteCode, masterKey);
    const second = await addMap(inviteCode, masterKey);
    const playerSees = waitFor(playerSocket, 'state.snapshot', (s) => s.currentMapId === first);

    const result = await emitAck(masterSocket, 'map.select', { mapId: first });

    expect(result).toEqual({ ok: true });
    const state = await playerSees;
    expect(state.maps.map((m) => m.id)).toEqual([first, second]);
    expect(state.version).toBe(3);
  });

  it('is refused for players and for unknown maps', async () => {
    const { inviteCode, masterKey, masterSocket, playerSocket } = await setup();
    const mapId = await addMap(inviteCode, masterKey);

    expect(await emitAck(playerSocket, 'map.select', { mapId })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await emitAck(playerSocket, 'map.delete', { mapId })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await emitAck(masterSocket, 'map.select', { mapId: 'nope' })).toEqual({
      ok: false,
      error: 'map_not_found',
    });
    expect(await emitAck(masterSocket, 'map.select', {})).toEqual({
      ok: false,
      error: 'invalid_request',
    });
    expect(await db.prisma.map.count()).toBe(1);
  });

  it('deletes a map with its files and falls back to the newest remaining one', async () => {
    const { inviteCode, masterKey, masterSocket } = await setup();
    const first = await addMap(inviteCode, masterKey);
    const second = await addMap(inviteCode, masterKey);
    expect(await readdir(server.uploadsDir)).toHaveLength(4);

    const result = await emitAck(masterSocket, 'map.delete', { mapId: second });

    expect(result).toEqual({ ok: true });
    const state = await joinState(inviteCode, masterKey);
    expect(state.maps.map((m) => m.id)).toEqual([first]);
    expect(state.currentMapId).toBe(first);
    expect(await readdir(server.uploadsDir)).toHaveLength(2);
  });

  it('leaves no current map after deleting the last one', async () => {
    const { inviteCode, masterKey, masterSocket } = await setup();
    const only = await addMap(inviteCode, masterKey);

    await emitAck(masterSocket, 'map.delete', { mapId: only });

    expect(await joinState(inviteCode, masterKey)).toMatchObject({ currentMapId: null, maps: [] });
  });
});

describe('state.sync', () => {
  it('returns the current state to a joined client and null to a stranger', async () => {
    const { inviteCode, masterKey, playerSocket } = await setup();
    const mapId = await addMap(inviteCode, masterKey);

    const state = await emitAck<SessionState | null>(playerSocket, 'state.sync');
    expect(state).toMatchObject({ version: 1, currentMapId: mapId });

    const stranger = await server.client();
    expect(await emitAck(stranger, 'state.sync')).toBeNull();
  });
});

/** The state as a freshly (re)joined master sees it. */
async function joinState(inviteCode: string, masterKey: string): Promise<SessionState> {
  const socket = await server.client();
  return (await joinOk(socket, { inviteCode, key: masterKey })).state;
}
