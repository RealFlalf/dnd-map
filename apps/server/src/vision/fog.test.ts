import {
  inAnyPolygon,
  type FogState,
  type ObstacleView,
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

type Moved = { ok: true; version: number; token: TokenView };
type Failed = { ok: false; error: string };

type Point = { x: number; y: number };
const cell = (col: number, row: number): Point => ({ x: (col - 0.5) * 70, y: (row - 0.5) * 70 });

/** A 20 x 10 cell map (70 px), the master, and two players, Алиса and Боб. Fog is off to begin with. */
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
  const upload = await uploadMap(server, inviteCode, masterKey, await pngImage(1400, 700));
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

const fogOn = (ctx: Ctx, radius = 3) =>
  emitAck<{ ok: boolean; error?: string }>(ctx.master.socket, 'fog.update', {
    mapId: ctx.mapId,
    enabled: true,
    radius,
  });

const place = async (ctx: Ctx, who: 'alice' | 'bob', col: number, row: number) => {
  const res = await emitAck<Moved | Failed>(ctx[who].socket, 'character.place', {
    mapId: ctx.mapId,
    ...cell(col, row),
  });
  if (!res.ok) throw new Error(`place failed: ${res.error}`);
  return res.token;
};

const monster = async (ctx: Ctx, col: number, row: number, extra: Record<string, unknown> = {}) => {
  const res = await emitAck<Moved | Failed>(ctx.master.socket, 'token.create', {
    mapId: ctx.mapId,
    icon: 'dragon',
    ...cell(col, row),
    ...extra,
  });
  if (!res.ok) throw new Error(`monster failed: ${res.error}`);
  return res.token;
};

const wall = async (ctx: Ctx, from: [number, number], to: [number, number], kind = 'wall') => {
  const res = await emitAck<{ ok: true; obstacle: ObstacleView } | Failed>(
    ctx.master.socket,
    'obstacle.add',
    {
      mapId: ctx.mapId,
      kind,
      from: cell(...from),
      to: cell(...to),
    },
  );
  if (!res.ok) throw new Error(`wall failed: ${res.error}`);
  return res.obstacle;
};

const stateOf = async (ctx: Ctx, key: string): Promise<SessionState> =>
  (await joinOk(await server.client(), { inviteCode: ctx.inviteCode, key })).state;
const playerState = (ctx: Ctx) => stateOf(ctx, ctx.alice.key);
const move = (socket: TestSocket, tokenId: string, col: number, row: number) =>
  emitAck<Moved | Failed>(socket, 'token.move', { tokenId, ...cell(col, row) });
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe('fog.update', () => {
  it('stores the settings of the current map and gives everyone a fresh snapshot', async () => {
    const ctx = await setup();
    const masterSees = waitFor(ctx.master.socket, 'state.snapshot', (s) => s.fog.enabled);
    const playerSees = waitFor(ctx.alice.socket, 'state.snapshot', (s) => s.fog.enabled);

    const res = await fogOn(ctx, 4.5);

    expect(res.ok).toBe(true);
    for (const state of [await masterSees, await playerSees]) {
      expect(state.fog).toMatchObject({ enabled: true, radius: 4.5 });
    }
    const map = await db.prisma.map.findUniqueOrThrow({ where: { id: ctx.mapId } });
    expect([map.fogEnabled, map.fogRadius]).toEqual([true, 4.5]);
    expect((await stateOf(ctx, ctx.bob.key)).fog).toMatchObject({ enabled: true, radius: 4.5 });
  });

  it('can change the radius alone and switch the fog off again', async () => {
    const ctx = await setup();
    await fogOn(ctx, 3);
    await emitAck(ctx.master.socket, 'fog.update', { mapId: ctx.mapId, radius: 8 });
    expect((await playerState(ctx)).fog).toMatchObject({ enabled: true, radius: 8 });
    await emitAck(ctx.master.socket, 'fog.update', { mapId: ctx.mapId, enabled: false });
    expect((await playerState(ctx)).fog).toEqual({ enabled: false, radius: 8, polygons: [] });
  });

  it('is refused for players, and for requests that make no sense', async () => {
    const ctx = await setup();
    expect(
      await emitAck(ctx.alice.socket, 'fog.update', { mapId: ctx.mapId, enabled: true }),
    ).toEqual({ ok: false, error: 'forbidden' });
    for (const bad of [
      { radius: 0 },
      { radius: 99 },
      { radius: 'far' },
      { enabled: 'yes' },
      { mapId: '' },
    ]) {
      expect(await emitAck(ctx.master.socket, 'fog.update', { mapId: ctx.mapId, ...bad })).toEqual({
        ok: false,
        error: 'invalid_request',
      });
    }
    expect((await db.prisma.map.findUniqueOrThrow({ where: { id: ctx.mapId } })).fogEnabled).toBe(
      false,
    );
  });

  it('only works on the current map, and every map keeps its own fog', async () => {
    const ctx = await setup();
    await fogOn(ctx, 3);
    await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(700, 350));
    expect((await stateOf(ctx, ctx.masterKey)).fog.enabled).toBe(false); // the new map starts without fog
    expect(
      await emitAck(ctx.master.socket, 'fog.update', { mapId: ctx.mapId, enabled: false }),
    ).toEqual({ ok: false, error: 'map_not_found' });
    await emitAck(ctx.master.socket, 'map.select', { mapId: ctx.mapId });
    expect((await stateOf(ctx, ctx.masterKey)).fog.enabled).toBe(true); // and the old one still has it
  });

  it('is written to the audit log', async () => {
    const ctx = await setup();
    await fogOn(ctx, 5);
    const log = await db.prisma.eventLog.findMany({ where: { type: 'fog.update' } });
    expect(log.map((e) => [e.participantId, e.payload])).toEqual([
      [ctx.master.id, { enabled: true, radius: 5 }],
    ]);
  });
});

