import { describe, expect, it } from 'vitest';
import { segmentIntersectsRect, type Rect } from './obstacle';
import type { Point } from './token';
import {
  fogUpdateSchema,
  inAnyPolygon,
  partyVision,
  pointInPolygon,
  polygonTouchesRect,
  visibilityPolygon,
  visionRadiusPx,
} from './vision';

const area = (polygon: Point[]) => {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
};

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});
const visible = (source: Point, radius: number, blockers: Rect[], p: Point) =>
  pointInPolygon(p, visibilityPolygon(source, radius, blockers));

describe('visibilityPolygon in the open', () => {
  const source = { x: 400, y: 300 };

  it('is a circle: right size, right distance from the centre', () => {
    const polygon = visibilityPolygon(source, 200, []);
    expect(area(polygon) / (Math.PI * 200 * 200)).toBeGreaterThan(0.995);
    expect(area(polygon) / (Math.PI * 200 * 200)).toBeLessThan(1.001);
    for (const p of polygon) {
      expect(Math.hypot(p.x - source.x, p.y - source.y)).toBeGreaterThan(199);
      expect(Math.hypot(p.x - source.x, p.y - source.y)).toBeLessThan(200.1);
    }
  });

  it('is small for few vertices: it gets sent to every client', () => {
    expect(visibilityPolygon(source, 200, []).length).toBeLessThanOrEqual(65);
  });

  it('contains the source and a ring of points inside the radius, but not outside it', () => {
    const polygon = visibilityPolygon(source, 200, []);
    expect(pointInPolygon(source, polygon)).toBe(true);
    expect(pointInPolygon({ x: 590, y: 300 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 610, y: 300 }, polygon)).toBe(false);
    expect(pointInPolygon({ x: 400, y: 505 }, polygon)).toBe(false);
  });

  it('is nothing for a radius of zero', () => {
    expect(visibilityPolygon(source, 0, [])).toEqual([]);
  });

  it('counts "N cells" as reaching the edge of the N-th cell', () => {
    expect(visionRadiusPx(6, 70)).toBe(455);
    expect(visible({ x: 35, y: 35 }, visionRadiusPx(6, 70), [], { x: 35 + 6 * 70, y: 35 })).toBe(
      true,
    );
    expect(visible({ x: 35, y: 35 }, visionRadiusPx(6, 70), [], { x: 35 + 7 * 70, y: 35 })).toBe(
      false,
    );
  });
});

