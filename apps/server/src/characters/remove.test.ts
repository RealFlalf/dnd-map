import { readdir } from 'node:fs/promises';
import type { ParticipantView, TokenView } from '@dnd-map/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  createTestDb,
  emitAck,
  join,
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

type Failed = { ok: false; error: string };
type Placed = { ok: true; version: number; token: TokenView };

/** A map, the master, Alice (with a character and an uploaded icon) and Bob (with a character). */
async function setup() {
  const { inviteCode, participantKey: masterKey } = await createSession(server);
  const master = await server.client();
  const masterJoin = await joinOk(master, { inviteCode, key: masterKey });
  const alice = await server.client();
  const aliceJoin = await joinOk(alice, { inviteCode, displayName: 'Алиса' });
  const bob = await server.client();
  const bobJoin = await joinOk(bob, { inviteCode, displayName: 'Боб' });
  const upload = await uploadMap(server, inviteCode, masterKey, await pngImage(700, 350));
  const mapId = (upload.json() as { mapId: string }).mapId;
  await Promise.all(
    [master, alice, bob].map((s) =>
      waitFor(s, 'state.snapshot', (st) => st.currentMapId === mapId),
    ),
  );
  const place = async (socket: TestSocket, x: number) => {
    const res = await emitAck<Placed>(socket, 'character.place', { mapId, x, y: 105 });
    if (!res.ok) throw new Error('character.place failed');
    return res.token;
  };
  const aliceToken = await place(alice, 105);
  const bobToken = await place(bob, 245);
  const icon = await server.app.inject({
    method: 'POST',
    url: `/api/sessions/${inviteCode}/icon`,
    headers: { 'content-type': 'image/png', 'x-participant-key': aliceJoin.participantKey! },
    body: await pngImage(64, 64),
  });
  if (icon.statusCode !== 201) throw new Error(`icon upload failed: ${icon.statusCode}`);
  return {
    inviteCode,
    mapId,
    master,
    masterId: masterJoin.self.id,
    alice,
    aliceId: aliceJoin.self.id,
    aliceKey: aliceJoin.participantKey!,
    aliceToken,
    bob,
    bobId: bobJoin.self.id,
    bobToken,
  };
}

const remove = <T = { ok: true; version: number }>(socket: TestSocket, participantId: unknown) =>
  emitAck<T>(socket, 'participant.remove', { participantId });
const icons = async () =>
  (await readdir(server.uploadsDir).catch(() => [])).filter((f) => f.endsWith('.icon.webp'));

