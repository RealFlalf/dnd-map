import { MAX_PARTICIPANTS, type CreateSessionResponse } from '@dnd-map/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  join,
  nextParticipants,
  resetDb,
  startServer,
  type TestSocket,
} from '../../test/helpers';

const db = createTestDb();
let server: Awaited<ReturnType<typeof startServer>>;

beforeEach(async () => {
  await resetDb(db);
  server = await startServer(db);
});
afterEach(() => server.close());
afterAll(() => db.close());

async function createSession(displayName = 'Мастер'): Promise<CreateSessionResponse> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { displayName },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function joinOk(socket: TestSocket, request: Parameters<typeof join>[1]) {
  const result = await join(socket, request);
  if (!result.ok) throw new Error(`join failed: ${result.error}`);
  return result;
}

describe('POST /api/sessions', () => {
  it('creates a session whose creator is the only master', async () => {
    const { inviteCode, participantKey } = await createSession('  Гэндальф  ');

    expect(inviteCode).toMatch(/^[A-Z2-9]{8}$/);
    const participants = await db.prisma.participant.findMany();
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({ role: 'master', displayName: 'Гэндальф' });
    // Only the hash is stored.
    expect(participants[0]!.keyHash).not.toBe(participantKey);
  });

  it.each([{}, { displayName: '' }, { displayName: 'x'.repeat(33) }, { displayName: 42 }])(
    'rejects invalid body %j',
    async (payload) => {
      const res = await server.app.inject({ method: 'POST', url: '/api/sessions', payload });
      expect(res.statusCode).toBe(400);
    },
  );
});

describe('GET /api/sessions/:inviteCode', () => {
  it('finds a session by code, tolerating case and dashes', async () => {
    const { inviteCode } = await createSession();
    const messy = `${inviteCode.slice(0, 4)}-${inviteCode.slice(4)}`.toLowerCase();

    const res = await server.app.inject({ method: 'GET', url: `/api/sessions/${messy}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ inviteCode });
  });

  it.each(['ABCDEFGH', 'garbage', '00000000'])('returns 404 for %s', async (code) => {
    const res = await server.app.inject({ method: 'GET', url: `/api/sessions/${code}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('session.join', () => {
  it('lets the master rejoin with the key and a new player join by name', async () => {
    const { inviteCode, participantKey } = await createSession();
    const masterSocket = await server.client();
    const master = await joinOk(masterSocket, { inviteCode, key: participantKey });
    expect(master.self).toMatchObject({ role: 'master', displayName: 'Мастер', online: true });
    expect(master.participantKey).toBeUndefined();

    const masterSeesPlayer = nextParticipants(masterSocket, (list) => list.length === 2);
    const player = await joinOk(await server.client(), { inviteCode, displayName: 'Фродо' });

    expect(player.self).toMatchObject({ role: 'player', displayName: 'Фродо' });
    expect(player.participantKey).toEqual(expect.any(String));
    expect(player.participants.map((p) => [p.displayName, p.role, p.online])).toEqual([
      ['Мастер', 'master', true],
      ['Фродо', 'player', true],
    ]);
    expect((await masterSeesPlayer).find((p) => p.id === player.self.id)?.online).toBe(true);
  });

  it('restores the same player after reconnecting with the key', async () => {
    const { inviteCode } = await createSession();
    const first = await server.client();
    const joined = await joinOk(first, { inviteCode, displayName: 'Сэм' });
    first.disconnect();

    const again = await joinOk(await server.client(), {
      inviteCode,
      key: joined.participantKey!,
    });

    expect(again.self).toMatchObject({ id: joined.self.id, role: 'player' });
    expect(again.participantKey).toBeUndefined();
    expect(await db.prisma.participant.count()).toBe(2);
  });

  it('never makes a second master, whatever the client sends', async () => {
    const { inviteCode } = await createSession();
    const socket = await server.client();

    const result = await joinOk(socket, {
      inviteCode,
      displayName: 'Хитрец',
      role: 'master',
    } as Parameters<typeof join>[1]);

    expect(result.self.role).toBe('player');
    expect(await db.prisma.participant.count({ where: { role: 'master' } })).toBe(1);
  });

  it('rejects a key from another session or a made-up key', async () => {
    const a = await createSession();
    const b = await createSession();
    const socket = await server.client();

    expect(await join(socket, { inviteCode: b.inviteCode, key: a.participantKey })).toEqual({
      ok: false,
      error: 'unknown_participant',
    });
    expect(await join(socket, { inviteCode: a.inviteCode, key: 'x'.repeat(43) })).toEqual({
      ok: false,
      error: 'unknown_participant',
    });
  });

  it('reports unknown sessions and malformed requests', async () => {
    const socket = await server.client();

    expect(await join(socket, { inviteCode: 'ABCDEFGH', displayName: 'Кто-то' })).toEqual({
      ok: false,
      error: 'session_not_found',
    });
    expect(await join(socket, { inviteCode: 'ABCDEFGH' } as Parameters<typeof join>[1])).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });

  it('marks a participant offline when they disconnect', async () => {
    const { inviteCode, participantKey } = await createSession();
    const masterSocket = await server.client();
    await joinOk(masterSocket, { inviteCode, key: participantKey });
    const playerSocket = await server.client();
    const player = await joinOk(playerSocket, { inviteCode, displayName: 'Пиппин' });

    const update = nextParticipants(
      masterSocket,
      (list) => list.find((p) => p.id === player.self.id)?.online === false,
    );
    playerSocket.disconnect();

    expect((await update).length).toBe(2);
  });

  it(`turns away new participants once ${MAX_PARTICIPANTS} are online, but not returning ones`, async () => {
    const { inviteCode, participantKey } = await createSession();
    await joinOk(await server.client(), { inviteCode, key: participantKey });
    for (let i = 1; i < MAX_PARTICIPANTS; i++) {
      await joinOk(await server.client(), { inviteCode, displayName: `Игрок ${i}` });
    }

    expect(await join(await server.client(), { inviteCode, displayName: 'Лишний' })).toEqual({
      ok: false,
      error: 'session_full',
    });
    // The master opening a second tab is still the same seat.
    const secondTab = await join(await server.client(), { inviteCode, key: participantKey });
    expect(secondTab.ok).toBe(true);
  });
});
