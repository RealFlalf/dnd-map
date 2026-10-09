import { z } from 'zod';
import type { ActionResult, GridSettings } from './map';
import type { Point } from './token';

export const MAX_OBSTACLES_PER_MAP = 500;

/** A token occupies this fraction of its footprint: 90% of the cells, so radius = 0.45 per cell. */
export const TOKEN_RADIUS_RATIO = 0.45;

export type ObstacleKind = 'wall' | 'pillar' | 'barrel';

export const OBSTACLE_KINDS: Readonly<
  Record<ObstacleKind, { label: string; blocksSight: boolean; singleCell: boolean }>
> = {
  wall: { label: 'Стена', blocksSight: true, singleCell: false },
  pillar: { label: 'Столб', blocksSight: true, singleCell: true },
  // You can look over a barrel, but not walk through it.
  barrel: { label: 'Бочка', blocksSight: false, singleCell: true },
};

/** Axis-aligned rectangle in source-image pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ObstacleView extends Rect {
  id: string;
  mapId: string;
  kind: ObstacleKind;
  blocksMovement: boolean;
  blocksSight: boolean;
}

/** Incremental change of the obstacles on the current map; same for every role. */
export interface ObstaclesPatch {
  version: number;
  upserted: ObstacleView[];
  removedIds: string[];
}

const coordinate = z.number().min(-1_000_000).max(1_000_000);
const id = z.string().min(1).max(64);
const point = z.object({ x: coordinate, y: coordinate });

export const obstacleAddSchema = z.object({
  mapId: id,
  kind: z.enum(['wall', 'pillar', 'barrel']),
  /** Two opposite corners (any points inside the first and the last cell); single-cell kinds use `from` only. */
  from: point,
  to: point,
  /** Defaults to what the kind does. */
  blocksSight: z.boolean().optional(),
});
export type ObstacleAdd = z.input<typeof obstacleAddSchema>;

export const obstacleRefSchema = z.object({ obstacleId: id });
export type ObstacleRef = z.input<typeof obstacleRefSchema>;

export const obstacleSightSchema = z.object({ obstacleId: id, blocksSight: z.boolean() });
export type ObstacleSight = z.input<typeof obstacleSightSchema>;

/** Moves an obstacle by whole cells; the server keeps it on the map. */
export const obstacleMoveSchema = z.object({
  obstacleId: id,
  dCol: z.number().int().min(-1000).max(1000),
  dRow: z.number().int().min(-1000).max(1000),
});
export type ObstacleMove = z.input<typeof obstacleMoveSchema>;

/** Obstacles that changed together with something else (the grid), without a version of their own. */
export interface ObstaclesDelta {
  upserted: ObstacleView[];
  removedIds: string[];
}

export const obstacleClearSchema = z.object({ mapId: id });
export type ObstacleClear = z.input<typeof obstacleClearSchema>;

export type ObstacleResult = ActionResult<{ version: number; obstacle: ObstacleView }>;
export type ObstacleRemoveResult = ActionResult<{ version: number }>;

// ---------------------------------------------------------------------------------------------
// Placing obstacles on the grid
// ---------------------------------------------------------------------------------------------

/**
 * The rectangle of whole grid cells from the cell under `a` to the cell under `b` (either order),
 * cut to the map. Returns null if nothing of it is left on the map.
 */