describe('what players are sent, with fog on', () => {
  it('limits the state to what the characters can see, and keeps the master informed of everything', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 3, 5);
    const near = await monster(ctx, 5, 5); // 2 cells away
    const far = await monster(ctx, 15, 5); // 12 cells away
    const wallInSight = await wall(ctx, [4, 2], [4, 2]);
    const wallFarAway = await wall(ctx, [16, 8], [18, 8]);
    await fogOn(ctx, 3);

    const player = await playerState(ctx);
    expect(player.tokens.map((t) => t.id).sort()).toEqual(
      [
        near.id,
        (await db.prisma.token.findFirstOrThrow({ where: { type: 'player_character' } })).id,
      ].sort(),
    );
    expect(player.obstacles.map((o) => o.id).sort()).toEqual(
      [wallInSight.id, wallFarAway.id].sort(),
    ); // walls are always shown

    const master = await stateOf(ctx, ctx.masterKey);
    expect(master.tokens.map((t) => t.id)).toContain(far.id);
    expect(master.obstacles.map((o) => o.id).sort()).toEqual(
      [wallInSight.id, wallFarAway.id].sort(),
    );
  });

  it('never lets a monster out of sight into any message a player receives', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 3, 5);
    await fogOn(ctx, 3);
    const traffic = recordTraffic(ctx.alice.socket);
    const mark = traffic.mark();

    const far = await monster(ctx, 15, 5, { icon: 'dragon' });
    const hiddenNear = await monster(ctx, 4, 5, { icon: 'wolf', visible: false });
    const farWall = await wall(ctx, [16, 8], [18, 8]);
    await move(ctx.master.socket, far.id, 16, 5);
    ctx.master.socket.emit('token.drag', { tokenId: far.id, ...cell(14, 5) });
    await emitAck(ctx.master.socket, 'obstacle.setSight', {
      obstacleId: farWall.id,
      blocksSight: false,
    });
    await settle();

    const raw = traffic.since(mark);
    for (const secret of [far.id, hiddenNear.id, 'Дракон', 'builtin:dragon', 'builtin:wolf']) {
      expect(raw, secret).not.toContain(secret);
    }
    expect(raw).toContain('state.snapshot'); // the view did reach her
    // join and sync give the same picture
    const fresh = JSON.stringify(await playerState(ctx));
    for (const secret of [far.id, hiddenNear.id]) expect(fresh).not.toContain(secret);
    expect(
      JSON.stringify(await emitAck<SessionState>(ctx.alice.socket, 'state.sync')),
    ).not.toContain(far.id);
  });

  it('shows a monster when it comes into view and hides it again when it leaves', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 3, 5);
    const dragon = await monster(ctx, 12, 5);
    await fogOn(ctx, 3);
    const traffic = recordTraffic(ctx.alice.socket);

    const arrives = waitFor(ctx.alice.socket, 'tokens.changed', (p) => p.upserted.length > 0);
    await move(ctx.master.socket, dragon.id, 5, 5);
    expect((await arrives).upserted[0]).toMatchObject({ id: dragon.id, ...cell(5, 5) });

    const leaves = waitFor(ctx.alice.socket, 'tokens.changed', (p) => p.removedIds.length > 0);
    await move(ctx.master.socket, dragon.id, 12, 5);
    expect((await leaves).removedIds).toEqual([dragon.id]);

    const mark = traffic.mark();
    await move(ctx.master.socket, dragon.id, 13, 5); // out of sight to out of sight
    await settle();
    expect(traffic.since(mark)).not.toContain(dragon.id);
    expect(traffic.since(mark)).toContain('"upserted":[]'); // only the version moves on
  });

  it('hides what is behind a wall until the player walks round it', async () => {
    const ctx = await setup();
    const alice = await place(ctx, 'alice', 3, 5);
    const orc = await monster(ctx, 6, 5, { icon: 'orc' }); // three cells away, straight along the row
    await wall(ctx, [5, 3], [5, 5]); // a wall in column 5, rows 3-5, between them
    await fogOn(ctx, 4);
    expect((await playerState(ctx)).tokens.map((t) => t.id)).not.toContain(orc.id);

    // Алиса steps down below the wall: now the orc is in a clear line of sight
    const sees = waitFor(ctx.alice.socket, 'state.snapshot', (s) =>
      s.tokens.some((t) => t.id === orc.id),
    );
    expect(await move(ctx.alice.socket, alice.id, 4, 8)).toMatchObject({ ok: true });
    expect((await sees).tokens.map((t) => t.id)).toContain(orc.id);
  });

  it('does not let a barrel hide anything, but a pillar does', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 3, 5);
    const target = await monster(ctx, 6, 5);
    await fogOn(ctx, 4);
    const barrel = await wall(ctx, [4, 5], [4, 5], 'barrel');
    expect((await playerState(ctx)).tokens.map((t) => t.id)).toContain(target.id);

    const hidden = waitFor(
      ctx.alice.socket,
      'state.snapshot',
      (s) => !s.tokens.some((t) => t.id === target.id),
    );
    await emitAck(ctx.master.socket, 'obstacle.remove', { obstacleId: barrel.id });
    await wall(ctx, [4, 5], [4, 5], 'pillar');
    expect((await hidden).tokens.map((t) => t.id)).not.toContain(target.id);
  });

  it('follows the walls and the fog settings when they change', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 3, 5);
    const target = await monster(ctx, 6, 5);
    await fogOn(ctx, 4);
    expect((await playerState(ctx)).tokens.map((t) => t.id)).toContain(target.id);

    const blocked = waitFor(
      ctx.alice.socket,
      'state.snapshot',
      (s) => !s.tokens.some((t) => t.id === target.id),
    );
    const built = await wall(ctx, [5, 5], [5, 5]);
    await blocked;
    const open = waitFor(ctx.alice.socket, 'state.snapshot', (s) =>
      s.tokens.some((t) => t.id === target.id),
    );
    await emitAck(ctx.master.socket, 'obstacle.setSight', {
      obstacleId: built.id,
      blocksSight: false,
    });
    await open;

    const narrower = waitFor(
      ctx.alice.socket,
      'state.snapshot',
      (s) => !s.tokens.some((t) => t.id === target.id),
    );
    await emitAck(ctx.master.socket, 'fog.update', { mapId: ctx.mapId, radius: 2 }); // 3 cells away is too far now
    await narrower;
    const everything = waitFor(ctx.alice.socket, 'state.snapshot', (s) =>
      s.tokens.some((t) => t.id === target.id),
    );
    await emitAck(ctx.master.socket, 'fog.update', { mapId: ctx.mapId, enabled: false });
    await everything;
  });

  it('shares what the characters see: one player can see through the eyes of another', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 3, 5);
    const farAway = await monster(ctx, 14, 5);
    await fogOn(ctx, 3);
    expect((await playerState(ctx)).tokens.map((t) => t.id)).not.toContain(farAway.id);

    await place(ctx, 'bob', 13, 5); // Боб stands next to it
    const seenByAlice = (await playerState(ctx)).tokens.map((t) => t.id);
    expect(seenByAlice).toContain(farAway.id);
    expect((await stateOf(ctx, ctx.bob.key)).tokens.map((t) => t.id)).toContain(farAway.id);
  });

  it('is complete darkness when no character is on the map, but the master still sees all', async () => {
    const ctx = await setup();
    await monster(ctx, 5, 5);
    await wall(ctx, [2, 2], [2, 2]);
    await fogOn(ctx, 5);

    const player = await playerState(ctx);
    expect([player.tokens.length, player.obstacles.length, player.fog.polygons.length]).toEqual([
      0, 1, 0,
    ]);
    const master = await stateOf(ctx, ctx.masterKey);
    expect([master.tokens.length, master.obstacles.length]).toEqual([1, 1]);
  });

  it('never hides the characters of other players, whatever the distance', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 2, 2);
    await place(ctx, 'bob', 18, 9);
    await fogOn(ctx, 2);
    expect(
      (await playerState(ctx)).tokens.filter((t) => t.type === 'player_character'),
    ).toHaveLength(2);
  });

  it('sends every player a fresh view when a character moves, the mover included', async () => {
    const ctx = await setup();
    const alice = await place(ctx, 'alice', 3, 5);
    await place(ctx, 'bob', 10, 5);
    const ahead = await monster(ctx, 6, 5);
    await fogOn(ctx, 2);
    const aliceViews = recordTraffic(ctx.alice.socket);
    const bobViews = recordTraffic(ctx.bob.socket);
    const a = aliceViews.mark();
    const b = bobViews.mark();

    await move(ctx.alice.socket, alice.id, 5, 5);
    await settle();

    expect(aliceViews.since(a)).toContain('state.snapshot');
    expect(bobViews.since(b)).toContain('state.snapshot');
    expect(aliceViews.since(a)).toContain(ahead.id); // she is next to it now
  });

  it('includes the polygons in what both roles are sent, and they contain the characters', async () => {
    const ctx = await setup();
    const alice = await place(ctx, 'alice', 3, 5);
    await fogOn(ctx, 3);
    for (const state of [await playerState(ctx), await stateOf(ctx, ctx.masterKey)]) {
      const fog: FogState = state.fog;
      expect(fog.polygons).toHaveLength(1);
      expect(inAnyPolygon({ x: alice.x, y: alice.y }, fog.polygons)).toBe(true);
      expect(inAnyPolygon(cell(20, 10), fog.polygons)).toBe(false);
      expect(JSON.stringify(fog.polygons).length).toBeLessThan(4000); // small enough to send often
    }
  });

  it('gives the master a fresh view too, so the lit area follows walls and characters', async () => {
    const ctx = await setup();
    const alice = await place(ctx, 'alice', 3, 5);
    await fogOn(ctx, 4);
    const area = (state: SessionState) => inAnyPolygon(cell(6, 5), state.fog.polygons);
    expect(area(await stateOf(ctx, ctx.masterKey))).toBe(true);

    const walled = waitFor(ctx.master.socket, 'state.snapshot', (st) => !area(st));
    await wall(ctx, [5, 5], [5, 5]);
    await walled; // the cell behind the wall went dark for the master as well

    const moved = waitFor(ctx.master.socket, 'state.snapshot', (st) =>
      inAnyPolygon(cell(1, 9), st.fog.polygons),
    );
    await move(ctx.alice.socket, alice.id, 2, 8);
    await moved;
  });

  it('shows live drags to players only while the monster is in sight', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 3, 5);
    const dragon = await monster(ctx, 12, 5);
    await fogOn(ctx, 3);
    const traffic = recordTraffic(ctx.alice.socket);
    const mark = traffic.mark();

    for (let col = 12; col >= 9; col--)
      ctx.master.socket.emit('token.drag', { tokenId: dragon.id, ...cell(col, 5) }); // all far
    await settle();
    expect(traffic.since(mark)).not.toContain('token.dragging');

    const seen = waitFor(ctx.alice.socket, 'token.dragging');
    ctx.master.socket.emit('token.drag', { tokenId: dragon.id, ...cell(5, 5) }); // now in view
    expect(await seen).toMatchObject({ tokenId: dragon.id });
  });

  it('does not let a stale idea of the fog show a drag: it follows the walls at once', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 3, 5);
    const dragon = await monster(ctx, 5, 5);
    await fogOn(ctx, 3);
    const seen = waitFor(ctx.alice.socket, 'token.dragging');
    ctx.master.socket.emit('token.drag', { tokenId: dragon.id, ...cell(5, 5) });
    await seen; // known to be visible, and cached by the relay

    await wall(ctx, [4, 5], [4, 5], 'pillar'); // now in the way
    const traffic = recordTraffic(ctx.alice.socket);
    const mark = traffic.mark();
    ctx.master.socket.emit('token.drag', { tokenId: dragon.id, ...cell(5, 5) });
    await settle();
    expect(traffic.since(mark)).not.toContain('token.dragging');
  });
});

describe('without fog nothing changes for players', () => {
  it('still gets every visible monster and obstacle, and an empty polygon list', async () => {
    const ctx = await setup();
    await place(ctx, 'alice', 3, 5);
    const far = await monster(ctx, 18, 9);
    await monster(ctx, 17, 9, { visible: false });
    const farWall = await wall(ctx, [19, 1], [19, 2]);

    const player = await playerState(ctx);

    expect(player.tokens.map((t) => t.id)).toContain(far.id);
    expect(player.tokens).toHaveLength(2); // Алиса and the visible monster; the hidden one stays hidden
    expect(player.obstacles.map((o) => o.id)).toEqual([farWall.id]);
    expect(player.fog).toEqual({ enabled: false, radius: 6, polygons: [] });
  });
});
