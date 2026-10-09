import {
  FOG_RADIUS_DEFAULT,
  inAnyPolygon,
  partyVision,
  visionRadiusPx,
  type FogSettings,
  type FogState,
  type GridSettings,
  type ObstacleView,
  type Point,
  type Role,
  type TokenView,
} from '@dnd-map/shared';

export const NO_FOG: FogState = { enabled: false, radius: FOG_RADIUS_DEFAULT, polygons: [] };

export interface MapScene {
  grid: GridSettings;
  fog: FogSettings;
  tokens: readonly TokenView[];
  obstacles: readonly ObstacleView[];
}

/**
 * What the party sees right now: one polygon per character, limited by the fog radius and by the
 * obstacles that block sight. Without fog there is nothing to cut out, so no polygons.
 */
export function fogOf(scene: Pick<MapScene, 'grid' | 'fog'> & Partial<MapScene>): FogState {
  const { fog, grid } = scene;
  if (!fog.enabled) return { ...fog, polygons: [] };
  const sources: Point[] = (scene.tokens ?? []).filter((t) => t.type === 'player_character');
  const blockers = (scene.obstacles ?? []).filter((o) => o.blocksSight);
  return {
    ...fog,
    polygons: partyVision(sources, visionRadiusPx(fog.radius, grid.scale), blockers),
  };
}

/**
 * Whether players can see this token. A hidden monster never; with fog on also nothing out of
 * sight. Characters are always seen: they are what the party sees from.
 */
export function seenByPlayers(token: TokenView, fog: FogState): boolean {
  if (!token.visible) return false;
  return !fog.enabled || token.type === 'player_character' || inAnyPolygon(token, fog.polygons);
}

export interface SceneView {
  fog: FogState;
  tokens: TokenView[];
  obstacles: ObstacleView[];
}

/**
 * The map as one role may see it. The master sees everything (and the polygons, to preview the
 * fog); players get hidden monsters, and with fog on monsters out of sight, left out entirely.
 */
export function viewFor(role: Role, scene: MapScene): SceneView {
  const fog = fogOf(scene);
  if (role === 'master') {
    return { fog, tokens: [...scene.tokens], obstacles: [...scene.obstacles] };
  }
  return {
    fog,
    tokens: scene.tokens.filter((t) => seenByPlayers(t, fog)),
    obstacles: [...scene.obstacles], // the map and its walls are never hidden, only darkened
  };
}
