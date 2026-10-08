import {
  MAX_TOKENS_PER_MAP,
  type SessionState,
  type TokenDragging,
  type TokensPatch,
  type TokenView,
} from '@dnd-map/shared';
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

const db = createTestDb();
let server: TestServer;

beforeEach(async () => {
  await resetDb(db);
  server = await startServer(db);
});
afterEach(() => server.close());
afterAll(() => db.close());

const emitAck = <T>(socket: TestSocket, event: string, ...args: unknown[]): Promise<T> =>
  (
    socket.timeout(3000) as unknown as {
      emitWithAck: (e: string, ...a: unknown[]) => Promise<T>;
    }
  ).emitWithAck(event, ...args);

type Ok = { ok: true; version: number; token: TokenView };
type Failed = { ok: false; error: string };

/** A session with a map (default 70 px grid, 700x350), a master and a player, both connected. */
async function setup() {
  const { inviteCode, participantKey: masterKey } = await createSession(server);
  const masterSocket = await server.client();
  await joinOk(masterSocket, { inviteCode, key: masterKey });
  const playerSocket = await server.client();
  const player = await joinOk(playerSocket, { inviteCode, displayName: 'Игрок' });

  const upload = await uploadMap(server, inviteCode, masterKey, await pngImage(700, 350));
  const mapId = (upload.json() as { mapId: string }).mapId;
  await waitFor(masterSocket, 'state.snapshot', (s) => s.currentMapId === mapId).catch(() => null);

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

async function place(ctx: Ctx, over: Record<string, unknown> = {}): Promise<Ok> {
  const res = await emitAck<Ok | Failed>(ctx.masterSocket, 'token.create', {
    mapId: ctx.mapId,
    icon: 'wolf',
    x: 100,
    y: 100,
    ...over,
  });
  if (!res.ok) throw new Error(`token.create failed: ${res.error}`);
  return res;
}

/** Everything the server sends to a socket, as text, so tests can search the raw traffic. */
function recordTraffic(socket: TestSocket) {
  const messages: string[] = [];
  socket.onAny((event, ...args) => messages.push(`${event} ${JSON.stringify(args)}`));
  return {
    messages,
    mark: () => messages.length,
    since: (mark: number) => messages.slice(mark).join('\n'),
  };
}

const rejoin = async (ctx: Ctx, key: string): Promise<SessionState> => {
  const socket = await server.client();
  return (await joinOk(socket, { inviteCode: ctx.inviteCode, key })).state;
};

describe('token.create', () => {
  it('places a monster in the middle of the cell, names it and tells everyone', async () => {
    const ctx = await setup();
    const seen = waitFor(ctx.playerSocket, 'tokens.changed');

    const { token, version } = await place(ctx, { x: 100, y: 10 });

    expect(token).toMatchObject({
      type: 'monster',
      ownerParticipantId: null,
      name: 'Волк 1',
      icon: 'builtin:wolf',
      x: 105,
      y: 35,
      size: 1,
      visible: true,
    });
    const patch: TokensPatch = await seen;
    expect(patch).toEqual({ version, upserted: [token], removedIds: [] });
  });

  it('numbers monsters of one kind and keeps numbers unique after deletions', async () => {
    const ctx = await setup();
    const first = await place(ctx);
    const second = await place(ctx, { x: 300 });
    await emitAck(ctx.masterSocket, 'token.delete', { tokenId: first.token.id });

    const third = await place(ctx, { x: 500 });
    const other = await place(ctx, { icon: 'dragon', x: 600 });

    expect([second.token.name, third.token.name, other.token.name]).toEqual([
      'Волк 2',
      'Волк 3',
      'Дракон 1',
    ]);
  });

  it('snaps large creatures to line crossings and respects the free-placement setting', async () => {
    const ctx = await setup();
    const big = await place(ctx, { size: 2, x: 100, y: 100 });
    expect([big.token.x, big.token.y, big.token.size]).toEqual([70, 70, 2]);

    await emitAck(ctx.masterSocket, 'grid.update', { mapId: ctx.mapId, snap: false });
    const free = await place(ctx, { x: 101.5, y: 12.25 });
    expect([free.token.x, free.token.y]).toEqual([101.5, 12.25]);
  });

  it('keeps tokens inside the map', async () => {
    const ctx = await setup();
    const { token } = await place(ctx, { x: -500, y: 99999 });
    expect([token.x, token.y]).toEqual([35, 315]);
  });

  it('is refused for players, and the map stays empty', async () => {
    const ctx = await setup();
    const res = await emitAck(ctx.playerSocket, 'token.create', {
      mapId: ctx.mapId,
      icon: 'wolf',
      x: 1,
      y: 1,
    });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(await db.prisma.token.count()).toBe(0);
  });

  it('ignores any attempt to create a player character through this event', async () => {
    const ctx = await setup();
    const res = await emitAck<Ok>(ctx.masterSocket, 'token.create', {
      mapId: ctx.mapId,
      icon: 'wolf',
      x: 1,
      y: 1,
      type: 'player_character',
      ownerParticipantId: 'someone',
    });
    expect(res.token).toMatchObject({ type: 'monster', ownerParticipantId: null });
  });

  it.each([
    [{ icon: 'nope' }],
    [{ size: 9 }],
    [{ x: 'left' }],
    [{ mapId: '' }],
    [{ visible: 'maybe' }],
  ])('rejects invalid request %j', async (patch) => {
    const ctx = await setup();
    const res = await emitAck(ctx.masterSocket, 'token.create', {
      mapId: ctx.mapId,
      icon: 'wolf',
      x: 1,
      y: 1,
      ...patch,
    });
    expect(res).toEqual({ ok: false, error: 'invalid_request' });
  });

  it('only works on the current map', async () => {
    const ctx = await setup();
    const second = (
      await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(100, 100))
    ).json() as {
      mapId: string;
    };
    expect(second.mapId).not.toBe(ctx.mapId);

    const res = await emitAck(ctx.masterSocket, 'token.create', {
      mapId: ctx.mapId, // no longer current
      icon: 'wolf',
      x: 1,
      y: 1,
    });
    expect(res).toEqual({ ok: false, error: 'map_not_found' });
  });

  it(`stops at ${MAX_TOKENS_PER_MAP} tokens per map`, async () => {
    const ctx = await setup();
    await db.prisma.token.createMany({
      data: Array.from({ length: MAX_TOKENS_PER_MAP }, (_, i) => ({
        mapId: ctx.mapId,
        type: 'monster' as const,
        name: `Моб ${i}`,
        iconUrl: 'builtin:rat',
        x: 10,
        y: 10,
      })),
    });

    const res = await emitAck(ctx.masterSocket, 'token.create', {
      mapId: ctx.mapId,
      icon: 'wolf',
      x: 1,
      y: 1,
    });

    expect(res).toEqual({ ok: false, error: 'too_many_tokens' });
  });
});

