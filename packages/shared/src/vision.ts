import { z } from 'zod';
import { pointRectDistance, segmentIntersectsRect, type Rect } from './obstacle';
import type { Point } from './token';

export const FOG_RADIUS_MIN = 1;
export const FOG_RADIUS_MAX = 30;
export const FOG_RADIUS_DEFAULT = 6;

/** Fog of war of one map, as set by the master. */
export interface FogSettings {
  enabled: boolean;
  /** How many cells the party sees from each character. */
  radius: number;
}

/**
 * Fog of war as sent to a client. `polygons` is what the party sees right now (empty without fog);
 * a player's tokens and obstacles are already filtered to it, the polygons only tell the client
 * where to leave the fog open.
 */
export interface FogState extends FogSettings {
  polygons: Point[][];
}

const id = z.string().min(1).max(64);

export const fogUpdateSchema = z.object({
  mapId: id,
  enabled: z.boolean().optional(),
  radius: z.number().min(FOG_RADIUS_MIN).max(FOG_RADIUS_MAX).optional(),
});
export type FogUpdate = z.input<typeof fogUpdateSchema>;

/**
 * "Sees N cells" means every cell up to N steps away is seen whole: the vision circle reaches
 * half a cell beyond the centre of the N-th cell (so a token standing there is never on the border).
 */
export const visionRadiusPx = (cells: number, cellSize: number) => (cells + 0.5) * cellSize;

// ---------------------------------------------------------------------------------------------
// Visibility polygon: what a point can see within a radius, given rectangles that block sight.
// ---------------------------------------------------------------------------------------------

/** Rays are sent just beside every corner so that the shadow edges come out sharp. */
const CORNER_EPSILON = 1e-4;
/** The circle is approximated by chords this many radians apart (the sag is 0.14% of the radius). */
const ARC_STEP = (6 * Math.PI) / 180;
const TWO_PI = Math.PI * 2;

/** Where a ray from (ox, oy) in direction (dx, dy) first enters the rectangle; null if it never does. */
function rayRectEntry(ox: number, oy: number, dx: number, dy: number, r: Rect): number | null {
  let near = 0;
  let far = Infinity;
  for (const [o, d, min, max] of [
    [ox, dx, r.x, r.x + r.width],
    [oy, dy, r.y, r.y + r.height],
  ] as const) {
    if (d === 0) {
      if (o < min || o > max) return null;
    } else {
      let t1 = (min - o) / d;
      let t2 = (max - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      near = Math.max(near, t1);
      far = Math.min(far, t2);
      if (near > far) return null;
    }
  }
  return near;
}

const corners = (r: Rect): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.width, y: r.y },
  { x: r.x, y: r.y + r.height },
  { x: r.x + r.width, y: r.y + r.height },
];

/** The rectangle two rectangles share, or null if they do not overlap. */
function overlapOf(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}

const normalizeAngle = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/** Angles at which a rectangle's edges cross the vision circle. */
function circleCrossings(source: Point, radius: number, r: Rect): number[] {
  const angles: number[] = [];
  const edges: Array<[Point, Point]> = [
    [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y },
    ],
    [
      { x: r.x + r.width, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
    ],
    [
      { x: r.x + r.width, y: r.y + r.height },
      { x: r.x, y: r.y + r.height },
    ],
    [
      { x: r.x, y: r.y + r.height },
      { x: r.x, y: r.y },
    ],
  ];
  for (const [a, b] of edges) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const fx = a.x - source.x;
    const fy = a.y - source.y;
    const qa = dx * dx + dy * dy;
    const qb = 2 * (fx * dx + fy * dy);
    const qc = fx * fx + fy * fy - radius * radius;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) continue;
    const root = Math.sqrt(disc);
    for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
      if (t < 0 || t > 1) continue;
      angles.push(Math.atan2(a.y + t * dy - source.y, a.x + t * dx - source.x));
    }
  }
  return angles;
}

const strictlyInside = (p: Point, r: Rect) =>
  p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The area visible from `source` within `radius`, as a polygon around the source (angles ascending,
 * so all polygons have the same orientation and a set of them can be drawn as one union).
 *
 * `blockers` are rectangles that stop the line of sight. One the source stands inside of is
 * ignored, so that a character is not blinded by a wall that was built around it. Rectangles that
 * only touch each other leave no gap: a ray along the seam hits both.
 */
