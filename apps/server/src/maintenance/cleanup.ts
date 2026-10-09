import { FILES_URL_PREFIX } from '@dnd-map/shared';
import type { PrismaClient } from '@prisma/client';
import type { FileStorage } from '../maps/storage';

export interface CleanupOptions {
  /** Sessions with no activity for this long are deleted, with everything in them. */
  sessionTtlMs: number;
  /** Files younger than this are never treated as orphans: their upload may still be in progress. */
  orphanGraceMs: number;
  /** Sessions somebody is connected to right now are kept, however old their last change is. */
  isActive(sessionId: string): Promise<boolean>;
  now?: () => Date;
}

export interface CleanupReport {
  sessionsDeleted: number;
  filesDeleted: number;
}

const fileName = (url: string | null) =>
  url?.startsWith(FILES_URL_PREFIX) ? url.slice(FILES_URL_PREFIX.length) : null;

/**
 * Deletes expired sessions (the database cascades to participants, maps, tokens and the log)
 * and then every stored file that nothing references any more. The file sweep also catches
 * leftovers of crashes, e.g. a map file written just before the database insert failed.
 */
export async function runCleanup(
  prisma: PrismaClient,
  storage: FileStorage,
  options: CleanupOptions,
): Promise<CleanupReport> {
  const now = (options.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - options.sessionTtlMs);

  const expired = await prisma.session.findMany({
    where: { lastActivityAt: { lt: cutoff } },
    select: { id: true },
  });
  let sessionsDeleted = 0;
  let filesDeleted = 0;
  for (const { id } of expired) {
    if (await options.isActive(id)) continue;
    // The files are known to belong to the session, so they go right away (no grace period).
    const owned = await prisma.session.findUnique({
      where: { id },
      select: {
        maps: { select: { imageUrl: true, previewUrl: true } },
        participants: { select: { iconUrl: true } },
      },
    });
    // Re-checked in the delete itself: activity since the query above saves the session.
    const { count } = await prisma.session.deleteMany({
      where: { id, lastActivityAt: { lt: cutoff } },
    });
    if (count === 0 || !owned) continue;
    sessionsDeleted++;
    const names = [
      ...owned.maps.flatMap((m) => [m.imageUrl, m.previewUrl]),
      ...owned.participants.map((p) => p.iconUrl),
    ]
      .map(fileName)
      .filter((n) => n !== null);
    for (const name of names) {
      await storage.remove(name);
      filesDeleted++;
    }
  }

  const [maps, participants] = await Promise.all([
    prisma.map.findMany({ select: { imageUrl: true, previewUrl: true } }),
    prisma.participant.findMany({ where: { iconUrl: { not: null } }, select: { iconUrl: true } }),
  ]);
  const referenced = new Set(
    [...maps.flatMap((m) => [m.imageUrl, m.previewUrl]), ...participants.map((p) => p.iconUrl)]
      .map(fileName)
      .filter((n) => n !== null),
  );

  const graceCutoff = now.getTime() - options.orphanGraceMs;
  for (const file of await storage.list()) {
    if (referenced.has(file.name) || file.modifiedAt.getTime() > graceCutoff) continue;
    await storage.remove(file.name);
    filesDeleted++;
  }

  return { sessionsDeleted, filesDeleted };
}
