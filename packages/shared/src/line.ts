import { z } from 'zod';
import type { ActionResult } from './map';

/**
 * Temporary lines: anyone at the table sketches over the map ("go round here", "the dragon is
 * there"), and the line fades away by itself. They are never stored and carry no version: the
 * server only keeps the live ones in memory, so someone who reconnects still sees them.
 */

/** How long a line lives unless the server is configured otherwise (`LINE_TTL_SECONDS`). */
export const DEFAULT_LINE_TTL_MS = 30_000;
/** The last part of its life a line spends fading out. */
export const LINE_FADE_MS = 3_000;
/** Points per line; the client thins out a long stroke before sending. */
export const MAX_LINE_POINTS = 500;
/** Lines one participant may have on the map at once. */
export const MAX_LINES_PER_PARTICIPANT = 30;

const coordinate = z.number().finite().min(-1e6).max(1e6);

/** `points` is flat — x0, y0, x1, y1, … — in source-image pixels, like everything on the map. */
export const lineDrawSchema = z.object({
  mapId: z.string().min(1).max(64),
  points: z
    .array(coordinate)
    .min(4)
    .max(MAX_LINE_POINTS * 2)
    .refine((points) => points.length % 2 === 0, 'points come in x, y pairs'),
});
export type LineDraw = z.input<typeof lineDrawSchema>;

export interface LineView {
  id: string;
  mapId: string;
  authorId: string;
  /** The master's lines have a colour of their own. */
  byMaster: boolean;
  points: number[];
  /**
   * How much longer the line lives, in milliseconds, as of sending. Relative, so a client with a
   * wrong clock still removes it on time.
   */
  ttlMs: number;
}

export type LineResult = ActionResult<{ line: LineView }>;

const MASTER_LINE_COLOR = '#e53935';
const PLAYER_LINE_COLORS = ['#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#fdd835'];

/** The same participant always draws in the same colour, on every screen. */
export function lineColor(line: Pick<LineView, 'authorId' | 'byMaster'>): string {
  if (line.byMaster) return MASTER_LINE_COLOR;
  let hash = 0;
  for (const ch of line.authorId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PLAYER_LINE_COLORS[hash % PLAYER_LINE_COLORS.length]!;
}

/** Keeps the line on the map: every point is moved inside the picture, to a tenth of a pixel. */
export function clampLine(points: readonly number[], map: { width: number; height: number }) {
  return points.map((value, i) => {
    const limit = i % 2 === 0 ? map.width : map.height;
    return Math.round(Math.min(limit, Math.max(0, value)) * 10) / 10;
  });
}

/**
 * Drops points closer than `minDistance` to the last kept one (the end is always kept), and if the
 * stroke is still too long keeps every n-th point. Used by the client while drawing.
 */
export function thinLine(points: readonly number[], minDistance: number): number[] {
  if (points.length <= 4) return [...points];
  const kept = [points[0]!, points[1]!];
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i]! - kept[kept.length - 2]!;
    const dy = points[i + 1]! - kept[kept.length - 1]!;
    if (dx * dx + dy * dy >= minDistance * minDistance) kept.push(points[i]!, points[i + 1]!);
  }
  kept.push(points[points.length - 2]!, points[points.length - 1]!);
  const pairs = kept.length / 2;
  if (pairs <= MAX_LINE_POINTS) return kept;
  const step = Math.ceil(pairs / (MAX_LINE_POINTS - 1));
  const sparse: number[] = [];
  for (let p = 0; p < pairs - 1; p += step) sparse.push(kept[p * 2]!, kept[p * 2 + 1]!);
  sparse.push(kept[kept.length - 2]!, kept[kept.length - 1]!);
  return sparse;
}