export function cellsRect(
  map: { width: number; height: number; grid: GridSettings },
  a: Point,
  b: Point,
  singleCell = false,
): Rect | null {
  const { scale, offsetX, offsetY } = map.grid;
  const index = (value: number, offset: number) => Math.floor((value - offset) / scale);
  const first = { col: index(a.x, offsetX), row: index(a.y, offsetY) };
  const last = singleCell ? first : { col: index(b.x, offsetX), row: index(b.y, offsetY) };

  const x0 = offsetX + Math.min(first.col, last.col) * scale;
  const y0 = offsetY + Math.min(first.row, last.row) * scale;
  const x1 = offsetX + (Math.max(first.col, last.col) + 1) * scale;
  const y1 = offsetY + (Math.max(first.row, last.row) + 1) * scale;

  const left = Math.max(0, x0);
  const top = Math.max(0, y0);
  const right = Math.min(map.width, x1);
  const bottom = Math.min(map.height, y1);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const hundredth = (value: number) => Math.round(value * 100) / 100;

/**
 * Obstacles live on grid cells: when the grid changes (cell size or offset), each one keeps its
 * cells and so grows, shrinks or shifts with them. What ends up outside the map is cut off, and
 * what is entirely outside is dropped. Returns only what changed.
 */
export function remapObstacles(
  map: { width: number; height: number },
  from: GridSettings,
  to: GridSettings,
  list: readonly ObstacleView[],
): ObstaclesDelta {
  const delta: ObstaclesDelta = { upserted: [], removedIds: [] };
  if (from.scale === to.scale && from.offsetX === to.offsetX && from.offsetY === to.offsetY) {
    return delta;
  }
  for (const o of list) {
    const col = (o.x - from.offsetX) / from.scale;
    const row = (o.y - from.offsetY) / from.scale;
    const x0 = to.offsetX + col * to.scale;
    const y0 = to.offsetY + row * to.scale;
    const x1 = x0 + (o.width / from.scale) * to.scale;
    const y1 = y0 + (o.height / from.scale) * to.scale;
    const left = hundredth(Math.max(0, x0));
    const top = hundredth(Math.max(0, y0));
    const right = hundredth(Math.min(map.width, x1));
    const bottom = hundredth(Math.min(map.height, y1));
    if (right <= left || bottom <= top) {
      delta.removedIds.push(o.id);
      continue;
    }
    const next = {
      x: left,
      y: top,
      width: hundredth(right - left),
      height: hundredth(bottom - top),
    };
    if (next.x !== o.x || next.y !== o.y || next.width !== o.width || next.height !== o.height) {
      delta.upserted.push({ ...o, ...next });
    }
  }
  return delta;
}

/**
 * The obstacle shifted by whole cells, held back where it would leave the map. Null if it cannot
 * move that way at all (so there is nothing to change).
 */
export function shiftObstacle(
  map: { width: number; height: number; grid: GridSettings },
  r: Rect,
  dCol: number,
  dRow: number,
): Rect | null {
  const { scale } = map.grid;
  const clampSteps = (steps: number, start: number, size: number, limit: number) => {
    const min = Math.ceil((0 - start) / scale - 1e-9);
    const max = Math.floor((limit - (start + size)) / scale + 1e-9);
    return min > max ? 0 : Math.max(min, Math.min(max, steps));
  };
  const cols = clampSteps(dCol, r.x, r.width, map.width);
  const rows = clampSteps(dRow, r.y, r.height, map.height);
  if (cols === 0 && rows === 0) return null;
  return {
    x: hundredth(r.x + cols * scale),
    y: hundredth(r.y + rows * scale),
    width: r.width,
    height: r.height,
  };
}

// ---------------------------------------------------------------------------------------------
// Collisions. A token is a disc; obstacles are rectangles.
// ---------------------------------------------------------------------------------------------

export const tokenRadius = (grid: GridSettings, size: number) =>
  size * grid.scale * TOKEN_RADIUS_RATIO;

/** Distance from a point to a rectangle (0 inside). */
export function pointRectDistance(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/** Distance from a point to a segment. */
function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether a segment passes through (or touches) a rectangle: the slab method. */
export function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean {
  let tMin = 0;
  let tMax = 1;
  for (const [from, delta, min, max] of [
    [a.x, b.x - a.x, r.x, r.x + r.width],
    [a.y, b.y - a.y, r.y, r.y + r.height],
  ] as const) {
    if (delta === 0) {
      if (from < min || from > max) return false; // parallel to the slab and outside it
    } else {
      let t1 = (min - from) / delta;
      let t2 = (max - from) / delta;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
  }
  return true;
}

/**
 * Smallest distance between a segment and a rectangle. Both are convex, so when they do not
 * overlap the closest points involve an end of the segment or a corner of the rectangle.
 */
export function segmentRectDistance(a: Point, b: Point, r: Rect): number {
  if (segmentIntersectsRect(a, b, r)) return 0;
  const corners: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x, y: r.y + r.height },
    { x: r.x + r.width, y: r.y + r.height },
  ];
  return Math.min(
    pointRectDistance(a, r),
    pointRectDistance(b, r),
    ...corners.map((c) => pointSegmentDistance(c, a, b)),
  );
}

/** A disc of `radius` at `p` overlaps the rectangle (merely touching does not count). */
export function discHitsRect(p: Point, radius: number, r: Rect): boolean {
  return pointRectDistance(p, r) < radius - EPSILON;
}

/** A disc moving in a straight line from `a` to `b` overlaps the rectangle at some moment. */
export function sweptDiscHitsRect(a: Point, b: Point, radius: number, r: Rect): boolean {
  return segmentRectDistance(a, b, r) < radius - EPSILON;
}

/** Floating point noise must not turn "exactly touching" into "blocked". */
const EPSILON = 1e-6;

export type MoveCheck =
  { ok: true } | { ok: false; obstacleId: string; reason: 'destination' | 'path' };

const walls = (obstacles: readonly ObstacleView[]) => obstacles.filter((o) => o.blocksMovement);

/** Can a token be put at `p` (a new token, or the end of a move)? */
export function canStandAt(
  p: Point,
  radius: number,
  obstacles: readonly ObstacleView[],
): MoveCheck {
  for (const o of walls(obstacles)) {
    if (discHitsRect(p, radius, o)) return { ok: false, obstacleId: o.id, reason: 'destination' };
  }
  return { ok: true };
}

/**
 * Can a token travel from `from` to `to` in a straight line? It may not end inside an obstacle
 * or cross one on the way. An obstacle that the token already overlaps at the start is ignored
 * on the way out, so a token that got a wall built around it can always leave.
 */
export function canMove(
  from: Point,
  to: Point,
  radius: number,
  obstacles: readonly ObstacleView[],
): MoveCheck {
  const destination = canStandAt(to, radius, obstacles);
  if (!destination.ok) return destination;
  for (const o of walls(obstacles)) {
    if (discHitsRect(from, radius, o)) continue;
    if (sweptDiscHitsRect(from, to, radius, o)) {
      return { ok: false, obstacleId: o.id, reason: 'path' };
    }
  }
  return { ok: true };
}

/** Whole-cell range of an obstacle as shown to people: "3–8 × 5" (columns × rows, from 1). */
export function describeCells(grid: GridSettings, o: Rect): string {
  const col1 = Math.floor((o.x - grid.offsetX) / grid.scale + EPSILON) + 1;
  const row1 = Math.floor((o.y - grid.offsetY) / grid.scale + EPSILON) + 1;
  const col2 = Math.ceil((o.x + o.width - grid.offsetX) / grid.scale - EPSILON);
  const row2 = Math.ceil((o.y + o.height - grid.offsetY) / grid.scale - EPSILON);
  const span = (a: number, b: number) => (a === b ? String(a) : `${a}–${b}`);
  return `${span(col1, col2)} × ${span(row1, row2)}`;
}
