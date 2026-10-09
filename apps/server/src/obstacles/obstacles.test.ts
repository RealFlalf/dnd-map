import {
  MAX_OBSTACLES_PER_MAP,
  type ObstacleView,
  type ObstaclesPatch,
  type SessionState,
  type TokenView,
} from '@dnd-map/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  createTestDb,
  emitAck,
  joinOk,
  pngImage,
  recordTraffic,
  resetDb,
  startServer,
  uploadMap,
  waitFor,
  type TestServer,
  type TestSocket,
} from '../../test/helpers';

const db = createTestDb();
let server: TestServer;

beforeEach(async () => {
  await resetDb(db);
  server = await startServer(db);
});
afterEach(() => server.close());
afterAll(() => db.close());

type Failed = { ok: false; error: string };
type Added = { ok: true; version: number; obstacle: ObstacleView };
type Moved = { ok: true; version: number; token: TokenView };

/** A session with a 700x350 map (70 px grid, 10 x 5 cells), the master and two players. */
async function setup() {
  const { inviteCode, participantKey: masterKey } = await createSession(server);
  const masterSocket = await server.client();
  const master = await joinOk(masterSocket, { inviteCode, key: masterKey });
  const join = async (displayName: string) => {
    const socket = await server.client();
    const res = await joinOk(socket, { inviteCode, displayName });
    return { id: res.self.id, key: res.participantKey!, socket };
  };
  const alice = await join('Алиса');
  const bob = await join('Боб');
  const upload = await uploadMap(server, inviteCode, masterKey, await pngImage(700, 350));
  const mapId = (upload.json() as { mapId: string }).mapId;
  await Promise.all(
    [masterSocket, alice.socket, bob.socket].map((s) =>
      waitFor(s, 'state.snapshot', (st) => st.currentMapId === mapId),
    ),
  );
  return {
    inviteCode,
    masterKey,
    master: { id: master.self.id, socket: masterSocket },
    alice,
    bob,
    mapId,
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

type Point = { x: number; y: number };
const cellPoint = (col: number, row: number): Point => ({
  x: (col - 0.5) * 70,
  y: (row - 0.5) * 70,
});

/** Builds a wall over the cells from (col1,row1) to (col2,row2), 1-based. */
const wall = (ctx: Ctx, from: [number, number], to: [number, number], kind = 'wall', extra = {}) =>
  emitAck<Added | Failed>(ctx.master.socket, 'obstacle.add', {
    mapId: ctx.mapId,
    kind,
    from: cellPoint(...from),
    to: cellPoint(...to),
    ...extra,
  });

const wallOk = async (...args: Parameters<typeof wall>) => {
  const res = await wall(...args);
  if (!res.ok) throw new Error(`obstacle.add failed: ${res.error}`);
  return res.obstacle;
};

const place = async (ctx: Ctx, who: 'alice' | 'bob', col: number, row: number) => {
  const res = await emitAck<Moved | Failed>(ctx[who].socket, 'character.place', {
    mapId: ctx.mapId,
    ...cellPoint(col, row),
  });
  if (!res.ok) throw new Error(`place failed: ${res.error}`);
  return res.token;
};

const move = (socket: TestSocket, tokenId: string, col: number, row: number) =>
  emitAck<Moved | Failed>(socket, 'token.move', { tokenId, ...cellPoint(col, row) });

const stored = (id: string) => db.prisma.token.findUniqueOrThrow({ where: { id } });

describe('obstacle.add', () => {
  it('snaps the request to whole cells, tells everyone and keeps it in the state', async () => {
    const ctx = await setup();
    const aliceSees = waitFor(ctx.alice.socket, 'obstacles.changed');

    const res = await emitAck<Added>(ctx.master.socket, 'obstacle.add', {
      mapId: ctx.mapId,
      kind: 'wall',
      from: { x: 150, y: 80 }, // somewhere in cell (3, 2)
      to: { x: 330, y: 90 }, // somewhere in cell (5, 2)
    });

    expect(res.obstacle).toMatchObject({
      kind: 'wall',
      x: 140,
      y: 70,
      width: 210,
      height: 70,
      blocksMovement: true,
      blocksSight: true,
    });
    const patch: ObstaclesPatch = await aliceSees;
    expect(patch).toEqual({ version: res.version, upserted: [res.obstacle], removedIds: [] });
    const joined = await joinOk(await server.client(), {
      inviteCode: ctx.inviteCode,
      key: ctx.alice.key,
    });
    expect(joined.state.obstacles).toEqual([res.obstacle]);
  });

  it('makes pillars and barrels one cell, and lets a barrel be seen over', async () => {
    const ctx = await setup();
    const pillar = await wallOk(ctx, [3, 3], [8, 4], 'pillar'); // the second corner is ignored
    const barrel = await wallOk(ctx, [5, 1], [5, 1], 'barrel');

    expect([pillar.width, pillar.height, pillar.blocksSight]).toEqual([70, 70, true]);
    expect([barrel.width, barrel.height, barrel.blocksSight, barrel.blocksMovement]).toEqual([
      70,
      70,
      false,
      true,
    ]);
  });

  it('takes the sight flag from the request when given', async () => {
    const ctx = await setup();
    expect((await wallOk(ctx, [1, 1], [1, 1], 'wall', { blocksSight: false })).blocksSight).toBe(
      false,
    );
  });

  it('cuts the rectangle to the map and refuses one that is not on it', async () => {
    const ctx = await setup();
    const edge = await emitAck<Added>(ctx.master.socket, 'obstacle.add', {
      mapId: ctx.mapId,
      kind: 'wall',
      from: { x: 600, y: 300 },
      to: { x: 5000, y: 5000 },
    });
    expect(edge.obstacle).toMatchObject({ x: 560, y: 280, width: 140, height: 70 });

    const outside = await emitAck(ctx.master.socket, 'obstacle.add', {
      mapId: ctx.mapId,
      kind: 'wall',
      from: { x: 900, y: 100 },
      to: { x: 950, y: 100 },
    });
    expect(outside).toEqual({ ok: false, error: 'invalid_request' });
  });

  it('is refused for players and strangers, and nothing is stored', async () => {
    const ctx = await setup();
    const request = { mapId: ctx.mapId, kind: 'wall', from: cellPoint(1, 1), to: cellPoint(2, 1) };
    expect(await emitAck(ctx.alice.socket, 'obstacle.add', request)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await emitAck(await server.client(), 'obstacle.add', request)).toEqual({
      ok: false,
      error: 'not_joined',
    });
    expect(await db.prisma.obstacle.count()).toBe(0);
  });

  it.each([
    [{ kind: 'door' }],
    [{ from: { x: 'a', y: 1 } }],
    [{ to: undefined }],
    [{ mapId: '' }],
    [{ blocksSight: 'sure' }],
  ])('rejects the invalid request %j', async (patch) => {
    const ctx = await setup();
    const res = await emitAck(ctx.master.socket, 'obstacle.add', {
      mapId: ctx.mapId,
      kind: 'wall',
      from: cellPoint(1, 1),
      to: cellPoint(2, 1),
      ...patch,
    });
    expect(res).toEqual({ ok: false, error: 'invalid_request' });
  });

  it('only works on the current map', async () => {
    const ctx = await setup();
    await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(200, 200));
    expect(await wall(ctx, [1, 1], [2, 1])).toEqual({ ok: false, error: 'map_not_found' });
  });

  it(`stops at ${MAX_OBSTACLES_PER_MAP} obstacles per map`, async () => {
    const ctx = await setup();
    await db.prisma.obstacle.createMany({
      data: Array.from({ length: MAX_OBSTACLES_PER_MAP }, () => ({
        mapId: ctx.mapId,
        kind: 'pillar' as const,
        x: 0,
        y: 0,
        width: 70,
        height: 70,
        blocksSight: true,
      })),
    });
    expect(await wall(ctx, [1, 1], [1, 1])).toEqual({ ok: false, error: 'too_many_obstacles' });
  });
});

describe('removing and changing obstacles', () => {
  it('removes one, tells everyone and bumps the version', async () => {
    const ctx = await setup();
    const o = await wallOk(ctx, [2, 2], [4, 2]);
    const seen = waitFor(ctx.bob.socket, 'obstacles.changed', (p) => p.removedIds.length > 0);

    const res = await emitAck<{ ok: true; version: number }>(ctx.master.socket, 'obstacle.remove', {
      obstacleId: o.id,
    });

    expect((await seen).removedIds).toEqual([o.id]);
    expect(res.version).toBe((await db.prisma.session.findFirstOrThrow()).version);
    expect(await db.prisma.obstacle.count()).toBe(0);
  });

  it('toggles whether an obstacle blocks the line of sight', async () => {
    const ctx = await setup();
    const o = await wallOk(ctx, [2, 2], [2, 2]);
    const seen = waitFor(ctx.alice.socket, 'obstacles.changed');

    const res = await emitAck<Added>(ctx.master.socket, 'obstacle.setSight', {
      obstacleId: o.id,
      blocksSight: false,
    });

    expect(res.obstacle.blocksSight).toBe(false);
    expect((await seen).upserted[0]).toMatchObject({ id: o.id, blocksSight: false });
    expect((await db.prisma.obstacle.findUniqueOrThrow({ where: { id: o.id } })).blocksSight).toBe(
      false,
    );
  });

  it('clears the whole map in one step, and does nothing when it is already empty', async () => {
    const ctx = await setup();
    const a = await wallOk(ctx, [1, 1], [3, 1]);
    const b = await wallOk(ctx, [1, 3], [3, 3]);
    const seen = waitFor(ctx.alice.socket, 'obstacles.changed', (p) => p.removedIds.length > 0);

    await emitAck(ctx.master.socket, 'obstacle.clear', { mapId: ctx.mapId });

    expect((await seen).removedIds.sort()).toEqual([a.id, b.id].sort());
    expect(await db.prisma.obstacle.count()).toBe(0);
    const before = (await db.prisma.session.findFirstOrThrow()).version;
    expect(await emitAck(ctx.master.socket, 'obstacle.clear', { mapId: ctx.mapId })).toMatchObject({
      ok: true,
      version: before,
    });
    expect((await db.prisma.session.findFirstOrThrow()).version).toBe(before);
  });

  it('is all refused for players, whatever they ask', async () => {
    const ctx = await setup();
    const o = await wallOk(ctx, [2, 2], [2, 2]);
    const forbidden = { ok: false, error: 'forbidden' };
    expect(await emitAck(ctx.alice.socket, 'obstacle.remove', { obstacleId: o.id })).toEqual(
      forbidden,
    );
    expect(
      await emitAck(ctx.alice.socket, 'obstacle.setSight', {
        obstacleId: o.id,
        blocksSight: false,
      }),
    ).toEqual(forbidden);
    expect(await emitAck(ctx.alice.socket, 'obstacle.clear', { mapId: ctx.mapId })).toEqual(
      forbidden,
    );
    expect(await db.prisma.obstacle.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      blocksSight: true,
    });
  });

  it("cannot reach another session's obstacle, or one that does not exist", async () => {
    const mine = await setup();
    const other = await setup();
    const foreign = await wallOk(other, [1, 1], [2, 1]);
    const missing = { ok: false, error: 'obstacle_not_found' };
    expect(
      await emitAck(mine.master.socket, 'obstacle.remove', { obstacleId: foreign.id }),
    ).toEqual(missing);
    expect(
      await emitAck(mine.master.socket, 'obstacle.setSight', {
        obstacleId: foreign.id,
        blocksSight: false,
      }),
    ).toEqual(missing);
    expect(await emitAck(mine.master.socket, 'obstacle.remove', { obstacleId: 'nope' })).toEqual(
      missing,
    );
    expect(await db.prisma.obstacle.count()).toBe(1);
  });

  it('writes who did what to the audit log', async () => {
    const ctx = await setup();
    const o = await wallOk(ctx, [1, 1], [2, 1]);
    await emitAck(ctx.master.socket, 'obstacle.setSight', { obstacleId: o.id, blocksSight: false });
    await emitAck(ctx.master.socket, 'obstacle.remove', { obstacleId: o.id });
    await emitAck(ctx.alice.socket, 'obstacle.add', {
      mapId: ctx.mapId,
      kind: 'wall',
      from: cellPoint(1, 1),
      to: cellPoint(1, 1),
    });

    const log = await db.prisma.eventLog.findMany({
      where: { type: { startsWith: 'obstacle.' } },
      orderBy: { id: 'asc' },
    });

    expect(log.map((e) => [e.type, e.participantId])).toEqual([
      ['obstacle.add', ctx.master.id],
      ['obstacle.sight', ctx.master.id],
      ['obstacle.remove', ctx.master.id],
    ]);
  });
});