describe('token.move', () => {
  it('saves the snapped position and tells the others', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    const seen = waitFor(ctx.playerSocket, 'tokens.changed');

    const res = await emitAck<Ok>(ctx.masterSocket, 'token.move', {
      tokenId: token.id,
      x: 300,
      y: 200,
    });

    expect(res.token).toMatchObject({ x: 315, y: 175 });
    expect((await seen).upserted[0]).toMatchObject({ id: token.id, x: 315, y: 175 });
    const stored = await db.prisma.token.findUniqueOrThrow({ where: { id: token.id } });
    expect([stored.x, stored.y]).toEqual([315, 175]);
    expect(res.version).toBe((await db.prisma.session.findFirstOrThrow()).version);
  });

  it('is refused for players, who may not even see why', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);

    const res = await emitAck(ctx.playerSocket, 'token.move', { tokenId: token.id, x: 5, y: 5 });

    expect(res).toEqual({ ok: false, error: 'forbidden' });
    const stored = await db.prisma.token.findUniqueOrThrow({ where: { id: token.id } });
    expect([stored.x, stored.y]).toEqual([105, 105]);
  });

  it('cannot reach a token of another session, or one that does not exist', async () => {
    const mine = await setup();
    const other = await setup();
    const foreign = await place(other);

    expect(
      await emitAck(mine.masterSocket, 'token.move', { tokenId: foreign.token.id, x: 1, y: 1 }),
    ).toEqual({ ok: false, error: 'token_not_found' });
    expect(await emitAck(mine.masterSocket, 'token.move', { tokenId: 'nope', x: 1, y: 1 })).toEqual(
      { ok: false, error: 'token_not_found' },
    );
  });

  it('rejects malformed positions', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    expect(
      await emitAck(ctx.masterSocket, 'token.move', { tokenId: token.id, x: 'a', y: 1 }),
    ).toEqual({ ok: false, error: 'invalid_request' });
  });
});

