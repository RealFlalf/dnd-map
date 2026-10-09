import type { FogState, ObstacleView, TokenView } from '@dnd-map/shared';
import type { PrismaClient } from '@prisma/client';
import { gridOf } from '../db-utils';
import { toObstacleView } from '../obstacles/view';
import { toTokenView } from '../tokens/view';
import { fogOf, NO_FOG } from './view';

export type VisionService = ReturnType<typeof createVisionService>;

export function createVisionService(prisma: PrismaClient) {
  return {
    /**
     * Fog of the session's current map as it is right now, for deciding who is told what after a
     * change. Costs one query when the fog is off, which is the usual case.
     */
    async fogOf(sessionId: string): Promise<FogState> {
      const map = await prisma.map.findFirst({ where: { currentInSession: { id: sessionId } } });
      if (!map || !map.fogEnabled) return NO_FOG;

      const [characters, blockers] = await Promise.all([
        prisma.token.findMany({ where: { mapId: map.id, type: 'player_character' } }),
        prisma.obstacle.findMany({ where: { mapId: map.id, blocksSight: true } }),
      ]);
      return fogOf({
        grid: gridOf(map),
        fog: { enabled: true, radius: map.fogRadius },
        tokens: characters.map((t): TokenView => toTokenView(t)),
        obstacles: blockers.map((o): ObstacleView => toObstacleView(o)),
      });
    },
  };
}