describe('visibilityPolygon with obstacles', () => {
  const source = { x: 100, y: 100 };

  it('hides what is behind a wall and shows what is beside it', () => {
    const wall = [rect(150, 0, 20, 200)]; // a vertical wall that ends at y = 200
    expect(visible(source, 500, wall, { x: 130, y: 100 })).toBe(true); // in front of it
    expect(visible(source, 500, wall, { x: 250, y: 100 })).toBe(false); // directly behind it
    expect(visible(source, 500, wall, { x: 250, y: 150 })).toBe(false);
    expect(visible(source, 500, wall, { x: 120, y: 300 })).toBe(true); // below its end
    expect(visible(source, 500, wall, { x: 250, y: 480 })).toBe(true); // lower down: the ray clears the end
  });

  it('puts the edge of the shadow exactly along the line through the wall corner', () => {
    const wall = [rect(150, 0, 20, 200)];
    // the line from (100,100) through the corner (150,200) has slope 2: at x = 250 it is at y = 400
    expect(visible(source, 600, wall, { x: 250, y: 380 })).toBe(false);
    expect(visible(source, 600, wall, { x: 250, y: 420 })).toBe(true);
  });

  it('is cut short by a wall in front of the radius, and does not see through it', () => {
    const polygon = visibilityPolygon(source, 300, [rect(150, -1000, 20, 2000)]);
    expect(Math.max(...polygon.filter((p) => p.x < 160).map((p) => p.x))).toBeLessThanOrEqual(
      150.1,
    );
    expect(pointInPolygon({ x: 200, y: 100 }, polygon)).toBe(false);
  });

  it('lets light through a one-cell doorway and into the room behind it', () => {
    const wall = [rect(150, 0, 20, 100), rect(150, 170, 20, 200)]; // a gap between y = 100 and y = 170
    expect(visible(source, 500, wall, { x: 300, y: 135 })).toBe(true);
    expect(visible(source, 500, wall, { x: 300, y: 60 })).toBe(false);
    expect(visible(source, 500, wall, { x: 300, y: 260 })).toBe(true); // the light spreads out behind the gap
    expect(visible(source, 500, wall, { x: 300, y: 330 })).toBe(false); // steeper than the gap allows
  });

  it('leaks nothing through a seam between touching rectangles', () => {
    const wall = [rect(150, 0, 20, 100), rect(150, 100, 20, 100)]; // one wall made of two pieces
    expect(visible({ x: 50, y: 100 }, 500, wall, { x: 300, y: 100 })).toBe(false); // right along the seam
    expect(visible({ x: 50, y: 100 }, 500, wall, { x: 300, y: 101 })).toBe(false);
    expect(visible({ x: 50, y: 100 }, 500, wall, { x: 300, y: 99 })).toBe(false);
  });

  it('leaks nothing through the point where two rectangles touch diagonally', () => {
    const wall = [rect(150, 0, 50, 100), rect(200, 100, 50, 100)]; // corners meet at (200, 100)
    // the line from (100, 200) through the shared corner continues to (300, 0)
    expect(visible({ x: 100, y: 200 }, 600, wall, { x: 300, y: 0 })).toBe(false);
    expect(visible({ x: 100, y: 200 }, 600, wall, { x: 260, y: 40 })).toBe(false);
  });

  it('handles walls that cross or overlap: the inner corners cast shadows too', () => {
    // a plus sign made of two overlapping bars, seen from the lower left
    const plus = [rect(200, 100, 100, 20), rect(240, 60, 20, 100)];
    const source = { x: 120, y: 200 };
    // just outside the inner corner (240, 120) on the visible side, and just behind it
    expect(visible(source, 600, plus, { x: 238, y: 122 })).toBe(true);
    expect(visible(source, 600, plus, { x: 262, y: 118 })).toBe(false);
    expect(visible(source, 600, plus, { x: 300, y: 80 })).toBe(false);
  });

  it('is not blinded by a wall it stands inside of', () => {
    const around = [rect(80, 80, 40, 40)]; // built over the source
    expect(visible(source, 300, around, { x: 250, y: 100 })).toBe(true);
    expect(visible(source, 300, [...around, rect(200, 0, 20, 300)], { x: 250, y: 100 })).toBe(
      false,
    ); // other walls still count
  });

  it('ignores obstacles beyond the radius and gives the same polygon as without them', () => {
    const far = [rect(900, 900, 50, 50), rect(-500, 0, 20, 20)];
    expect(visibilityPolygon(source, 200, far)).toEqual(visibilityPolygon(source, 200, []));
  });

  it('keeps one polygon per source and drops sources without any radius', () => {
    const polygons = partyVision(
      [
        { x: 100, y: 100 },
        { x: 600, y: 100 },
      ],
      120,
      [rect(340, 0, 20, 300)],
    );
    expect(polygons).toHaveLength(2);
    expect(inAnyPolygon({ x: 160, y: 100 }, polygons)).toBe(true);
    expect(inAnyPolygon({ x: 540, y: 100 }, polygons)).toBe(true); // seen by the second source
    expect(inAnyPolygon({ x: 350, y: 100 }, polygons)).toBe(false); // the wall itself, 250 away from both
    expect(partyVision([source], 0, [])).toEqual([]);
  });
});

