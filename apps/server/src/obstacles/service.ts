import {
  cellsRect,
  MAX_OBSTACLES_PER_MAP,
  OBSTACLE_KINDS,
  type ObstacleAdd,
  type ObstacleView,
  type ObstaclesPatch,
} from '@dnd-map/shared';
import type { Obstacle, PrismaClient } from '@prisma/client';
import { bumpVersion, gridOf, logEvent, type Tx } from '../db-utils';
import { toObstacleView } from './view';

type Failure = 'map_not_found' | 'obstacle_not_found' | 'invalid_request' | 'too_many_obstacles';

export type ObstacleOutcome =
  | { ok: true; patch: ObstaclesPatch; obstacle: ObstacleView | null }
  | { ok: false; error: Failure };

export type ObstacleService = ReturnType<typeof createObstacleService>;

const fail = (error: Failure): ObstacleOutcome => ({ ok: false, error });

export function createObstacleService(prisma: PrismaClient) {
  /** Obstacles can only be edited on the session's current map, like tokens. */
  async function load(tx: Tx, sessionId: string, obstacleId: string): Promise<Obstacle | null> {
    const row = await tx.obstacle.findFirst({
      where: { id: obstacleId, map: { sessionId } },
    });
    if (!row) return null;
    const session = await tx.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { currentMapId: true },
    });
    return session.currentMapId === row.mapId ? row : null;
  }

  return {
    /** The rectangle is decided here: the request names two cells, the server snaps and clips. */
    async add(sessionId: string, actorId: string, req: ObstacleAdd): Promise<ObstacleOutcome> {
      return prisma.$transaction(async (tx) => {
        const session = await tx.session.findUniqueOrThrow({
          where: { id: sessionId },
          select: { currentMapId: true },
        });
        if (session.currentMapId !== req.mapId) return fail('map_not_found');
        const map = await tx.map.findUniqueOrThrow({ where: { id: req.mapId } });
        if ((await tx.obstacle.count({ where: { mapId: map.id } })) >= MAX_OBSTACLES_PER_MAP) {
          return fail('too_many_obstacles');
        }

        const kind = OBSTACLE_KINDS[req.kind];
        const rect = cellsRect(
          { width: map.width, height: map.height, grid: gridOf(map) },
          req.from,
          req.to,
          kind.singleCell,
        );
        if (!rect) return fail('invalid_request'); // entirely outside the map

        const row = await tx.obstacle.create({
          data: {
            mapId: map.id,
            kind: req.kind,
            ...rect,
            blocksSight: req.blocksSight ?? kind.blocksSight,
          },
        });
        const { version } = await bumpVersion(tx, sessionId);
        await logEvent(tx, sessionId, actorId, 'obstacle.add', {
          obstacleId: row.id,
          kind: row.kind,
          ...rect,
        });
        const obstacle = toObstacleView(row);
        return { ok: true, obstacle, patch: { version, upserted: [obstacle], removedIds: [] } };
      });
    },

    async remove(sessionId: string, actorId: string, obstacleId: string): Promise<ObstacleOutcome> {
      return prisma.$transaction(async (tx) => {
        const row = await load(tx, sessionId, obstacleId);
        if (!row) return fail('obstacle_not_found');
        await tx.obstacle.delete({ where: { id: row.id } });
        const { version } = await bumpVersion(tx, sessionId);
        await logEvent(tx, sessionId, actorId, 'obstacle.remove', {
          obstacleId: row.id,
          kind: row.kind,
        });
        return {
          ok: true,
          obstacle: toObstacleView(row),
          patch: { version, upserted: [], removedIds: [row.id] },
        };
      });
    },

    async setSight(
      sessionId: string,
      actorId: string,
      obstacleId: string,
      blocksSight: boolean,
    ): Promise<ObstacleOutcome> {
      return prisma.$transaction(async (tx) => {
        const row = await load(tx, sessionId, obstacleId);
        if (!row) return fail('obstacle_not_found');
        const updated = await tx.obstacle.update({ where: { id: row.id }, data: { blocksSight } });
        const { version } = await bumpVersion(tx, sessionId);
        await logEvent(tx, sessionId, actorId, 'obstacle.sight', {
          obstacleId: row.id,
          blocksSight,
        });
        const obstacle = toObstacleView(updated);
        return { ok: true, obstacle, patch: { version, upserted: [obstacle], removedIds: [] } };
      });
    },

    /** Removes every obstacle of the current map. With nothing to remove nothing changes (no new version). */
    async clear(sessionId: string, actorId: string, mapId: string): Promise<ObstacleOutcome> {
      return prisma.$transaction(async (tx) => {
        const session = await tx.session.findUniqueOrThrow({
          where: { id: sessionId },
          select: { currentMapId: true, version: true },
        });
        if (session.currentMapId !== mapId) return fail('map_not_found');
        const rows = await tx.obstacle.findMany({ where: { mapId }, select: { id: true } });
        if (rows.length === 0) {
          return {
            ok: true,
            obstacle: null,
            patch: { version: session.version, upserted: [], removedIds: [] },
          };
        }
        await tx.obstacle.deleteMany({ where: { mapId } });
        const { version } = await bumpVersion(tx, sessionId);
        await logEvent(tx, sessionId, actorId, 'obstacle.clear', { removed: rows.length });
        return {
          ok: true,
          obstacle: null,
          patch: { version, upserted: [], removedIds: rows.map((r) => r.id) },
        };
      });
    },
  };
}
