import { describe, expect, it } from 'vitest';
import type { GridSettings } from './map';
import {
  canMove,
  canStandAt,
  cellsRect,
  describeCells,
  discHitsRect,
  obstacleAddSchema,
  OBSTACLE_KINDS,
  segmentIntersectsRect,
  segmentRectDistance,
  sweptDiscHitsRect,
  tokenRadius,
  type ObstacleView,
  type Rect,
} from './obstacle';

const grid: GridSettings = { scale: 70, offsetX: 0, offsetY: 0, visible: true, snap: true };
const map = { width: 700, height: 350, grid };

const obstacle = (rect: Rect, over: Partial<ObstacleView> = {}): ObstacleView => ({
  id: `o-${rect.x}-${rect.y}`,
  mapId: 'm',
  kind: 'wall',
  blocksMovement: true,
  blocksSight: true,
  ...rect,
  ...over,
});

describe('cellsRect', () => {
  it('covers whole cells from the first to the last, in any corner order', () => {
    const expected = { x: 140, y: 70, width: 210, height: 70 };
    expect(cellsRect(map, { x: 150, y: 80 }, { x: 330, y: 130 })).toEqual(expected);
    expect(cellsRect(map, { x: 330, y: 130 }, { x: 150, y: 80 })).toEqual(expected);
  });

  it('is one cell for a click, and for single-cell kinds whatever the second point is', () => {
    expect(cellsRect(map, { x: 150, y: 80 }, { x: 150, y: 80 })).toEqual({
      x: 140,
      y: 70,
      width: 70,
      height: 70,
    });
    expect(cellsRect(map, { x: 150, y: 80 }, { x: 600, y: 300 }, true)).toEqual({
      x: 140,
      y: 70,
      width: 70,
      height: 70,
    });
  });

  it('follows the grid offset', () => {
    const shifted = { ...map, grid: { ...grid, offsetX: 20, offsetY: 30 } };
    expect(cellsRect(shifted, { x: 25, y: 35 }, { x: 25, y: 35 })).toEqual({
      x: 20,
      y: 30,
      width: 70,
      height: 70,
    });
  });

  it('is cut to the map, and is null when nothing of it is on the map', () => {
    expect(cellsRect(map, { x: -100, y: -100 }, { x: 10, y: 10 })).toEqual({
      x: 0,
      y: 0,
      width: 70,
      height: 70,
    });
    expect(cellsRect(map, { x: 650, y: 300 }, { x: 900, y: 500 })).toEqual({
      x: 630,
      y: 280,
      width: 70,
      height: 70,
    });
    expect(cellsRect(map, { x: 800, y: 100 }, { x: 900, y: 120 })).toBeNull();
    expect(cellsRect(map, { x: -300, y: 100 }, { x: -200, y: 120 })).toBeNull();
  });

  it('keeps a partial cell at the map edge as a smaller rectangle', () => {
    const narrow = { width: 100, height: 100, grid };
    expect(cellsRect(narrow, { x: 80, y: 10 }, { x: 80, y: 10 })).toEqual({
      x: 70,
      y: 0,
      width: 30,
      height: 70,
    });
  });
});