describe('token.delete', () => {
  it('removes the token for everyone', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    const seen = waitFor(ctx.playerSocket, 'tokens.changed');

    expect(await emitAck(ctx.masterSocket, 'token.delete', { tokenId: token.id })).toMatchObject({
      ok: true,
    });

    expect((await seen).removedIds).toEqual([token.id]);
    expect(await db.prisma.token.count()).toBe(0);
  });

  it('is refused for players', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    expect(await emitAck(ctx.playerSocket, 'token.delete', { tokenId: token.id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await db.prisma.token.count()).toBe(1);
  });
});

describe('hidden monsters', () => {
  it('never reach a player: not on placement, not in snapshots, not in any later traffic', async () => {
    const ctx = await setup();
    const traffic = recordTraffic(ctx.playerSocket);
    const start = traffic.mark();

    const { token } = await place(ctx, { icon: 'dragon', visible: false, x: 210, y: 140 });
    await emitAck(ctx.masterSocket, 'token.move', { tokenId: token.id, x: 400, y: 280 });
    ctx.masterSocket.emit('token.drag', { tokenId: token.id, x: 410, y: 285 });
    await emitAck(ctx.masterSocket, 'grid.update', { mapId: ctx.mapId, scale: 50 });
    await new Promise((r) => setTimeout(r, 200));

    // Everything the player got during all of that, searched for any trace of the monster.
    const raw = traffic.since(start);
    expect(raw).not.toContain(token.id);
    expect(raw).not.toContain('Дракон');
    expect(raw).not.toContain('builtin:dragon');
    expect(raw).toContain('tokens.changed'); // version ticks still arrive...
    expect(raw).toContain('"upserted":[]'); // ...but carry nothing

    // A fresh join and an explicit sync must not leak it either.
    const joined = await rejoin(ctx, ctx.playerKey);
    expect(joined.tokens).toEqual([]);
    expect(await emitAck<SessionState>(ctx.playerSocket, 'state.sync')).toMatchObject({
      tokens: [],
    });
    const masterState = await rejoin(ctx, ctx.masterKey);
    expect(masterState.tokens.map((t) => t.id)).toEqual([token.id]);
  });

  it('are shown and hidden on demand, and players see the change', async () => {
    const ctx = await setup();
    const { token } = await place(ctx, { visible: false });
    const revealed = waitFor(ctx.playerSocket, 'tokens.changed', (p) => p.upserted.length > 0);

    const shown = await emitAck<Ok>(ctx.masterSocket, 'token.setVisibility', {
      tokenId: token.id,
      visible: true,
    });
    expect(shown.token.visible).toBe(true);
    expect((await revealed).upserted[0]).toMatchObject({ id: token.id, visible: true });

    const gone = waitFor(ctx.playerSocket, 'tokens.changed', (p) => p.removedIds.length > 0);
    await emitAck(ctx.masterSocket, 'token.setVisibility', { tokenId: token.id, visible: false });
    expect((await gone).removedIds).toEqual([token.id]);
    expect((await rejoin(ctx, ctx.playerKey)).tokens).toEqual([]);
  });

  it('stay visible to the master, who is told about every change', async () => {
    const ctx = await setup();
    const second = await server.client();
    await joinOk(second, { inviteCode: ctx.inviteCode, key: ctx.masterKey });
    const seen = waitFor(second, 'tokens.changed');

    const { token } = await place(ctx, { visible: false });

    expect((await seen).upserted[0]).toMatchObject({ id: token.id, visible: false });
  });

  it('can only be revealed or hidden by the master', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    expect(
      await emitAck(ctx.playerSocket, 'token.setVisibility', { tokenId: token.id, visible: false }),
    ).toEqual({ ok: false, error: 'forbidden' });
  });
});

