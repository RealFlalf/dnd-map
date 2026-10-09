import { describe, expect, it } from 'vitest';
import { clampLine, lineColor, lineDrawSchema, MAX_LINE_POINTS, thinLine } from './line';

const valid = (points: unknown) => lineDrawSchema.safeParse({ mapId: 'm', points }).success;

describe('lineDrawSchema', () => {
  it('takes x, y pairs, at least two points and not too many', () => {
    expect(valid([0, 0, 10, 10])).toBe(true);
    expect(valid([0, 0])).toBe(false);
    expect(valid([0, 0, 10])).toBe(false);
    expect(valid(Array.from({ length: MAX_LINE_POINTS * 2 }, (_, i) => i))).toBe(true);
    expect(valid(Array.from({ length: MAX_LINE_POINTS * 2 + 2 }, (_, i) => i))).toBe(false);
    expect(valid([0, 0, Number.NaN, 1])).toBe(false);
    expect(valid([0, 0, Infinity, 1])).toBe(false);
    expect(valid([0, 0, '1', 1])).toBe(false);
  });
});

describe('clampLine', () => {
  it('keeps every point inside the picture', () => {
    expect(clampLine([-5, 10.04, 120, -3, 50.06, 400], { width: 100, height: 200 })).toEqual([
      0, 10, 100, 0, 50.1, 200,
    ]);
  });
});

describe('thinLine', () => {
  it('drops points too close to the previous one but keeps both ends', () => {
    expect(thinLine([0, 0, 1, 0, 2, 0, 10, 0, 11, 0], 5)).toEqual([0, 0, 10, 0, 11, 0]);
    expect(thinLine([0, 0, 1, 1], 5)).toEqual([0, 0, 1, 1]);
  });

  it('fits a very long stroke into the limit, from start to end', () => {
    const long = Array.from({ length: 5000 }, (_, i) => [i * 10, 0]).flat();
    const thin = thinLine(long, 1);
    expect(thin.length / 2).toBeLessThanOrEqual(MAX_LINE_POINTS);
    expect(thin.slice(0, 2)).toEqual([0, 0]);
    expect(thin.slice(-2)).toEqual([49990, 0]);
  });
});

describe('lineColor', () => {
  it('gives the master a colour of their own and each player a stable one', () => {
    const master = lineColor({ authorId: 'a', byMaster: true });
    const player = lineColor({ authorId: 'a', byMaster: false });
    expect(master).not.toBe(player);
    expect(lineColor({ authorId: 'a', byMaster: false })).toBe(player);
    const colours = new Set(
      Array.from({ length: 50 }, (_, i) => lineColor({ authorId: `p${i}`, byMaster: false })),
    );
    expect(colours.size).toBeGreaterThan(1);
    expect(colours.has(master)).toBe(false);
  });
});
