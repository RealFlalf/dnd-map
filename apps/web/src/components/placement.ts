import { MONSTER_ICONS, TOKEN_SIZE_MAX } from '@dnd-map/shared';
import type { PlacementSpec } from '../session/useSession';

/** Drag-and-drop payload type for dragging an icon from the palette onto the map. */
export const PALETTE_MIME = 'application/x-dnd-map-token';

export function serializePlacement(spec: PlacementSpec): string {
  return JSON.stringify(spec);
}

/** Drop data comes from outside our code (any page can drag anything), so it is validated. */
export function parsePlacement(raw: string): PlacementSpec | null {
  try {
    const value = JSON.parse(raw) as Partial<PlacementSpec>;
    const validIcon = MONSTER_ICONS.some((i) => i.id === value.icon);
    const validSize =
      Number.isInteger(value.size) && value.size! >= 1 && value.size! <= TOKEN_SIZE_MAX;
    if (!validIcon || !validSize || typeof value.visible !== 'boolean') return null;
    return { icon: value.icon!, size: value.size!, visible: value.visible };
  } catch {
    return null;
  }
}
