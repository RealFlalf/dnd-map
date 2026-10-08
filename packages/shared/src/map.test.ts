import { describe, expect, it } from 'vitest';
import {
  applyGridUpdate,
  GRID_SCALE_MAX,
  GRID_SCALE_MIN,
  gridUpdateSchema,
  normalizeGrid,
  type GridSettings,
} from './map';

const grid: GridSettings = { scale: 70, offsetX: 10, offsetY: 20, visible: true, snap: true };

describe('normalizeGrid', () => {
  it('wraps offsets into one cell, including negative ones', () => {
    expect(normalizeGrid({ ...grid, scale: 40, offsetX: 130, offsetY: -10 })).toMatchObject({
      offsetX: 10,
      offsetY: 30,
    });
  });

  it('clamps the cell size to the allowed range', () => {
    expect(normalizeGrid({ ...grid, scale: 1 }).scale).toBe(GRID_SCALE_MIN);
    expect(normalizeGrid({ ...grid, scale: 9999 }).scale).toBe(GRID_SCALE_MAX);
  });

  it('is idempotent', () => {
    const once = normalizeGrid({ ...grid, scale: 33.3, offsetX: 500, offsetY: -77 });
    expect(normalizeGrid(once)).toEqual(once);
  });
});

describe('applyGridUpdate', () => {
  it('changes only the given fields', () => {
    expect(applyGridUpdate(grid, { visible: false })).toEqual({ ...grid, visible: false });
  });

  it('re-wraps the existing offset when the cell shrinks', () => {
    // An offset of 60 is valid for 70 px cells but must fold into a 50 px cell.
    expect(applyGridUpdate({ ...grid, offsetX: 60 }, { scale: 50 })).toMatchObject({
      scale: 50,
      offsetX: 10,
    });
  });

  it('is a no-op for an empty update', () => {
    expect(applyGridUpdate(grid, {})).toEqual(grid);
  });
});

describe('gridUpdateSchema', () => {
  it.each([
    [{ mapId: 'm', scale: GRID_SCALE_MIN - 1 }],
    [{ mapId: 'm', scale: GRID_SCALE_MAX + 1 }],
    [{ mapId: 'm', offsetX: Number.NaN }],
    [{ mapId: 'm', offsetY: 2_000_000 }],
    [{ mapId: '' }],
    [{ scale: 50 }],
  ])('rejects %j', (input) => {
    expect(gridUpdateSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a partial update', () => {
    expect(gridUpdateSchema.safeParse({ mapId: 'm', snap: false }).success).toBe(true);
  });
});
