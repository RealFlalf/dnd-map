import type { TokenView } from '@dnd-map/shared';
import type { Token } from '@prisma/client';

export function toTokenView(t: Token): TokenView {
  return {
    id: t.id,
    mapId: t.mapId,
    type: t.type,
    ownerParticipantId: t.ownerParticipantId,
    name: t.name,
    icon: t.iconUrl,
    x: t.x,
    y: t.y,
    size: t.size,
    visible: t.visibleToPlayers,
  };
}
