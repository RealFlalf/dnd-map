import type { GridChanged, ObstacleView, SessionState } from '@dnd-map/shared';
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
  waitFor,
  type TestServer,
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
type Updated = {
  ok: true;
  version: number;
  obstacles?: { upserted: ObstacleView[]; removedIds: string[] };
  fog?: { polygons: unknown[] };
};

/** A 700x350 map (70 px grid, 10 x 5 cells), the master and one player. */
async function setup() {
  const { inviteCode, participantKey: masterKey } = await createSession(server);
  const masterSocket = await server.client();
  await joinOk(masterSocket, { inviteCode, key: masterKey });
  const playerSocket = await server.client();
  const player = await joinOk(playerSocket, { inviteCode, displayName: 'Алиса' });
  const upload = await uploadMap(server, inviteCode, masterKey, await pngImage(700, 350));
  const mapId = (upload.json() as { mapId: string }).mapId;
  await Promise.all(
    [masterSocket, playerSocket].map((s) =>
      waitFor(s, 'state.snapshot', (st) => st.currentMapId === mapId),
    ),
  );
  return {
    inviteCode,
    masterKey,
    playerKey: player.participantKey!,
    masterSocket,
    playerSocket,
    mapId,
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const cell = (col: number, row: number) => ({ x: (col - 0.5) * 70, y: (row - 0.5) * 70 });
const wall = async (ctx: Ctx, from: [number, number], to: [number, number], kind = 'wall') => {
  const res = await emitAck<Added | Failed>(ctx.masterSocket, 'obstacle.add', {
    mapId: ctx.mapId,
    kind,
    from: cell(...from),
    to: cell(...to),
  });
  if (!res.ok) throw new Error(res.error);
  return res.obstacle;
};
const stored = (id: string) => db.prisma.obstacle.findUniqueOrThrow({ where: { id } });
const stateFor = async (ctx: Ctx, key: string): Promise<SessionState> =>
  (await joinOk(await server.client(), { inviteCode: ctx.inviteCode, key })).state;
const gridUpdate = (ctx: Ctx, change: Record<string, unknown>) =>
  emitAck<Updated>(ctx.masterSocket, 'grid.update', { mapId: ctx.mapId, ...change });
const move = (ctx: Ctx, obstacleId: string, dCol: number, dRow: number) =>
  emitAck<Added>(ctx.masterSocket, 'obstacle.move', { obstacleId, dCol, dRow });

describe('obstacles follow the grid', () => {
  it('grow with the cells, keep their cells, and everybody is told', async () => {
    const ctx = await setup();
    const w = await wall(ctx, [2, 2], [4, 2]); // x 70..280, y 70..140
    const playerHears = waitFor(ctx.playerSocket, 'grid.changed');

    const res = await gridUpdate(ctx, { scale: 100 });

    expect(res.ok).toBe(true);
    const expected = { x: 100, y: 100, width: 300, height: 100 };
    expect(res.obstacles?.upserted).toEqual([expect.objectContaining({ id: w.id, ...expected })]);
    expect(await stored(w.id)).toMatchObject(expected);
    const change: GridChanged = await playerHears;
    expect(change.obstacles?.upserted[0]).toMatchObject(expected);
    expect((await stateFor(ctx, ctx.playerKey)).obstacles[0]).toMatchObject(expected);
  });

  it('are dropped when they end up outside the map, and cut at its edge', async () => {
    const ctx = await setup();
    const edge = await wall(ctx, [10, 1], [10, 1]); // the last column, x 630..700
    const inside = await wall(ctx, [1, 1], [1, 1]);

    const res = await gridUpdate(ctx, { scale: 140 });

    // 140 px cells: the last column starts at 9 * 140 = 1260, far outside the 700 px map
    expect(res.obstacles?.removedIds).toEqual([edge.id]);
    expect(await db.prisma.obstacle.findUnique({ where: { id: edge.id } })).toBeNull();
    expect(await stored(inside.id)).toMatchObject({ x: 0, y: 0, width: 140, height: 140 });
  });

  it('are left alone when only visibility or snapping changes', async () => {
    const ctx = await setup();
    await wall(ctx, [2, 2], [3, 2]);
    const res = await gridUpdate(ctx, { visible: false });
    expect(res.ok).toBe(true);
    expect(res.obstacles).toBeUndefined();
  });

  it('with fog on: the master gets the new area, players a whole new view', async () => {
    const ctx = await setup();
    await emitAck(ctx.playerSocket, 'character.place', { mapId: ctx.mapId, ...cell(3, 3) });
    await emitAck(ctx.masterSocket, 'fog.update', { mapId: ctx.mapId, enabled: true, radius: 2 });
    const before = (await stateFor(ctx, ctx.masterKey)).fog.polygons;
    const playerHears = waitFor(
      ctx.playerSocket,
      'state.snapshot',
      (s) => s.maps[0]!.grid.scale === 100,
    );

    const res = await gridUpdate(ctx, { scale: 100 });

    expect(res.fog?.polygons).not.toEqual(before);
    expect(res.fog?.polygons.length).toBe(1);
    expect((await playerHears).fog.polygons).toEqual(res.fog?.polygons);
  });
});

describe('obstacle.move', () => {
  it('moves by whole cells, tells everyone, stores it and logs it', async () => {
    const ctx = await setup();
    const w = await wall(ctx, [2, 2], [3, 2]);
    const heard = waitFor(ctx.playerSocket, 'obstacles.changed');

    const res = await move(ctx, w.id, 2, 1);

    expect(res).toMatchObject({
      ok: true,
      obstacle: { id: w.id, x: 210, y: 140, width: 140, height: 70 },
    });
    expect((await heard).upserted[0]).toMatchObject({ id: w.id, x: 210, y: 140 });
    expect(await stored(w.id)).toMatchObject({ x: 210, y: 140 });
    expect(await db.prisma.eventLog.count({ where: { type: 'obstacle.move' } })).toBe(1);
  });

  it('is held back at the edge of the map, and moving nowhere changes nothing', async () => {
    const ctx = await setup();
    const w = await wall(ctx, [9, 4], [10, 5]); // the bottom-right corner, 140 x 140
    const res = await move(ctx, w.id, 5, 5);
    expect(res.obstacle).toMatchObject({ x: 560, y: 210 }); // already against both edges
    expect(res.version).toBe((await db.prisma.session.findFirstOrThrow()).version);

    const back = await move(ctx, w.id, -50, 0);
    expect(back.obstacle).toMatchObject({ x: 0, y: 210 });
    expect(back.version).toBe(res.version + 1);
    const still = await move(ctx, w.id, 0, 0);
    expect(still.version).toBe(back.version); // no change, no new version
  });

  it('is refused for players and for nonsense, and only works on the current map', async () => {
    const ctx = await setup();
    const w = await wall(ctx, [2, 2], [2, 2]);
    expect(
      await emitAck(ctx.playerSocket, 'obstacle.move', { obstacleId: w.id, dCol: 1, dRow: 0 }),
    ).toEqual({ ok: false, error: 'forbidden' });
    for (const bad of [
      { dCol: 1.5, dRow: 0 },
      { dCol: 'a', dRow: 0 },
      { dCol: 5000, dRow: 0 },
      { dRow: 1 },
    ]) {
      expect(
        await emitAck(ctx.masterSocket, 'obstacle.move', { obstacleId: w.id, ...bad }),
      ).toEqual({ ok: false, error: 'invalid_request' });
    }
    expect(
      await emitAck(ctx.masterSocket, 'obstacle.move', { obstacleId: 'nope', dCol: 1, dRow: 0 }),
    ).toEqual({
      ok: false,
      error: 'obstacle_not_found',
    });
    expect(await stored(w.id)).toMatchObject({ x: 70, y: 70 });

    await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(700, 350)); // the first map is not current any more
    expect(
      await emitAck(ctx.masterSocket, 'obstacle.move', { obstacleId: w.id, dCol: 1, dRow: 0 }),
    ).toEqual({
      ok: false,
      error: 'obstacle_not_found',
    });
  });
});
