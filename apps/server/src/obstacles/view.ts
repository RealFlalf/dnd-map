import type { ObstacleView } from '@dnd-map/shared';
import type { Obstacle } from '@prisma/client';

export function toObstacleView(o: Obstacle): ObstacleView {
  return {
    id: o.id,
    mapId: o.mapId,
    kind: o.kind,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    blocksMovement: o.blocksMovement,
    blocksSight: o.blocksSight,
  };
}