export function visibilityPolygon(
  source: Point,
  radius: number,
  blockers: readonly Rect[],
): Point[] {
  if (!(radius > 0)) return [];
  const relevant = blockers.filter(
    (r) => !strictlyInside(source, r) && pointRectDistance(source, r) <= radius,
  );

  const angles: number[] = [];
  for (let a = 0; a < TWO_PI; a += ARC_STEP) angles.push(a);
  for (const r of relevant) {
    for (const c of corners(r)) {
      if (Math.hypot(c.x - source.x, c.y - source.y) > radius) continue; // its shadow starts outside
      const a = Math.atan2(c.y - source.y, c.x - source.x);
      angles.push(a - CORNER_EPSILON, a, a + CORNER_EPSILON);
    }
    for (const a of circleCrossings(source, radius, r)) {
      angles.push(a - CORNER_EPSILON, a, a + CORNER_EPSILON);
    }
  }
  // Where two rectangles overlap, their edges cross at points that are corners of neither (the
  // inner corners of a cross or an L made of overlapping walls); the shadow changes there too.
  for (let i = 0; i < relevant.length; i++) {
    for (let j = i + 1; j < relevant.length; j++) {
      const overlap = overlapOf(relevant[i]!, relevant[j]!);
      if (!overlap) continue;
      for (const c of corners(overlap)) {
        if (Math.hypot(c.x - source.x, c.y - source.y) > radius) continue;
        const angle = Math.atan2(c.y - source.y, c.x - source.x);
        angles.push(angle - CORNER_EPSILON, angle, angle + CORNER_EPSILON);
      }
    }
  }

  const sorted = [...new Set(angles.map(normalizeAngle))].sort((a, b) => a - b);
  const points = sorted.map((angle) => {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let reach = radius;
    for (const r of relevant) {
      const t = rayRectEntry(source.x, source.y, dx, dy, r);
      if (t !== null && t < reach) reach = t;
    }
    return { x: round1(source.x + dx * reach), y: round1(source.y + dy * reach) };
  });

  return simplify(points);
}

const sameSpot = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05;

/** Whether `b` lies on the straight line from `a` to `c` (within a fraction of a pixel), between them. */
function onTheWay(a: Point, b: Point, c: Point): boolean {
  const dx = c.x - a.x;
  const dy = c.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return true;
  const offLine = Math.abs(dx * (b.y - a.y) - dy * (b.x - a.x)) / length;
  return offLine <= 0.15 && (b.x - a.x) * (b.x - c.x) + (b.y - a.y) * (b.y - c.y) <= 0;
}

/**
 * Drops points that add nothing: repeats (rays beside a corner land on the same spot) and points
 * on the straight line between their neighbours (a lit wall face, hit by many rays). Done in one
 * pass with a stack, so that a run of collinear points collapses to its two ends: judging every
 * point by neighbours that are themselves being removed would eat the corners as well.
 */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length > 0 && sameSpot(out[out.length - 1]!, p)) continue;
    while (out.length >= 2 && onTheWay(out[out.length - 2]!, out[out.length - 1]!, p)) out.pop();
    out.push(p);
  }
  // The polygon is closed: the same clean-up across the join of the last and the first point.
  for (let changed = true; changed && out.length >= 3;) {
    changed = false;
    if (sameSpot(out[0]!, out[out.length - 1]!)) {
      out.pop();
      changed = true;
    } else if (onTheWay(out[out.length - 1]!, out[0]!, out[1]!)) {
      out.shift();
      changed = true;
    } else if (onTheWay(out[out.length - 2]!, out[out.length - 1]!, out[0]!)) {
      out.pop();
      changed = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Questions about polygons
// ---------------------------------------------------------------------------------------------

/** Even-odd test. Points exactly on the border may go either way. */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export const inAnyPolygon = (p: Point, polygons: readonly Point[][]) =>
  polygons.some((polygon) => pointInPolygon(p, polygon));

/** Whether any part of the rectangle lies in (or on the border of) the polygon. */
export function polygonTouchesRect(polygon: readonly Point[], r: Rect): boolean {
  if (polygon.length < 3) return false;
  for (let i = 0; i < polygon.length; i++) {
    if (segmentIntersectsRect(polygon[i]!, polygon[(i + 1) % polygon.length]!, r)) return true;
  }
  return pointInPolygon({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, polygon);
}

/** What the party sees: a polygon for every vision source. */
export function partyVision(
  sources: readonly Point[],
  radius: number,
  blockers: readonly Rect[],
): Point[][] {
  return sources.map((s) => visibilityPolygon(s, radius, blockers)).filter((p) => p.length >= 3);
}