describe('participant.remove', () => {
  it('removes the player with their characters and icon, and everybody is told', async () => {
    const ctx = await setup();
    expect(await icons()).toHaveLength(1);
    const before = await db.prisma.session.findUniqueOrThrow({
      where: { inviteCode: ctx.inviteCode },
    });

    const told = waitFor(ctx.alice, 'session.removed');
    const bobSees = waitFor(ctx.bob, 'state.snapshot', (st) =>
      st.tokens.every((t) => t.id !== ctx.aliceToken.id),
    );
    const bobList = nextParticipants(ctx.bob, (list) => list.every((p) => p.id !== ctx.aliceId));
    const res = await remove(ctx.master, ctx.aliceId);

    expect(res).toEqual({ ok: true, version: before.version + 1 });
    await told;
    expect((await bobSees).tokens.map((t) => t.id)).toEqual([ctx.bobToken.id]);
    expect((await bobList).map((p: ParticipantView) => p.displayName)).toEqual(['Мастер', 'Боб']);

    // Gone from the database: the participant, their characters, their uploaded icon.
    expect(await db.prisma.participant.findUnique({ where: { id: ctx.aliceId } })).toBeNull();
    expect(await db.prisma.token.findUnique({ where: { id: ctx.aliceToken.id } })).toBeNull();
    expect(await db.prisma.token.findUnique({ where: { id: ctx.bobToken.id } })).not.toBeNull();
    expect(await icons()).toEqual([]);
    // The log says who did it and to whom.
    const entry = await db.prisma.eventLog.findFirstOrThrow({
      where: { type: 'participant.remove' },
    });
    expect(entry).toMatchObject({
      participantId: ctx.masterId,
      payload: { participantId: ctx.aliceId, displayName: 'Алиса' },
    });
  });

  it('cuts the removed player off at once: no more updates, no more actions, no way back with the key', async () => {
    const ctx = await setup();
    const traffic = recordTraffic(ctx.alice);
    await remove(ctx.master, ctx.aliceId);
    const mark = traffic.mark();

    // What happens in the session afterwards does not reach them...
    await emitAck(ctx.bob, 'token.move', { tokenId: ctx.bobToken.id, x: 385, y: 105 });
    const masterGotLine = waitFor(ctx.master, 'line.drawn');
    await emitAck(ctx.bob, 'line.draw', { mapId: ctx.mapId, points: [0, 0, 70, 70] });
    await masterGotLine;
    expect(traffic.since(mark)).toBe('');

    // ...and they can no longer act in it.
    expect(
      await emitAck(ctx.alice, 'line.draw', { mapId: ctx.mapId, points: [0, 0, 1, 1] }),
    ).toEqual({
      ok: false,
      error: 'not_joined',
    });
    expect(
      await emitAck(ctx.alice, 'character.place', { mapId: ctx.mapId, x: 105, y: 105 }),
    ).toEqual({ ok: false, error: 'not_joined' });
    expect(await emitAck(ctx.alice, 'state.sync')).toBeNull();

    // The stored key is worthless, in a new tab too, and for the icon upload.
    expect(
      await join(await server.client(), { inviteCode: ctx.inviteCode, key: ctx.aliceKey }),
    ).toEqual({
      ok: false,
      error: 'unknown_participant',
    });
    const upload = await server.app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx.inviteCode}/icon`,
      headers: { 'content-type': 'image/png', 'x-participant-key': ctx.aliceKey },
      body: await pngImage(64, 64),
    });
    expect(upload.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('works for a player who is offline, and every open tab of the removed player is told', async () => {
    const ctx = await setup();
    const secondTab = await server.client();
    await joinOk(secondTab, { inviteCode: ctx.inviteCode, key: ctx.aliceKey });
    const both = Promise.all([
      waitFor(ctx.alice, 'session.removed'),
      waitFor(secondTab, 'session.removed'),
    ]);
    await remove(ctx.master, ctx.aliceId);
    await both;

    ctx.bob.disconnect();
    await nextParticipants(ctx.master, (list) => list.some((p) => p.id === ctx.bobId && !p.online));
    expect((await remove(ctx.master, ctx.bobId)).ok).toBe(true);
    expect(await db.prisma.participant.count({ where: { role: 'player' } })).toBe(0);
  });

  it('is refused to players, for the master, for strangers and for nonsense', async () => {
    const ctx = await setup();
    const version = async () =>
      (await db.prisma.session.findUniqueOrThrow({ where: { inviteCode: ctx.inviteCode } }))
        .version;
    const start = await version();

    expect(await remove<Failed>(ctx.alice, ctx.bobId)).toEqual({ ok: false, error: 'forbidden' });
    expect(await remove<Failed>(ctx.bob, ctx.bobId)).toEqual({ ok: false, error: 'forbidden' });
    expect(await remove<Failed>(ctx.alice, ctx.masterId)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    // The master is not a player: nobody can remove them, not even themselves.
    expect(await remove<Failed>(ctx.master, ctx.masterId)).toEqual({
      ok: false,
      error: 'participant_not_found',
    });
    expect(await remove<Failed>(ctx.master, 'nope')).toEqual({
      ok: false,
      error: 'participant_not_found',
    });
    for (const bad of [undefined, 42, '', 'x'.repeat(65)]) {
      expect(await remove<Failed>(ctx.master, bad)).toEqual({
        ok: false,
        error: 'invalid_request',
      });
    }
    expect(await remove<Failed>(await server.client(), ctx.aliceId)).toEqual({
      ok: false,
      error: 'not_joined',
    });

    // A player of another session is out of reach.
    const other = await createSession(server, 'Другой');
    const stranger = await joinOk(await server.client(), {
      inviteCode: other.inviteCode,
      displayName: 'Чужой',
    });
    expect(await remove<Failed>(ctx.master, stranger.self.id)).toEqual({
      ok: false,
      error: 'participant_not_found',
    });

    expect(await db.prisma.participant.count()).toBe(5);
    expect(await version()).toBe(start);
  });
});
