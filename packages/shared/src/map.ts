import { z } from 'zod';
import type { ObstacleView } from './obstacle';
import type { FogState } from './vision';
import type { TokenView } from './token';

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 8000;
export const MAX_MAPS_PER_SESSION = 20;

export const GRID_SCALE_MIN = 8;
export const GRID_SCALE_MAX = 500;
export const GRID_SCALE_DEFAULT = 70;

/** All lengths are in pixels of the source image. */
export interface GridSettings {
  scale: number;
  offsetX: number;
  offsetY: number;
  visible: boolean;
  snap: boolean;
}

export interface MapView {
  id: string;
  imageUrl: string;
  /** Downscaled copy (max 2048 px) for phones and thumbnails. */
  previewUrl: string;
  width: number;
  height: number;
  grid: GridSettings;
}

/** Everything a client needs to draw the session; sent in full on join and on structural changes. */
export interface SessionState {
  /** Incremented by the server on every state change. */
  version: number;
  currentMapId: string | null;
  maps: MapView[];
  /** Tokens on the current map, as the receiving role may see them (players never get hidden monsters). */
  tokens: TokenView[];
  /** Obstacles on the current map. */
  obstacles: ObstacleView[];
  /** Fog of war of the current map; with fog on, a player's tokens and obstacles are limited to what is in view. */
  fog: FogState;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Keeps the scale in range and the offset inside one cell, so equal grids compare equal. */
export function normalizeGrid(grid: GridSettings): GridSettings {
  const scale = clamp(grid.scale, GRID_SCALE_MIN, GRID_SCALE_MAX);
  const wrap = (offset: number) => ((offset % scale) + scale) % scale;
  return { ...grid, scale, offsetX: wrap(grid.offsetX), offsetY: wrap(grid.offsetY) };
}

const coordinate = z.number().min(-1_000_000).max(1_000_000);

export const gridUpdateSchema = z.object({
  mapId: z.string().min(1).max(64),
  scale: z.number().min(GRID_SCALE_MIN).max(GRID_SCALE_MAX).optional(),
  offsetX: coordinate.optional(),
  offsetY: coordinate.optional(),
  visible: z.boolean().optional(),
  snap: z.boolean().optional(),
});
export type GridUpdate = z.input<typeof gridUpdateSchema>;

export function applyGridUpdate(
  grid: GridSettings,
  update: Omit<GridUpdate, 'mapId'>,
): GridSettings {
  return normalizeGrid({
    scale: update.scale ?? grid.scale,
    offsetX: update.offsetX ?? grid.offsetX,
    offsetY: update.offsetY ?? grid.offsetY,
    visible: update.visible ?? grid.visible,
    snap: update.snap ?? grid.snap,
  });
}

export const mapRefSchema = z.object({ mapId: z.string().min(1).max(64) });
export type MapRef = z.input<typeof mapRefSchema>;

export type ActionError =
  | 'not_joined'
  | 'forbidden'
  | 'invalid_request'
  | 'map_not_found'
  | 'token_not_found'
  | 'too_many_tokens'
  | 'already_placed'
  | 'participant_not_found'
  | 'obstacle_not_found'
  | 'too_many_obstacles'
  /** The move would end in an obstacle or cross one. */
  | 'blocked'
  /** Too many requests from this connection; slow down. */
  | 'rate_limited'
  /** Produced by the client itself when there is no connection; the server never sends it. */
  | 'offline'
  | 'internal';
export type ActionResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: ActionError };

export type GridUpdateResult = ActionResult<{ version: number; grid: GridSettings }>;

export interface GridChanged {
  version: number;
  mapId: string;
  grid: GridSettings;
}

/** Error codes of `POST /api/sessions/:inviteCode/maps` (HTTP body: `{ error }`). */
export type UploadError =
  | 'forbidden'
  | 'session_not_found'
  | 'empty_body'
  | 'invalid_image'
  | 'unsupported_format'
  | 'image_too_large'
  | 'too_many_maps';