describe('obstacles and maps', () => {
  it('belong to their map: a new map starts without them, the old one gets them back, deleting the map deletes them', async () => {
    const ctx = await setup();
    const o = await wallOk(ctx, [2, 2], [4, 2]);
    const state = async (key: string): Promise<SessionState> =>
      (await joinOk(await server.client(), { inviteCode: ctx.inviteCode, key })).state;

    await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(200, 200));
    expect((await state(ctx.masterKey)).obstacles).toEqual([]);

    await emitAck(ctx.master.socket, 'map.select', { mapId: ctx.mapId });
    expect((await state(ctx.alice.key)).obstacles.map((x) => x.id)).toEqual([o.id]);

    await emitAck(ctx.master.socket, 'map.delete', { mapId: ctx.mapId });
    expect(await db.prisma.obstacle.count()).toBe(0);
  });

  it('come with state.sync and with the snapshot sent when the map changes', async () => {
    const ctx = await setup();
    const o = await wallOk(ctx, [1, 1], [1, 1]);
    expect(
      (await emitAck<SessionState>(ctx.bob.socket, 'state.sync')).obstacles.map((x) => x.id),
    ).toEqual([o.id]);

    await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(200, 200));
    const back = waitFor(ctx.bob.socket, 'state.snapshot', (s) => s.currentMapId === ctx.mapId);
    await emitAck(ctx.master.socket, 'map.select', { mapId: ctx.mapId });
    expect((await back).obstacles.map((x) => x.id)).toEqual([o.id]);
  });
});

