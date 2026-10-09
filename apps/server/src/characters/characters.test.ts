import {
  ICON_SIZE,
  MAX_ICON_BYTES,
  MAX_TOKENS_PER_MAP,
  PLAYER_ICONS,
  type ParticipantView,
  type TokenView,
} from '@dnd-map/shared';
import { readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  createTestDb,
  emitAck,
  joinOk,
  nextParticipants,
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

type Ok = { ok: true; version: number; token: TokenView };
type Failed = { ok: false; error: string };

interface Player {
  id: string;
  key: string;
  socket: TestSocket;
}

/** A session with a 700x350 map (70 px grid), the master and two players, Алиса and Боб. */
async function setup() {
  const { inviteCode, participantKey: masterKey } = await createSession(server);
  const masterSocket = await server.client();
  const master = await joinOk(masterSocket, { inviteCode, key: masterKey });

  const join = async (displayName: string): Promise<Player> => {
    const socket = await server.client();
    const res = await joinOk(socket, { inviteCode, displayName });
    return { id: res.self.id, key: res.participantKey!, socket };
  };
  const alice = await join('Алиса');
  const bob = await join('Боб');

  const upload = await uploadMap(server, inviteCode, masterKey, await pngImage(700, 350));
  const mapId = (upload.json() as { mapId: string }).mapId;
  // Let the snapshot of the new map reach everyone before the test starts acting.
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

const place = (socket: TestSocket, mapId: string, x = 100, y = 100) =>
  emitAck<Ok | Failed>(socket, 'character.place', { mapId, x, y });

const placeOk = async (socket: TestSocket, mapId: string, x?: number, y?: number) => {
  const res = await place(socket, mapId, x, y);
  if (!res.ok) throw new Error(`character.place failed: ${res.error}`);
  return res.token;
};

const monster = async (ctx: Ctx, x = 300, y = 100): Promise<TokenView> => {
  const res = await emitAck<Ok | Failed>(ctx.master.socket, 'token.create', {
    mapId: ctx.mapId,
    icon: 'goblin',
    x,
    y,
  });
  if (!res.ok) throw new Error(`token.create failed: ${res.error}`);
  return res.token;
};

const upload = (ctx: Ctx, key: string | undefined, body: Buffer, contentType = 'image/png') =>
  server.app.inject({
    method: 'POST',
    url: `/api/sessions/${ctx.inviteCode}/icon`,
    headers: { 'content-type': contentType, ...(key && { 'x-participant-key': key }) },
    body,
  });

const rowOf = (id: string) => db.prisma.token.findUniqueOrThrow({ where: { id } });

describe('character.setIcon', () => {
  it('stores the choice and shows it to everyone in the participant list', async () => {
    const ctx = await setup();
    const seen = nextParticipants(
      ctx.master.socket,
      (list) => list.find((p) => p.id === ctx.alice.id)?.icon === 'builtin:wizard',
    );

    const res = await emitAck(ctx.alice.socket, 'character.setIcon', { icon: 'wizard' });

    expect(res).toEqual({ ok: true, icon: 'builtin:wizard' });
    expect((await seen).find((p: ParticipantView) => p.id === ctx.alice.id)?.icon).toBe(
      'builtin:wizard',
    );
    const stored = await db.prisma.participant.findUniqueOrThrow({ where: { id: ctx.alice.id } });
    expect(stored.iconUrl).toBe('builtin:wizard');
  });

  it('gives players who never chose a valid default icon', async () => {
    const ctx = await setup();
    const joined = await joinOk(await server.client(), {
      inviteCode: ctx.inviteCode,
      key: ctx.alice.key,
    });
    const icons = PLAYER_ICONS.map((i) => `builtin:${i.id}`);
    for (const p of joined.participants) expect(icons).toContain(p.icon);
  });

  it('changes the icon of a character that is already on the map and tells the others', async () => {
    const ctx = await setup();
    const token = await placeOk(ctx.alice.socket, ctx.mapId);
    const seen = waitFor(ctx.bob.socket, 'tokens.changed', (p) => p.upserted.length > 0);

    await emitAck(ctx.alice.socket, 'character.setIcon', { icon: 'rogue' });

    expect((await seen).upserted[0]).toMatchObject({ id: token.id, icon: 'builtin:rogue' });
    expect((await rowOf(token.id)).iconUrl).toBe('builtin:rogue');
  });

  it.each([[{ icon: 'dragon' }], [{ icon: '/api/files/x.png' }], [{ icon: 5 }], [{}]])(
    'rejects %j',
    async (request) => {
      const ctx = await setup();
      expect(await emitAck(ctx.alice.socket, 'character.setIcon', request)).toEqual({
        ok: false,
        error: 'invalid_request',
      });
    },
  );

  it('is refused for the master, who has no character', async () => {
    const ctx = await setup();
    expect(await emitAck(ctx.master.socket, 'character.setIcon', { icon: 'wizard' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});

describe('icon upload', () => {
  it('crops an uploaded picture to a 256 px square WebP and uses it as the icon', async () => {
    const ctx = await setup();
    const seen = nextParticipants(
      ctx.master.socket,
      (list) => !!list.find((p) => p.id === ctx.alice.id)?.icon.endsWith('.icon.webp'),
    );

    const res = await upload(ctx, ctx.alice.key, await pngImage(600, 300));

    expect(res.statusCode).toBe(201);
    const { icon } = res.json() as { icon: string };
    expect(icon).toMatch(/^\/api\/files\/[0-9a-f-]{36}\.icon\.webp$/);
    expect((await seen).find((p) => p.id === ctx.alice.id)?.icon).toBe(icon);

    const file = await server.app.inject({ method: 'GET', url: icon });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect(await sharp(file.rawPayload).metadata()).toMatchObject({
      format: 'webp',
      width: ICON_SIZE,
      height: ICON_SIZE,
    });
  });

  it('is refused for the master, strangers and unknown sessions', async () => {
    const ctx = await setup();
    const image = await pngImage();

    expect((await upload(ctx, ctx.masterKey, image)).statusCode).toBe(403);
    expect((await upload(ctx, undefined, image)).statusCode).toBe(403);
    expect((await upload(ctx, 'x'.repeat(43), image)).statusCode).toBe(403);
    const other = await server.app.inject({
      method: 'POST',
      url: '/api/sessions/ABCDEFGH/icon',
      headers: { 'content-type': 'image/png', 'x-participant-key': ctx.alice.key },
      body: image,
    });
    expect(other.statusCode).toBe(404);
    expect((await readdir(server.uploadsDir)).filter((f) => f.endsWith('.icon.webp'))).toEqual([]);
  });

  it.each([
    ['text labelled as PNG', async () => Buffer.from('not an image'), 'image/png', 400],
    ['an empty body', async () => Buffer.alloc(0), 'image/png', 400],
    [
      'a GIF labelled as PNG',
      () =>
        sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
          .gif()
          .toBuffer(),
      'image/png',
      415,
    ],
    ['an SVG', async () => Buffer.from('<svg/>'), 'image/svg+xml', 415],
    ['a file over 2 MB', async () => Buffer.alloc(MAX_ICON_BYTES + 1), 'image/png', 413],
  ])('rejects %s', async (_name, makeBody, contentType, status) => {
    const ctx = await setup();
    const res = await upload(ctx, ctx.alice.key, await makeBody(), contentType);
    expect(res.statusCode).toBe(status);
    expect(await readdir(server.uploadsDir).catch(() => [])).toEqual(
      (await readdir(server.uploadsDir).catch(() => [])).filter((f) => !f.endsWith('.icon.webp')),
    );
  });

  it('replaces the old upload: the file is deleted and a placed character gets the new face', async () => {
    const ctx = await setup();
    const token = await placeOk(ctx.alice.socket, ctx.mapId);
    const first = (
      (await upload(ctx, ctx.alice.key, await pngImage(100, 100))).json() as { icon: string }
    ).icon;
    expect((await rowOf(token.id)).iconUrl).toBe(first);
    const seen = waitFor(ctx.bob.socket, 'tokens.changed', (p) => p.upserted[0]?.icon !== first);

    const second = (
      (await upload(ctx, ctx.alice.key, await pngImage(120, 80))).json() as { icon: string }
    ).icon;

    expect(second).not.toBe(first);
    expect((await seen).upserted[0]).toMatchObject({ id: token.id, icon: second });
    expect((await server.app.inject({ method: 'GET', url: first })).statusCode).toBe(404);
    expect((await server.app.inject({ method: 'GET', url: second })).statusCode).toBe(200);
  });

  it('switching back to a shipped icon removes the uploaded file', async () => {
    const ctx = await setup();
    const uploaded = (
      (await upload(ctx, ctx.alice.key, await pngImage())).json() as { icon: string }
    ).icon;

    await emitAck(ctx.alice.socket, 'character.setIcon', { icon: 'bard' });

    expect((await server.app.inject({ method: 'GET', url: uploaded })).statusCode).toBe(404);
  });
});

describe('character.place', () => {
  it('puts the character on the cell centre under the player name and tells the others', async () => {
    const ctx = await setup();
    await emitAck(ctx.alice.socket, 'character.setIcon', { icon: 'wizard' });
    const seenByMaster = waitFor(ctx.master.socket, 'tokens.changed');
    const seenByBob = waitFor(ctx.bob.socket, 'tokens.changed');

    const token = await placeOk(ctx.alice.socket, ctx.mapId, 100, 10);

    expect(token).toMatchObject({
      type: 'player_character',
      ownerParticipantId: ctx.alice.id,
      name: 'Алиса',
      icon: 'builtin:wizard',
      x: 105,
      y: 35,
      size: 1,
      visible: true,
    });
    expect((await seenByMaster).upserted).toEqual([token]);
    expect((await seenByBob).upserted).toEqual([token]);
  });

  it('allows one character per player and map, and the next map starts empty', async () => {
    const ctx = await setup();
    await placeOk(ctx.alice.socket, ctx.mapId);
    expect(await place(ctx.alice.socket, ctx.mapId)).toEqual({
      ok: false,
      error: 'already_placed',
    });
    await placeOk(ctx.bob.socket, ctx.mapId, 300, 300); // someone else is not affected

    const second = (
      await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(200, 200))
    ).json() as {
      mapId: string;
    };
    const again = await placeOk(ctx.alice.socket, second.mapId, 50, 50);
    expect(again.mapId).toBe(second.mapId);
    expect(await place(ctx.alice.socket, second.mapId)).toEqual({
      ok: false,
      error: 'already_placed',
    });

    // Back on the first map the old character is still there, and still counts as placed.
    await emitAck(ctx.master.socket, 'map.select', { mapId: ctx.mapId });
    expect(await place(ctx.alice.socket, ctx.mapId)).toEqual({
      ok: false,
      error: 'already_placed',
    });
    expect(await db.prisma.token.count({ where: { ownerParticipantId: ctx.alice.id } })).toBe(2);
  });

  it('gives exactly one character when the same request arrives twice at once', async () => {
    const ctx = await setup();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => place(ctx.alice.socket, ctx.mapId, 100 + i * 70, 100)),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as Failed).error)).toEqual(
      Array(4).fill('already_placed'),
    );
    expect(await db.prisma.token.count({ where: { ownerParticipantId: ctx.alice.id } })).toBe(1);
  });

  it('can be taken off the map and placed again', async () => {
    const ctx = await setup();
    const token = await placeOk(ctx.alice.socket, ctx.mapId);
    const gone = waitFor(ctx.bob.socket, 'tokens.changed', (p) => p.removedIds.length > 0);

    expect(await emitAck(ctx.alice.socket, 'token.delete', { tokenId: token.id })).toMatchObject({
      ok: true,
    });

    expect((await gone).removedIds).toEqual([token.id]);
    expect(await place(ctx.alice.socket, ctx.mapId)).toMatchObject({ ok: true });
  });

  it('is refused for requests that make no sense', async () => {
    const ctx = await setup();
    // The master has no character of their own: they have to say whose character to place.
    expect(await place(ctx.master.socket, ctx.mapId)).toEqual({
      ok: false,
      error: 'invalid_request',
    });
    expect(
      await emitAck(ctx.alice.socket, 'character.place', { mapId: ctx.mapId, x: 'a', y: 1 }),
    ).toEqual({
      ok: false,
      error: 'invalid_request',
    });
    expect(await place(ctx.alice.socket, 'no-such-map')).toEqual({
      ok: false,
      error: 'map_not_found',
    });
    const lonely = await server.client();
    expect(await place(lonely, ctx.mapId)).toEqual({ ok: false, error: 'not_joined' });
    expect(await db.prisma.token.count()).toBe(0);
  });

  describe('placed by the master', () => {
    const placeFor = (ctx: Ctx, participantId: string, x = 100, y = 100) =>
      emitAck<Ok | Failed>(ctx.master.socket, 'character.place', {
        mapId: ctx.mapId,
        participantId,
        x,
        y,
      });

    it("puts a player's character on the map in their name and tells everyone", async () => {
      const ctx = await setup();
      await emitAck(ctx.bob.socket, 'character.setIcon', { icon: 'ranger' });
      const seen = waitFor(ctx.alice.socket, 'tokens.changed');

      const res = await placeFor(ctx, ctx.bob.id, 300, 200);

      expect(res).toMatchObject({
        ok: true,
        token: {
          type: 'player_character',
          ownerParticipantId: ctx.bob.id,
          name: 'Боб',
          icon: 'builtin:ranger',
          x: 315,
          y: 175,
        },
      });
      expect((await seen).upserted[0]).toMatchObject({ name: 'Боб' });
      // ...and the player owns it from then on
      const bobMoves = await emitAck<Ok>(ctx.bob.socket, 'token.move', {
        tokenId: (res as Ok).token.id,
        x: 500,
        y: 100,
      });
      expect(bobMoves.ok).toBe(true);
    });

    it('keeps the rule of one character per player and map', async () => {
      const ctx = await setup();
      await placeOk(ctx.bob.socket, ctx.mapId);
      expect(await placeFor(ctx, ctx.bob.id)).toEqual({ ok: false, error: 'already_placed' });
      expect((await placeFor(ctx, ctx.alice.id)).ok).toBe(true);
      expect(await placeFor(ctx, ctx.alice.id)).toEqual({ ok: false, error: 'already_placed' });
    });

    it('rejects people who are not players of this session, and the master as a target', async () => {
      const ctx = await setup();
      const other = await setup();
      const refused = { ok: false, error: 'participant_not_found' };
      expect(await placeFor(ctx, ctx.master.id)).toEqual(refused);
      expect(await placeFor(ctx, other.alice.id)).toEqual(refused);
      expect(await placeFor(ctx, 'no-such-participant')).toEqual(refused);
      expect(await db.prisma.token.count({ where: { type: 'player_character' } })).toBe(0);
    });

    it('is not possible for a player, whatever participantId they send', async () => {
      const ctx = await setup();
      const res = await emitAck(ctx.alice.socket, 'character.place', {
        mapId: ctx.mapId,
        participantId: ctx.bob.id,
        x: 1,
        y: 1,
      });
      expect(res).toEqual({ ok: false, error: 'forbidden' });
      // naming themselves is the same as naming nobody
      const self = await emitAck<Ok>(ctx.alice.socket, 'character.place', {
        mapId: ctx.mapId,
        participantId: ctx.alice.id,
        x: 1,
        y: 1,
      });
      expect(self.ok).toBe(true);
      expect(await db.prisma.token.count()).toBe(1);
    });

    it('writes the master as the actor in the audit log', async () => {
      const ctx = await setup();
      const token = ((await placeFor(ctx, ctx.alice.id)) as Ok).token;
      await emitAck(ctx.master.socket, 'token.move', { tokenId: token.id, x: 300, y: 200 });
      await emitAck(ctx.master.socket, 'token.delete', { tokenId: token.id });

      const log = await db.prisma.eventLog.findMany({
        where: { type: { in: ['token.create', 'token.move', 'token.delete'] } },
        orderBy: { id: 'asc' },
      });

      expect(log.map((e) => [e.type, e.participantId])).toEqual([
        ['token.create', ctx.master.id],
        ['token.move', ctx.master.id],
        ['token.delete', ctx.master.id],
      ]);
      expect(log[0]!.payload).toMatchObject({ owner: ctx.alice.id });
    });
  });

  describe('moved and removed by the master', () => {
    it('shows the move to the player at once and lets them carry on from the new place', async () => {
      const ctx = await setup();
      const token = await placeOk(ctx.alice.socket, ctx.mapId, 100, 100);
      const seen = waitFor(ctx.alice.socket, 'tokens.changed', (p) => p.upserted.length > 0);

      const res = await emitAck<Ok>(ctx.master.socket, 'token.move', {
        tokenId: token.id,
        x: 600,
        y: 300,
      });

      expect(res.token).toMatchObject({ x: 595, y: 315 });
      expect((await seen).upserted[0]).toMatchObject({ id: token.id, x: 595, y: 315 });
      const back = await emitAck<Ok>(ctx.alice.socket, 'token.move', {
        tokenId: token.id,
        x: 100,
        y: 100,
      });
      expect(back.token).toMatchObject({ x: 105, y: 105 });
    });

    it('removes a character that stayed behind after its player left, and the player can come back', async () => {
      const ctx = await setup();
      const token = await placeOk(ctx.bob.socket, ctx.mapId);
      ctx.bob.socket.disconnect();
      const gone = waitFor(ctx.alice.socket, 'tokens.changed', (p) => p.removedIds.length > 0);

      expect(await emitAck(ctx.master.socket, 'token.delete', { tokenId: token.id })).toMatchObject(
        { ok: true },
      );

      expect((await gone).removedIds).toEqual([token.id]);
      const back = await server.client();
      await joinOk(back, { inviteCode: ctx.inviteCode, key: ctx.bob.key });
      expect(await place(back, ctx.mapId)).toMatchObject({ ok: true });
    });
  });

  it('only works on the current map', async () => {
    const ctx = await setup();
    await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(200, 200));
    expect(await place(ctx.alice.socket, ctx.mapId)).toEqual({ ok: false, error: 'map_not_found' });
  });

  it(`respects the ${MAX_TOKENS_PER_MAP} token limit of a map`, async () => {
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
    expect(await place(ctx.alice.socket, ctx.mapId)).toEqual({
      ok: false,
      error: 'too_many_tokens',
    });
  });

  it('survives a reconnect: the returning player still owns and can move the character', async () => {
    const ctx = await setup();
    const token = await placeOk(ctx.alice.socket, ctx.mapId);
    ctx.alice.socket.disconnect();

    const again = await server.client();
    const joined = await joinOk(again, { inviteCode: ctx.inviteCode, key: ctx.alice.key });
    expect(joined.state.tokens.find((t) => t.id === token.id)).toBeTruthy();

    const moved = await emitAck<Ok>(again, 'token.move', { tokenId: token.id, x: 300, y: 200 });
    expect(moved.token).toMatchObject({ x: 315, y: 175 });
  });
});

/**
 * The access matrix of the requirements, enforced by the server: every actor against every kind of
 * token. The expected results are written out by hand, not derived from the code under test.
 */
describe('access matrix', () => {
  type Actor = 'master' | 'alice' | 'bob';
  type Target = 'monster' | 'aliceChar' | 'bobChar';
  const actors: Actor[] = ['master', 'alice', 'bob'];
  const targets: Target[] = ['monster', 'aliceChar', 'bobChar'];

  // The master runs the table; a player controls their own character and nothing else.
  const allowedMoveOrDelete = (actor: Actor, target: Target) =>
    actor === 'master' ||
    (actor === 'alice' && target === 'aliceChar') ||
    (actor === 'bob' && target === 'bobChar');
  const allowedVisibility = (actor: Actor, target: Target) =>
    actor === 'master' && target === 'monster';

  async function world() {
    const ctx = await setup();
    const tokens: Record<Target, TokenView> = {
      monster: await monster(ctx),
      aliceChar: await placeOk(ctx.alice.socket, ctx.mapId, 100, 100),
      bobChar: await placeOk(ctx.bob.socket, ctx.mapId, 500, 100),
    };
    const sockets: Record<Actor, TestSocket> = {
      master: ctx.master.socket,
      alice: ctx.alice.socket,
      bob: ctx.bob.socket,
    };
    return { ctx, tokens, sockets };
  }

  it('refuses every move, delete and visibility change the matrix does not allow', async () => {
    const { tokens, sockets } = await world();
    const before = await db.prisma.token.findMany({ orderBy: { id: 'asc' } });
    let refused = 0;

    for (const actor of actors) {
      for (const target of targets) {
        const tokenId = tokens[target].id;
        if (!allowedMoveOrDelete(actor, target)) {
          expect(
            await emitAck(sockets[actor], 'token.move', { tokenId, x: 600, y: 300 }),
            `${actor} moves ${target}`,
          ).toEqual({ ok: false, error: 'forbidden' });
          expect(
            await emitAck(sockets[actor], 'token.delete', { tokenId }),
            `${actor} deletes ${target}`,
          ).toEqual({ ok: false, error: 'forbidden' });
          refused += 2;
        }
        if (!allowedVisibility(actor, target)) {
          expect(
            await emitAck(sockets[actor], 'token.setVisibility', { tokenId, visible: false }),
            `${actor} hides ${target}`,
          ).toEqual({ ok: false, error: 'forbidden' });
          refused++;
        }
      }
    }

    // 4 forbidden pairs for move+delete (each player on the monster and on the other player), 8 for visibility
    expect(refused).toBe(4 * 2 + 8);
    expect(await db.prisma.token.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(
      await db.prisma.eventLog.count({
        where: { type: { in: ['token.move', 'token.delete', 'token.visibility'] } },
      }),
    ).toBe(0);
  });

  it.each(
    actors.flatMap((actor) =>
      targets
        .filter((t) => allowedMoveOrDelete(actor, t))
        .map((target) => [actor, target] as const),
    ),
  )('lets %s move and then delete %s', async (actor, target) => {
    const { tokens, sockets } = await world();
    const tokenId = tokens[target].id;

    const moved = await emitAck<Ok>(sockets[actor], 'token.move', { tokenId, x: 600, y: 300 });
    expect(moved).toMatchObject({ ok: true, token: { x: 595, y: 315 } });
    expect(await emitAck(sockets[actor], 'token.delete', { tokenId })).toMatchObject({ ok: true });
    expect(await db.prisma.token.findUnique({ where: { id: tokenId } })).toBeNull();
  });

  it('lets only the master hide a monster', async () => {
    const { tokens, sockets } = await world();
    const res = await emitAck<Ok>(sockets.master, 'token.setVisibility', {
      tokenId: tokens.monster.id,
      visible: false,
    });
    expect(res.token.visible).toBe(false);
  });

  it('keeps characters always visible, even from the master', async () => {
    const { tokens, sockets } = await world();
    for (const actor of actors) {
      const res = await emitAck(sockets[actor], 'token.setVisibility', {
        tokenId: tokens.aliceChar.id,
        visible: false,
      });
      expect(res).toEqual({ ok: false, error: 'forbidden' });
    }
    expect((await rowOf(tokens.aliceChar.id)).visibleToPlayers).toBe(true);
  });

  it('relays live drags only for tokens the dragger may move', async () => {
    const { tokens, sockets } = await world();
    const traffic = Object.fromEntries(actors.map((a) => [a, recordTraffic(sockets[a])])) as Record<
      Actor,
      ReturnType<typeof recordTraffic>
    >;
    const marks = Object.fromEntries(actors.map((a) => [a, traffic[a].mark()])) as Record<
      Actor,
      number
    >;

    for (const actor of actors) {
      for (const target of targets) {
        // x encodes who drags what, so the receiver can tell the events apart
        sockets[actor].emit('token.drag', {
          tokenId: tokens[target].id,
          x: actors.indexOf(actor) * 10 + targets.indexOf(target),
          y: 1,
        });
      }
    }
    await new Promise((r) => setTimeout(r, 400));

    const received = (observer: Actor) =>
      [
        ...traffic[observer].since(marks[observer]).matchAll(/token\.dragging \[(\{[^\]]*\})\]/g),
      ].map((m) => (JSON.parse(m[1]!) as { tokenId: string; x: number }).x);
    // Allowed drags: master->monster (0), master->aliceChar (1), master->bobChar (2),
    // alice->aliceChar (11), bob->bobChar (22).
    expect(received('master').sort((a, b) => a - b)).toEqual([11, 22]);
    expect(received('alice').sort((a, b) => a - b)).toEqual([0, 1, 2, 22]);
    expect(received('bob').sort((a, b) => a - b)).toEqual([0, 1, 2, 11]);
  });

  it('does not let a player create monsters or change the grid and maps', async () => {
    const { ctx } = await world();
    const create = await emitAck(ctx.alice.socket, 'token.create', {
      mapId: ctx.mapId,
      icon: 'wolf',
      x: 1,
      y: 1,
    });
    expect(create).toEqual({ ok: false, error: 'forbidden' });
    expect(await emitAck(ctx.alice.socket, 'grid.update', { mapId: ctx.mapId, scale: 20 })).toEqual(
      { ok: false, error: 'forbidden' },
    );
    expect(await emitAck(ctx.alice.socket, 'map.select', { mapId: ctx.mapId })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await emitAck(ctx.alice.socket, 'map.delete', { mapId: ctx.mapId })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await db.prisma.map.count()).toBe(1);
  });
});

describe('audit log', () => {
  it('records placing a character and changing its icon', async () => {
    const ctx = await setup();
    await emitAck(ctx.alice.socket, 'character.setIcon', { icon: 'monk' });
    await placeOk(ctx.alice.socket, ctx.mapId);

    const log = await db.prisma.eventLog.findMany({
      where: { type: { in: ['character.icon', 'token.create'] } },
      orderBy: { id: 'asc' },
    });

    expect(log.map((e) => [e.type, e.participantId])).toEqual([
      ['character.icon', ctx.alice.id],
      ['token.create', ctx.alice.id],
    ]);
  });
});