describe('segment and rectangle', () => {
  const box: Rect = { x: 100, y: 100, width: 100, height: 100 };

  it('detects crossings, including a segment that starts or ends inside', () => {
    expect(segmentIntersectsRect({ x: 0, y: 150 }, { x: 300, y: 150 }, box)).toBe(true);
    expect(segmentIntersectsRect({ x: 150, y: 150 }, { x: 300, y: 300 }, box)).toBe(true);
    expect(segmentIntersectsRect({ x: 150, y: 150 }, { x: 160, y: 160 }, box)).toBe(true);
  });

  it('detects touching an edge or a corner, and misses parallel segments next to the box', () => {
    expect(segmentIntersectsRect({ x: 0, y: 100 }, { x: 300, y: 100 }, box)).toBe(true); // along the top edge
    expect(segmentIntersectsRect({ x: 0, y: 300 }, { x: 300, y: 0 }, box)).toBe(true); // through the corner (200, 100)
    expect(segmentIntersectsRect({ x: 0, y: 99 }, { x: 300, y: 99 }, box)).toBe(false);
    expect(segmentIntersectsRect({ x: 99, y: 0 }, { x: 99, y: 300 }, box)).toBe(false);
    expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 90, y: 90 }, box)).toBe(false);
  });

  it('measures the distance from the closest end, side or corner', () => {
    expect(segmentRectDistance({ x: 0, y: 150 }, { x: 50, y: 150 }, box)).toBe(50); // end to side
    expect(segmentRectDistance({ x: 0, y: 0 }, { x: 0, y: 300 }, box)).toBe(100); // side to side, parallel
    // a diagonal segment passing the corner (100, 100): closest point is (75, 75)
    expect(segmentRectDistance({ x: 150, y: 0 }, { x: 0, y: 150 }, box)).toBeCloseTo(
      Math.hypot(25, 25),
      6,
    );
    // the same line through the middle of the box touches it
    expect(segmentRectDistance({ x: 300, y: 0 }, { x: 0, y: 300 }, box)).toBe(0);
    expect(segmentRectDistance({ x: 0, y: 150 }, { x: 300, y: 150 }, box)).toBe(0);
  });
});

describe('discs against rectangles', () => {
  const wall: Rect = { x: 140, y: 0, width: 70, height: 350 }; // a vertical wall: column 3

  it('allows touching but not overlapping', () => {
    expect(discHitsRect({ x: 105, y: 100 }, 35, wall)).toBe(false); // exactly touching
    expect(discHitsRect({ x: 106, y: 100 }, 35, wall)).toBe(true);
    expect(discHitsRect({ x: 175, y: 100 }, 5, wall)).toBe(true); // inside
  });

  it('treats the corner as round: a disc may pass a corner at diagonal distance', () => {
    const pillar: Rect = { x: 140, y: 140, width: 70, height: 70 };
    // centre at distance sqrt(25^2+25^2)=35.36 from the corner (140, 140): free for r=35, blocked for r=36
    expect(discHitsRect({ x: 115, y: 115 }, 35, pillar)).toBe(false);
    expect(discHitsRect({ x: 115, y: 115 }, 36, pillar)).toBe(true);
  });

  it('blocks a path through the wall but not a path beside it', () => {
    expect(sweptDiscHitsRect({ x: 35, y: 100 }, { x: 245, y: 100 }, 31.5, wall)).toBe(true);
    expect(sweptDiscHitsRect({ x: 35, y: 100 }, { x: 105, y: 300 }, 31.5, wall)).toBe(false);
    // the disc grazes the wall: centre line 31.5 away from it
    expect(sweptDiscHitsRect({ x: 108.5, y: 0 }, { x: 108.5, y: 350 }, 31.5, wall)).toBe(false);
    expect(sweptDiscHitsRect({ x: 109, y: 0 }, { x: 109, y: 350 }, 31.5, wall)).toBe(true);
  });
});

