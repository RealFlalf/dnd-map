import {
  applyGridUpdate,
  MAX_MAPS_PER_SESSION,
  type GridSettings,
  type FogUpdate,
  type GridUpdate,
  type MapView,
  type Role,
  type SessionState,
} from '@dnd-map/shared';
import { Prisma, type Map as MapRow, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { bumpVersion, gridOf, logEvent } from '../db-utils';
import { toObstacleView } from '../obstacles/view';
import { toTokenView } from '../tokens/view';
import { NO_FOG, viewFor } from '../vision/view';
import type { ProcessedImage } from './image';
import type { FileStorage } from './storage';

export class TooManyMapsError extends Error {
  constructor() {
    super('too_many_maps');
  }
}

export type MapService = ReturnType<typeof createMapService>;

const FILES_URL_PREFIX = '/api/files/';
const fileNameOf = (url: string) => url.slice(FILES_URL_PREFIX.length);

export function createMapService(prisma: PrismaClient, storage: FileStorage) {
  const toView = (m: MapRow): MapView => ({
    id: m.id,
    imageUrl: m.imageUrl,
    previewUrl: m.previewUrl ?? m.imageUrl,
    width: m.width,
    height: m.height,
    grid: gridOf(m),
  });

  const removeFiles = (maps: Array<Pick<MapRow, 'imageUrl' | 'previewUrl'>>) =>
    Promise.allSettled(
      maps.flatMap((m) =>
        [m.imageUrl, m.previewUrl].flatMap((u) => (u ? [storage.remove(fileNameOf(u))] : [])),
      ),
    );

  return {
    /**
     * The state as `viewer` may see it: players never get hidden monsters. Read in one snapshot so
     * the version always matches the tokens it is sent with.
     */
    async getState(sessionId: string, viewer: Role): Promise<SessionState> {
      return prisma.$transaction(
        async (tx) => {
          const session = await tx.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { version: true, currentMapId: true, maps: { orderBy: { createdAt: 'asc' } } },
          });
          const current = session.maps.find((m) => m.id === session.currentMapId) ?? null;
          const [tokens, obstacles] = current
            ? await Promise.all([
                tx.token.findMany({ where: { mapId: current.id }, orderBy: { createdAt: 'asc' } }),
                tx.obstacle.findMany({
                  where: { mapId: current.id },
                  orderBy: { createdAt: 'asc' },
                }),
              ])
            : [[], []];
          // The role's own view: what players may not see (hidden monsters, everything out of sight
          // when there is fog) is cut out here, before anything leaves the server.
          const view = current
            ? viewFor(viewer, {
                grid: gridOf(current),
                fog: { enabled: current.fogEnabled, radius: current.fogRadius },
                tokens: tokens.map(toTokenView),
                obstacles: obstacles.map(toObstacleView),
              })
            : { fog: NO_FOG, tokens: [], obstacles: [] };
          return {
            version: session.version,
            currentMapId: session.currentMapId,
            maps: session.maps.map(toView),
            ...view,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },

    /** Fog of war of the current map: on or off, and how far the party sees. Returns the new version. */
    async updateFog(
      sessionId: string,
      actorId: string,
      req: FogUpdate,
    ): Promise<{ version: number } | null> {
      return prisma.$transaction(async (tx) => {
        const session = await tx.session.findUniqueOrThrow({
          where: { id: sessionId },
          select: { currentMapId: true },
        });
        if (session.currentMapId !== req.mapId) return null;
        await tx.map.update({
          where: { id: req.mapId },
          data: {
            ...(req.enabled !== undefined && { fogEnabled: req.enabled }),
            ...(req.radius !== undefined && { fogRadius: req.radius }),
          },
        });
        const { version } = await bumpVersion(tx, sessionId);
        await logEvent(tx, sessionId, actorId, 'fog.update', {
          enabled: req.enabled,
          radius: req.radius,
        });
        return { version };
      });
    },

    /** Stores the files, adds the map and makes it the current one. */
    async addMap(sessionId: string, original: Buffer, image: ProcessedImage): Promise<string> {
      if ((await prisma.map.count({ where: { sessionId } })) >= MAX_MAPS_PER_SESSION) {
        throw new TooManyMapsError();
      }

      const id = randomUUID();
      const imageName = `${id}.${image.ext}`;
      const previewName = `${id}.preview.webp`;
      await storage.save(imageName, original);
      try {
        await storage.save(previewName, image.preview);
        await prisma.$transaction(async (tx) => {
          const map = await tx.map.create({
            data: {
              // Same id as in the file names, so files can be traced back to their map.
              id,
              sessionId,
              imageUrl: FILES_URL_PREFIX + imageName,
              previewUrl: FILES_URL_PREFIX + previewName,
              width: image.width,
              height: image.height,
            },
          });
          await bumpVersion(tx, sessionId, { currentMapId: map.id });
        });
      } catch (err) {
        await Promise.allSettled([storage.remove(imageName), storage.remove(previewName)]);
        throw err;
      }
      return id;
    },

    /** Returns false if the map does not belong to the session. */
    async selectMap(sessionId: string, mapId: string): Promise<boolean> {
      return prisma.$transaction(async (tx) => {
        if (!(await tx.map.findFirst({ where: { id: mapId, sessionId }, select: { id: true } }))) {
          return false;
        }
        await bumpVersion(tx, sessionId, { currentMapId: mapId });
        return true;
      });
    },

    /** Deletes a map with its tokens and files; if it was current, the newest remaining map takes over. */
    async deleteMap(sessionId: string, mapId: string): Promise<boolean> {
      const deleted = await prisma.$transaction(async (tx) => {
        const map = await tx.map.findFirst({ where: { id: mapId, sessionId } });
        if (!map) return null;
        const session = await tx.session.findUniqueOrThrow({
          where: { id: sessionId },
          select: { currentMapId: true },
        });
        await tx.map.delete({ where: { id: mapId } });
        const next =
          session.currentMapId === mapId
            ? await tx.map.findFirst({
                where: { sessionId },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
              })
            : undefined;
        await bumpVersion(
          tx,
          sessionId,
          next === undefined ? {} : { currentMapId: next?.id ?? null },
        );
        return map;
      });
      if (!deleted) return false;
      await removeFiles([deleted]);
      return true;
    },

    /** Merges the update into the stored grid; returns null if the map is not in the session. */
    async updateGrid(
      sessionId: string,
      { mapId, ...update }: GridUpdate,
    ): Promise<{ version: number; grid: GridSettings } | null> {
      return prisma.$transaction(async (tx) => {
        const map = await tx.map.findFirst({ where: { id: mapId, sessionId } });
        if (!map) return null;
        const grid = applyGridUpdate(gridOf(map), update);
        await tx.map.update({
          where: { id: mapId },
          data: {
            gridScale: grid.scale,
            gridOffsetX: grid.offsetX,
            gridOffsetY: grid.offsetY,
            gridVisible: grid.visible,
            gridSnap: grid.snap,
          },
        });
        const { version } = await bumpVersion(tx, sessionId);
        return { version, grid };
      });
    },
  };
}