describe('visibilityPolygon agrees with a plain line-of-sight check', () => {
  // A small deterministic random generator, so that a failure can be reproduced.
  const generator = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const MARGIN = 0.6; // px: points this close to a sight-line grazing a wall may go either way

  const inflate = (r: Rect, by: number): Rect =>
    rect(r.x - by, r.y - by, r.width + 2 * by, r.height + 2 * by);
  const blocked = (from: Point, to: Point, rects: Rect[], by: number) =>
    rects.some((r) => segmentIntersectsRect(from, to, inflate(r, by)));

  it('on thousands of random scenes', () => {
    const next = generator(12345);
    let checked = 0;
    for (let scene = 0; scene < 120; scene++) {
      const rects: Rect[] = [];
      for (let i = Math.floor(next() * 14); i >= 0; i--) {
        rects.push(rect(next() * 700, next() * 500, 20 + next() * 160, 20 + next() * 160));
      }
      let source: Point;
      do source = { x: 100 + next() * 600, y: 100 + next() * 400 };
      while (
        rects.some(
          (r) =>
            source.x >= r.x - 2 &&
            source.x <= r.x + r.width + 2 &&
            source.y >= r.y - 2 &&
            source.y <= r.y + r.height + 2,
        )
      );
      const radius = 100 + next() * 300;
      const polygon = visibilityPolygon(source, radius, rects);

      for (let k = 0; k < 120; k++) {
        const p = {
          x: source.x + (next() - 0.5) * 2 * radius * 1.2,
          y: source.y + (next() - 0.5) * 2 * radius * 1.2,
        };
        const distance = Math.hypot(p.x - source.x, p.y - source.y);
        const inside = pointInPolygon(p, polygon);
        const clearWithMargin = !blocked(source, p, rects, MARGIN);
        const surelyBlocked = blocked(source, p, rects, -MARGIN);
        if (distance <= radius - 1 && clearWithMargin) {
          expect(inside, `scene ${scene}: a clearly visible point is missing`).toBe(true);
          checked++;
        } else if (distance >= radius + 1 || surelyBlocked) {
          expect(inside, `scene ${scene}: a point that cannot be seen is inside`).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(8000);
  });

  it('on grid-aligned scenes, as the game builds them (cells of 70 px, walls on cell edges)', () => {
    const next = generator(777);
    let checked = 0;
    for (let scene = 0; scene < 60; scene++) {
      const rects: Rect[] = [];
      for (let i = Math.floor(next() * 25) + 3; i >= 0; i--) {
        rects.push(
          rect(
            Math.floor(next() * 14) * 70,
            Math.floor(next() * 10) * 70,
            (1 + Math.floor(next() * 4)) * 70,
            70,
          ),
        );
        if (next() < 0.4)
          rects.push(
            rect(
              Math.floor(next() * 14) * 70,
              Math.floor(next() * 10) * 70,
              70,
              (1 + Math.floor(next() * 4)) * 70,
            ),
          );
      }
      let source: Point;
      do
        source = {
          x: (Math.floor(next() * 14) + 0.5) * 70,
          y: (Math.floor(next() * 10) + 0.5) * 70,
        };
      while (
        rects.some(
          (r) =>
            source.x > r.x &&
            source.x < r.x + r.width &&
            source.y > r.y &&
            source.y < r.y + r.height,
        )
      );
      const radius = visionRadiusPx(2 + Math.floor(next() * 6), 70);
      const polygon = visibilityPolygon(source, radius, rects);
      const around = rects.filter(
        (r) =>
          !(
            source.x > r.x &&
            source.x < r.x + r.width &&
            source.y > r.y &&
            source.y < r.y + r.height
          ),
      );

      for (let col = 0; col < 14; col++) {
        for (let row = 0; row < 10; row++) {
          const centre = { x: (col + 0.5) * 70, y: (row + 0.5) * 70 };
          const distance = Math.hypot(centre.x - source.x, centre.y - source.y);
          const inside = pointInPolygon(centre, polygon);
          if (distance <= radius - 1 && !blocked(source, centre, around, MARGIN)) {
            expect(inside, `scene ${scene}, cell ${col},${row}`).toBe(true);
            checked++;
          } else if (distance >= radius + 1 || blocked(source, centre, around, -MARGIN)) {
            expect(inside, `scene ${scene}, cell ${col},${row}`).toBe(false);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});

describe('polygon questions', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('knows what is inside', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
    expect(pointInPolygon({ x: 50, y: -1 }, square)).toBe(false);
    expect(pointInPolygon({ x: 50, y: 50 }, [])).toBe(false);
  });

  it('knows which rectangles touch it: crossing, covering, inside, and merely beside', () => {
    expect(polygonTouchesRect(square, rect(90, 90, 50, 50))).toBe(true); // overlapping a corner
    expect(polygonTouchesRect(square, rect(-50, -50, 300, 300))).toBe(true); // covering all of it
    expect(polygonTouchesRect(square, rect(40, 40, 20, 20))).toBe(true); // wholly inside
    expect(polygonTouchesRect(square, rect(100, 40, 20, 20))).toBe(true); // touching the border
    expect(polygonTouchesRect(square, rect(101, 40, 20, 20))).toBe(false);
    expect(polygonTouchesRect(square, rect(-60, 40, 50, 20))).toBe(false);
    expect(polygonTouchesRect([], rect(0, 0, 10, 10))).toBe(false);
  });

  it('sees a wall whose face is lit, and not one behind another wall', () => {
    const front = rect(150, 0, 20, 200);
    const behind = rect(300, 0, 20, 200);
    const polygon = visibilityPolygon({ x: 100, y: 100 }, 500, [front, behind]);
    expect(polygonTouchesRect(polygon, front)).toBe(true);
    expect(polygonTouchesRect(polygon, behind)).toBe(false);
  });
});

describe('fogUpdateSchema', () => {
  it.each([[{ enabled: true }], [{ radius: 6.5 }], [{ enabled: false, radius: 1 }], [{}]])(
    'accepts %j',
    (patch) => {
      expect(fogUpdateSchema.safeParse({ mapId: 'm', ...patch }).success).toBe(true);
    },
  );

  it.each([
    [{ radius: 0 }],
    [{ radius: 31 }],
    [{ radius: Number.NaN }],
    [{ enabled: 'yes' }],
    [{ mapId: '' }],
  ])('rejects %j', (patch) => {
    expect(fogUpdateSchema.safeParse({ mapId: 'm', ...patch }).success).toBe(false);
  });
});

describe('cost', () => {
  it('ten characters among two hundred obstacles take a fraction of a second', () => {
    const next = (
      (seed) => () =>
        (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
    )(99);
    const rects = Array.from({ length: 200 }, () =>
      rect(Math.floor(next() * 30) * 70, Math.floor(next() * 20) * 70, 70, 70),
    );
    const sources = Array.from({ length: 10 }, () => ({ x: next() * 2100, y: next() * 1400 }));
    const started = performance.now();
    for (let i = 0; i < 5; i++) partyVision(sources, visionRadiusPx(8, 70), rects);
    expect((performance.now() - started) / 5).toBeLessThan(250);
  });
});
