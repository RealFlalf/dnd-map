import { FILES_URL_PREFIX } from '@dnd-map/shared';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  createTestDb,
  joinOk,
  pngImage,
  resetDb,
  startServer,
  uploadMap,
  type TestServer,
} from '../../test/helpers';
import { createLocalStorage } from '../maps/storage';
import { runCleanup } from './cleanup';

const db = createTestDb();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
let server: TestServer;

beforeEach(async () => {
  await resetDb(db);
  server = await startServer(db);
});
afterEach(() => server.close());
afterAll(() => db.close());

const storageOf = () => createLocalStorage(server.uploadsDir);
const files = async () => (await storageOf().list()).map((f) => f.name).sort();
const age = (sessionId: string, days: number) =>
  db.prisma.session.update({
    where: { id: sessionId },
    data: { lastActivityAt: new Date(Date.now() - days * DAY) },
  });
const options = { sessionTtlMs: 30 * DAY, orphanGraceMs: HOUR, isActive: async () => false };

/** Makes every stored file look older than the orphan grace period. */
async function ageFiles(dir: string) {
  const old = new Date(Date.now() - 2 * HOUR);
  for (const f of await createLocalStorage(dir).list()) {
    await utimes(path.join(dir, f.name), old, old);
  }
}

/** A session with a map and a player who uploaded an icon: three files on disk. */
async function sessionWithFiles() {
  const { inviteCode, participantKey } = await createSession(server);
  await uploadMap(server, inviteCode, participantKey, await pngImage(100, 100));
  const player = await joinOk(await server.client(), { inviteCode, displayName: 'Игрок' });
  const icon = await server.app.inject({
    method: 'POST',
    url: `/api/sessions/${inviteCode}/icon`,
    headers: { 'content-type': 'image/png', 'x-participant-key': player.participantKey! },
    body: await pngImage(50, 50),
  });
  expect(icon.statusCode).toBe(201);
  const session = await db.prisma.session.findUniqueOrThrow({ where: { inviteCode } });
  return { id: session.id, inviteCode };
}

describe('runCleanup', () => {
  it('deletes sessions idle for longer than the TTL, with everything and all their files', async () => {
    const old = await sessionWithFiles();
    const fresh = await sessionWithFiles();
    expect(await files()).toHaveLength(6);
    await age(old.id, 31);

    const report = await runCleanup(db.prisma, storageOf(), options);

    expect(report).toEqual({ sessionsDeleted: 1, filesDeleted: 3 });
    expect(await db.prisma.session.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.prisma.participant.count({ where: { sessionId: old.id } })).toBe(0);
    expect(await db.prisma.map.count({ where: { sessionId: old.id } })).toBe(0);
    expect(await db.prisma.eventLog.count({ where: { sessionId: old.id } })).toBe(0);
    expect(await db.prisma.session.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await files()).toHaveLength(3);
    const res = await server.app.inject({ method: 'GET', url: `/api/sessions/${old.inviteCode}` });
    expect(res.statusCode).toBe(404);
  });

  it('keeps an old session while somebody is connected to it', async () => {
    const old = await sessionWithFiles();
    await age(old.id, 90);

    const report = await runCleanup(db.prisma, storageOf(), {
      ...options,
      isActive: async (id) => id === old.id,
    });

    expect(report.sessionsDeleted).toBe(0);
    expect(await files()).toHaveLength(3);
  });

  it('removes orphaned files, but not ones that may still be in the middle of an upload', async () => {
    await sessionWithFiles();
    const dir = server.uploadsDir;
    const stray = '00000000-0000-4000-8000-000000000001.png';
    const fresh = '00000000-0000-4000-8000-000000000002.icon.webp';
    await writeFile(path.join(dir, stray), 'x');
    await ageFiles(dir); // the session's own files are old too, but still referenced
    await writeFile(path.join(dir, fresh), 'x');

    const report = await runCleanup(db.prisma, storageOf(), options);

    expect(report).toEqual({ sessionsDeleted: 0, filesDeleted: 1 });
    expect(await files()).toContain(fresh);
    expect(await files()).not.toContain(stray);
    expect(await files()).toHaveLength(4);
  });

  it('never touches files it does not own', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dnd-map-foreign-'));
    try {
      await writeFile(path.join(dir, 'notes.txt'), 'keep me');
      await writeFile(path.join(dir, 'backup.png'), 'keep me');
      const old = new Date(Date.now() - 10 * DAY);
      await utimes(path.join(dir, 'notes.txt'), old, old);
      await utimes(path.join(dir, 'backup.png'), old, old);

      const report = await runCleanup(db.prisma, createLocalStorage(dir), options);

      expect(report.filesDeleted).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('frees an uploaded icon once nobody uses it', async () => {
    const { id } = await sessionWithFiles();
    const player = await db.prisma.participant.findFirstOrThrow({
      where: { sessionId: id, role: 'player' },
    });
    expect(player.iconUrl?.startsWith(FILES_URL_PREFIX)).toBe(true);
    await db.prisma.participant.update({
      where: { id: player.id },
      data: { iconUrl: 'builtin:wizard' },
    });
    await ageFiles(server.uploadsDir);

    const report = await runCleanup(db.prisma, storageOf(), options);

    expect(report.filesDeleted).toBe(1);
    expect(await files()).toHaveLength(2);
  });
});