describe('token.drag', () => {
  it('shows a visible monster moving to the other participants, without storing anything', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    const seen = waitFor(ctx.playerSocket, 'token.dragging');

    ctx.masterSocket.emit('token.drag', { tokenId: token.id, x: 222.5, y: 111.5 });

    expect(await seen).toEqual({ tokenId: token.id, x: 222.5, y: 111.5 } satisfies TokenDragging);
    const stored = await db.prisma.token.findUniqueOrThrow({ where: { id: token.id } });
    expect([stored.x, stored.y]).toEqual([105, 105]);
  });

  it('is not relayed from players, nor for tokens they may not move', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    const master = recordTraffic(ctx.masterSocket);
    const start = master.mark();

    ctx.playerSocket.emit('token.drag', { tokenId: token.id, x: 1, y: 1 });
    ctx.playerSocket.emit('token.drag', { tokenId: 'garbage', x: 'a' } as never);
    await new Promise((r) => setTimeout(r, 250));

    expect(master.since(start)).not.toContain('token.dragging');
  });
});

describe('state per role', () => {
  it('includes the tokens of the current map only, and brings them back with the map', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    expect((await rejoin(ctx, ctx.masterKey)).tokens.map((t) => t.id)).toEqual([token.id]);

    const second = (
      await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(200, 200))
    ).json() as {
      mapId: string;
    };
    expect((await rejoin(ctx, ctx.masterKey)).tokens).toEqual([]);
    // The old token cannot be touched while its map is not shown.
    expect(
      await emitAck(ctx.masterSocket, 'token.move', { tokenId: token.id, x: 5, y: 5 }),
    ).toEqual({ ok: false, error: 'token_not_found' });

    await emitAck(ctx.masterSocket, 'map.select', { mapId: ctx.mapId });
    expect((await rejoin(ctx, ctx.masterKey)).tokens.map((t) => t.id)).toEqual([token.id]);

    await emitAck(ctx.masterSocket, 'map.delete', { mapId: ctx.mapId });
    expect(await db.prisma.token.count()).toBe(0);
    expect(second.mapId).toBeTruthy();
  });

  it('sends the right snapshot to each role when the map changes', async () => {
    const ctx = await setup();
    const { token: visible } = await place(ctx, { x: 100 });
    const { token: hidden } = await place(ctx, { x: 300, visible: false });
    await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(200, 200));
    const masterSees = waitFor(
      ctx.masterSocket,
      'state.snapshot',
      (s) => s.currentMapId === ctx.mapId,
    );
    const playerSees = waitFor(
      ctx.playerSocket,
      'state.snapshot',
      (s) => s.currentMapId === ctx.mapId,
    );

    await emitAck(ctx.masterSocket, 'map.select', { mapId: ctx.mapId });

    expect((await masterSees).tokens.map((t) => t.id).sort()).toEqual(
      [visible.id, hidden.id].sort(),
    );
    expect((await playerSees).tokens.map((t) => t.id)).toEqual([visible.id]);
  });
});

describe('audit log', () => {
  it('records who placed, moved, hid and removed a token', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    await emitAck(ctx.masterSocket, 'token.move', { tokenId: token.id, x: 300, y: 200 });
    await emitAck(ctx.masterSocket, 'token.setVisibility', { tokenId: token.id, visible: false });
    await emitAck(ctx.masterSocket, 'token.delete', { tokenId: token.id });

    const log = await db.prisma.eventLog.findMany({
      where: { type: { startsWith: 'token.' } },
      orderBy: { id: 'asc' },
      include: { participant: true },
    });

    expect(log.map((e) => e.type)).toEqual([
      'token.create',
      'token.move',
      'token.visibility',
      'token.delete',
    ]);
    expect(log.every((e) => e.participant?.role === 'master')).toBe(true);
    expect(log[1]!.payload).toMatchObject({ from: { x: 105, y: 105 }, to: { x: 315, y: 175 } });
  });

  it('does not log refused actions', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    await emitAck(ctx.playerSocket, 'token.move', { tokenId: token.id, x: 5, y: 5 });
    expect(await db.prisma.eventLog.count({ where: { type: 'token.move' } })).toBe(0);
  });
});

describe('latency', () => {
  it('delivers a move to another participant well under the 300 ms budget', async () => {
    const ctx = await setup();
    const { token } = await place(ctx);
    const times: number[] = [];

    for (let i = 0; i < 10; i++) {
      const arrived = waitFor(ctx.playerSocket, 'tokens.changed');
      const startedAt = performance.now();
      await emitAck(ctx.masterSocket, 'token.move', { tokenId: token.id, x: 100 + i * 70, y: 100 });
      await arrived;
      times.push(performance.now() - startedAt);
    }

    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const worst = times[times.length - 1]!;
    console.log(
      `token.move -> player latency: median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`,
    );
    expect(worst).toBeLessThan(300);
  });
});