describe('movement and obstacles', () => {
  it('stops a player from ending a move inside an obstacle', async () => {
    const ctx = await setup();
    const token = await place(ctx, 'alice', 1, 3);
    await wallOk(ctx, [5, 3], [5, 3], 'pillar');

    expect(await move(ctx.alice.socket, token.id, 5, 3)).toEqual({ ok: false, error: 'blocked' });
    const t = await stored(token.id);
    expect([t.x, t.y]).toEqual([35, 175]);
  });

  it('stops a player from crossing a wall in one move, and lets them walk around it in steps', async () => {
    const ctx = await setup();
    const token = await place(ctx, 'alice', 2, 3);
    await wallOk(ctx, [5, 1], [5, 4]); // a wall in column 5, rows 1-4; row 5 is open

    expect(await move(ctx.alice.socket, token.id, 8, 3)).toEqual({ ok: false, error: 'blocked' });
    expect(await move(ctx.alice.socket, token.id, 4, 5)).toMatchObject({ ok: true });
    expect(await move(ctx.alice.socket, token.id, 6, 5)).toMatchObject({ ok: true }); // along the open row
    expect(await move(ctx.alice.socket, token.id, 8, 3)).toMatchObject({ ok: true });
  });

  it('counts the destination after snapping to the grid', async () => {
    const ctx = await setup();
    const token = await place(ctx, 'alice', 2, 3);
    await wallOk(ctx, [5, 3], [5, 3]);
    // a free-hand point near the wall that snaps into its cell
    const res = await emitAck(ctx.alice.socket, 'token.move', {
      tokenId: token.id,
      x: 330,
      y: 200,
    });
    expect(res).toEqual({ ok: false, error: 'blocked' });
  });

  it('does not stop the master, who can move anything anywhere', async () => {
    const ctx = await setup();
    const token = await place(ctx, 'alice', 2, 3);
    await wallOk(ctx, [5, 1], [5, 5]);
    expect(await move(ctx.master.socket, token.id, 8, 3)).toMatchObject({ ok: true });
    expect(await move(ctx.master.socket, token.id, 5, 3)).toMatchObject({ ok: true }); // even into the wall
  });

  it('lets a token leave an obstacle that was built around it, but not move deeper in', async () => {
    const ctx = await setup();
    const token = await place(ctx, 'alice', 5, 3);
    await wallOk(ctx, [4, 3], [6, 3]); // built over her
    expect(await move(ctx.alice.socket, token.id, 5, 3)).toEqual({ ok: false, error: 'blocked' });
    expect(await move(ctx.alice.socket, token.id, 5, 5)).toMatchObject({ ok: true });
  });

  it('ignores obstacles that do not block movement', async () => {
    const ctx = await setup();
    const token = await place(ctx, 'alice', 2, 3);
    const o = await wallOk(ctx, [5, 1], [5, 5]);
    await db.prisma.obstacle.update({ where: { id: o.id }, data: { blocksMovement: false } });
    expect(await move(ctx.alice.socket, token.id, 8, 3)).toMatchObject({ ok: true });
  });

  it('keeps a barrel in the way even though it does not hide what is behind it', async () => {
    const ctx = await setup();
    const token = await place(ctx, 'alice', 2, 3);
    await wallOk(ctx, [5, 3], [5, 3], 'barrel');
    expect(await move(ctx.alice.socket, token.id, 8, 3)).toEqual({ ok: false, error: 'blocked' });
    // a diagonal that clips the barrel's corner is blocked too; going round it is not
    expect(await move(ctx.alice.socket, token.id, 8, 5)).toEqual({ ok: false, error: 'blocked' });
    expect(await move(ctx.alice.socket, token.id, 4, 5)).toMatchObject({ ok: true });
    expect(await move(ctx.alice.socket, token.id, 8, 5)).toMatchObject({ ok: true });
  });

  it('refuses a player to place their character on an obstacle, but not the master', async () => {
    const ctx = await setup();
    await wallOk(ctx, [3, 3], [3, 3], 'pillar');
    const refused = await emitAck(ctx.alice.socket, 'character.place', {
      mapId: ctx.mapId,
      ...cellPoint(3, 3),
    });
    expect(refused).toEqual({ ok: false, error: 'blocked' });
    expect(await db.prisma.token.count()).toBe(0);

    const byMaster = await emitAck<Moved>(ctx.master.socket, 'character.place', {
      mapId: ctx.mapId,
      participantId: ctx.alice.id,
      ...cellPoint(3, 3),
    });
    expect(byMaster.ok).toBe(true);
  });

  it('lets the master put monsters on obstacles', async () => {
    const ctx = await setup();
    await wallOk(ctx, [3, 3], [3, 3]);
    const res = await emitAck<Moved>(ctx.master.socket, 'token.create', {
      mapId: ctx.mapId,
      icon: 'wolf',
      ...cellPoint(3, 3),
    });
    expect(res.ok).toBe(true);
  });

  it('is told about a refused move so that the client can put the token back', async () => {
    const ctx = await setup();
    const token = await place(ctx, 'alice', 2, 3);
    await wallOk(ctx, [5, 1], [5, 5]);
    const bobTraffic = recordTraffic(ctx.bob.socket);
    const mark = bobTraffic.mark();

    await move(ctx.alice.socket, token.id, 8, 3);
    await new Promise((r) => setTimeout(r, 200));

    expect(bobTraffic.since(mark)).not.toContain('tokens.changed'); // nothing changed for anyone else
  });
});

describe('obstacles in the permission matrix', () => {
  it('belong to the master alone', async () => {
    const ctx = await setup();
    const o = await wallOk(ctx, [1, 1], [1, 1]);
    for (const who of [ctx.alice, ctx.bob]) {
      for (const [event, payload] of [
        [
          'obstacle.add',
          { mapId: ctx.mapId, kind: 'wall', from: cellPoint(2, 2), to: cellPoint(2, 2) },
        ],
        ['obstacle.remove', { obstacleId: o.id }],
        ['obstacle.setSight', { obstacleId: o.id, blocksSight: false }],
        ['obstacle.clear', { mapId: ctx.mapId }],
      ] as const) {
        expect(await emitAck(who.socket, event, payload), `${event} by a player`).toEqual({
          ok: false,
          error: 'forbidden',
        });
      }
    }
    expect(await db.prisma.obstacle.count()).toBe(1);
  });
});
