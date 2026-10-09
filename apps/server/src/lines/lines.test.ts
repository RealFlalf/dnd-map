import { MAX_LINES_PER_PARTICIPANT, type LineView } from '@dnd-map/shared';
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
} from '../../test/helpers';

const db = createTestDb();
let server: TestServer;

beforeEach(async () => {
  await resetDb(db);
  server = await startServer(db);
});
afterEach(() => server.close());
afterAll(() => db.close());

type Drawn = { ok: true; line: LineView };
type Failed = { ok: false; error: string };

/** A 700x350 map, the master and two players. */
async function setup() {
  const { inviteCode, participantKey: masterKey } = await createSession(server);
  const masterSocket = await server.client();
  const master = await joinOk(masterSocket, { inviteCode, key: masterKey });
  const aliceSocket = await server.client();
  const alice = await joinOk(aliceSocket, { inviteCode, displayName: 'Алиса' });
  const bobSocket = await server.client();
  await joinOk(bobSocket, { inviteCode, displayName: 'Боб' });
  const upload = await uploadMap(server, inviteCode, masterKey, await pngImage(700, 350));
  const mapId = (upload.json() as { mapId: string }).mapId;
  await Promise.all(
    [masterSocket, aliceSocket, bobSocket].map((s) =>
      waitFor(s, 'state.snapshot', (st) => st.currentMapId === mapId),
    ),
  );
  return {
    inviteCode,
    masterKey,
    masterId: master.self.id,
    aliceKey: alice.participantKey!,
    aliceId: alice.self.id,
    masterSocket,
    aliceSocket,
    bobSocket,
    mapId,
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const draw = <T = Drawn>(socket: Ctx['masterSocket'], request: unknown) =>
  emitAck<T>(socket, 'line.draw', request);
const versionOf = async (inviteCode: string) =>
  (await db.prisma.session.findUniqueOrThrow({ where: { inviteCode } })).version;

describe('temporary lines', () => {
  it('reach everybody else, from players and from the master alike, and are not stored', async () => {
    const ctx = await setup();
    const version = await versionOf(ctx.inviteCode);
    const logged = await db.prisma.eventLog.count();
    const ownTraffic = recordTraffic(ctx.aliceSocket);

    const atMaster = waitFor(ctx.masterSocket, 'line.drawn');
    const atBob = waitFor(ctx.bobSocket, 'line.drawn');
    const res = await draw(ctx.aliceSocket, { mapId: ctx.mapId, points: [70, 70, 140, 105] });
    expect(res).toMatchObject({
      ok: true,
      line: {
        mapId: ctx.mapId,
        authorId: ctx.aliceId,
        byMaster: false,
        points: [70, 70, 140, 105],
      },
    });
    expect(res.line.ttlMs).toBeGreaterThan(29_000);
    expect(res.line.ttlMs).toBeLessThanOrEqual(30_000);
    expect(await atMaster).toEqual(res.line);
    expect(await atBob).toEqual(res.line);
    expect(ownTraffic.messages.join('\n')).not.toContain('line.drawn'); // the author has the ack

    const fromMaster = waitFor(ctx.aliceSocket, 'line.drawn');
    const mres = await draw(ctx.masterSocket, { mapId: ctx.mapId, points: [0, 0, 700, 350] });
    expect(mres.line).toMatchObject({ authorId: ctx.masterId, byMaster: true });
    expect(await fromMaster).toEqual(mres.line);

    // Nothing in the database: no new version, no log entry.
    expect(await versionOf(ctx.inviteCode)).toBe(version);
    expect(await db.prisma.eventLog.count()).toBe(logged);
  });

  it('stay on the picture: points outside the map are pulled to its edge', async () => {
    const ctx = await setup();
    const res = await draw(ctx.aliceSocket, {
      mapId: ctx.mapId,
      points: [-100, 50, 350, 9999, 5000, -1],
    });
    expect(res.line.points).toEqual([0, 50, 350, 350, 700, 0]);
  });

  it('are there for someone who comes back, but only for the current map', async () => {
    const ctx = await setup();
    const res = await draw(ctx.masterSocket, { mapId: ctx.mapId, points: [0, 0, 70, 70] });

    const back = await joinOk(await server.client(), {
      inviteCode: ctx.inviteCode,
      key: ctx.aliceKey,
    });
    expect(back.lines).toHaveLength(1);
    expect(back.lines[0]).toMatchObject({ id: res.line.id, points: [0, 0, 70, 70] });
    expect(back.lines[0]!.ttlMs).toBeLessThanOrEqual(res.line.ttlMs);

    // Another map becomes current: its lines start empty.
    await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(700, 350));
    const later = await joinOk(await server.client(), {
      inviteCode: ctx.inviteCode,
      key: ctx.aliceKey,
    });
    expect(later.lines).toEqual([]);
  });

  it('go away when their time is up', async () => {
    await server.close();
    server = await startServer(db, { config: { LINE_TTL_SECONDS: 0.3 } });
    const ctx = await setup();
    const res = await draw(ctx.aliceSocket, { mapId: ctx.mapId, points: [0, 0, 70, 70] });
    expect(res.line.ttlMs).toBeLessThanOrEqual(300);
    const soon = await joinOk(await server.client(), {
      inviteCode: ctx.inviteCode,
      key: ctx.aliceKey,
    });
    expect(soon.lines).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 350));
    const late = await joinOk(await server.client(), {
      inviteCode: ctx.inviteCode,
      key: ctx.aliceKey,
    });
    expect(late.lines).toEqual([]);
  });

  it('are refused without a session, off the current map, and when malformed', async () => {
    const ctx = await setup();
    const traffic = recordTraffic(ctx.bobSocket);
    const stranger = await server.client();
    expect(await draw<Failed>(stranger, { mapId: ctx.mapId, points: [0, 0, 1, 1] })).toEqual({
      ok: false,
      error: 'not_joined',
    });

    // a map that is not the current one any more, or of another session
    const old = ctx.mapId;
    await uploadMap(server, ctx.inviteCode, ctx.masterKey, await pngImage(700, 350));
    await waitFor(ctx.aliceSocket, 'state.snapshot', (st) => st.currentMapId !== old);
    expect(await draw<Failed>(ctx.aliceSocket, { mapId: old, points: [0, 0, 1, 1] })).toEqual({
      ok: false,
      error: 'map_not_found',
    });
    expect(await draw<Failed>(ctx.aliceSocket, { mapId: 'nope', points: [0, 0, 1, 1] })).toEqual({
      ok: false,
      error: 'map_not_found',
    });

    for (const points of [[0, 0], [0, 0, 1], [0, 0, 'x', 1], 'line', null]) {
      expect(await draw<Failed>(ctx.aliceSocket, { mapId: old, points })).toEqual({
        ok: false,
        error: 'invalid_request',
      });
    }
    expect(traffic.messages.join('\n')).not.toContain('line.drawn');
  });

  it('a session without a map has nowhere to draw', async () => {
    const { inviteCode, participantKey } = await createSession(server);
    const socket = await server.client();
    await joinOk(socket, { inviteCode, key: participantKey });
    expect(await draw<Failed>(socket, { mapId: 'any', points: [0, 0, 1, 1] })).toEqual({
      ok: false,
      error: 'map_not_found',
    });
  });

  it('are limited per participant, so nobody can fill the map', async () => {
    const ctx = await setup();
    for (let i = 0; i < MAX_LINES_PER_PARTICIPANT; i++) {
      expect((await draw(ctx.aliceSocket, { mapId: ctx.mapId, points: [0, 0, i, i] })).ok).toBe(
        true,
      );
    }
    expect(await draw<Failed>(ctx.aliceSocket, { mapId: ctx.mapId, points: [0, 0, 1, 1] })).toEqual(
      { ok: false, error: 'too_many_lines' },
    );
    expect((await draw(ctx.bobSocket, { mapId: ctx.mapId, points: [0, 0, 1, 1] })).ok).toBe(true);
  });
});