describe('canStandAt and canMove', () => {
  const r = tokenRadius(grid, 1); // 31.5
  const wall = obstacle({ x: 140, y: 0, width: 70, height: 350 });
  const crate = obstacle(
    { x: 350, y: 140, width: 70, height: 70 },
    { kind: 'barrel', blocksSight: false },
  );

  it('uses 45% of a cell per size step as the token radius', () => {
    expect(r).toBeCloseTo(31.5, 9);
    expect(tokenRadius(grid, 2)).toBeCloseTo(63, 9);
  });

  it('refuses to stand in an obstacle, even partly, and allows the cell next to it', () => {
    expect(canStandAt({ x: 175, y: 100 }, r, [wall]).ok).toBe(false);
    expect(canStandAt({ x: 140 - 30, y: 100 }, r, [wall])).toEqual({
      ok: false,
      obstacleId: wall.id,
      reason: 'destination',
    });
    expect(canStandAt({ x: 105, y: 105 }, r, [wall]).ok).toBe(true); // the centre of the cell next to the wall
  });

  it('refuses to cross an obstacle on the way', () => {
    expect(canMove({ x: 105, y: 105 }, { x: 245, y: 105 }, r, [wall])).toEqual({
      ok: false,
      obstacleId: wall.id,
      reason: 'path',
    });
    expect(canMove({ x: 105, y: 105 }, { x: 105, y: 315 }, r, [wall]).ok).toBe(true);
  });

  it('lets a token leave an obstacle it is already in, but not end in another', () => {
    const inside = { x: 175, y: 105 };
    expect(canMove(inside, { x: 105, y: 105 }, r, [wall]).ok).toBe(true);
    expect(canMove(inside, { x: 175, y: 105 }, r, [wall]).ok).toBe(false); // staying put inside is still "ending inside"
    expect(canMove(inside, { x: 385, y: 175 }, r, [wall, crate]).ok).toBe(false); // would end in the crate
    expect(canMove(inside, { x: 315, y: 105 }, r, [wall, crate]).ok).toBe(true);
  });

  it('ignores obstacles that do not block movement', () => {
    const open = obstacle({ x: 140, y: 0, width: 70, height: 350 }, { blocksMovement: false });
    expect(canMove({ x: 105, y: 105 }, { x: 245, y: 105 }, r, [open]).ok).toBe(true);
  });

  it('lets a big token through only where it fits', () => {
    const doorway = [
      obstacle({ x: 140, y: 0, width: 70, height: 140 }),
      obstacle({ x: 140, y: 210, width: 70, height: 140 }),
    ]; // one cell (70 px) wide gap between y=140 and y=210
    expect(canMove({ x: 105, y: 175 }, { x: 245, y: 175 }, tokenRadius(grid, 1), doorway).ok).toBe(
      true,
    );
    expect(canMove({ x: 105, y: 175 }, { x: 245, y: 175 }, tokenRadius(grid, 2), doorway).ok).toBe(
      false,
    );
  });
});

describe('describeCells', () => {
  it('names columns and rows from 1, as the token list does', () => {
    expect(describeCells(grid, { x: 140, y: 70, width: 70, height: 70 })).toBe('3 × 2');
    expect(describeCells(grid, { x: 140, y: 70, width: 350, height: 70 })).toBe('3–7 × 2');
    expect(describeCells(grid, { x: 0, y: 0, width: 70, height: 210 })).toBe('1 × 1–3');
  });

  it('copes with a grid offset and rectangles cut at the map edge', () => {
    expect(describeCells({ ...grid, offsetX: 20 }, { x: 20, y: 0, width: 70, height: 70 })).toBe(
      '1 × 1',
    );
    expect(describeCells(grid, { x: 630, y: 280, width: 70, height: 70 })).toBe('10 × 5');
    expect(describeCells(grid, { x: 70, y: 0, width: 30, height: 70 })).toBe('2 × 1');
  });
});

describe('kinds and request schema', () => {
  it('lets walls and pillars hide what is behind them but not barrels', () => {
    expect(OBSTACLE_KINDS.wall.blocksSight).toBe(true);
    expect(OBSTACLE_KINDS.pillar.blocksSight).toBe(true);
    expect(OBSTACLE_KINDS.barrel.blocksSight).toBe(false);
  });

  const ok = { mapId: 'm', kind: 'wall', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } };

  it('accepts a wall request and an explicit sight flag', () => {
    expect(obstacleAddSchema.safeParse(ok).success).toBe(true);
    expect(obstacleAddSchema.safeParse({ ...ok, blocksSight: false }).success).toBe(true);
  });

  it.each([
    [{ kind: 'door' }],
    [{ from: { x: 'a', y: 1 } }],
    [{ to: { x: Number.NaN, y: 1 } }],
    [{ mapId: '' }],
    [{ blocksSight: 'yes' }],
  ])('rejects %j', (patch) => {
    expect(obstacleAddSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });

  it('does not let a client set the movement flag or the rectangle itself', () => {
    const parsed = obstacleAddSchema.parse({ ...ok, blocksMovement: false, x: 1, width: 5 });
    expect(parsed).not.toHaveProperty('blocksMovement');
    expect(parsed).not.toHaveProperty('x');
    expect(parsed).not.toHaveProperty('width');
  });
});
