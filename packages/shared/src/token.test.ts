import { describe, expect, it } from 'vitest';
import type { GridSettings } from './map';
import {
  cellOf,
  characterIconSchema,
  defaultCharacterIcon,
  PLAYER_ICONS,
  clampToMap,
  findBuiltinIcon,
  MONSTER_ICONS,
  placeToken,
  snapToGrid,
  tokenCreateSchema,
} from './token';

const grid: GridSettings = { scale: 70, offsetX: 0, offsetY: 0, visible: true, snap: true };

describe('snapToGrid', () => {
  it('puts a 1x1 token in the middle of the cell under the point', () => {
    expect(snapToGrid(grid, 1, { x: 100, y: 10 })).toEqual({ x: 105, y: 35 });
    expect(snapToGrid(grid, 1, { x: 0, y: 69.9 })).toEqual({ x: 35, y: 35 });
    expect(snapToGrid(grid, 1, { x: 70, y: 70 })).toEqual({ x: 105, y: 105 });
  });

  it('puts a 2x2 token on the nearest line crossing', () => {
    expect(snapToGrid(grid, 2, { x: 100, y: 10 })).toEqual({ x: 70, y: 0 });
    expect(snapToGrid(grid, 2, { x: 106, y: 106 })).toEqual({ x: 140, y: 140 });
  });

  it('treats 3x3 like 1x1 and 4x4 like 2x2', () => {
    expect(snapToGrid(grid, 3, { x: 100, y: 10 })).toEqual(snapToGrid(grid, 1, { x: 100, y: 10 }));
    expect(snapToGrid(grid, 4, { x: 100, y: 10 })).toEqual(snapToGrid(grid, 2, { x: 100, y: 10 }));
  });

  it('follows the grid offset, also for points left of the first line', () => {
    const shifted = { ...grid, offsetX: 20, offsetY: 30 };
    expect(snapToGrid(shifted, 1, { x: 25, y: 35 })).toEqual({ x: 55, y: 65 });
    expect(snapToGrid(shifted, 1, { x: 5, y: 5 })).toEqual({ x: -15, y: -5 });
  });

  it('is stable: snapping a snapped point changes nothing', () => {
    for (const size of [1, 2, 3, 4]) {
      const once = snapToGrid(grid, size, { x: 333.3, y: 71.7 });
      expect(snapToGrid(grid, size, once)).toEqual(once);
    }
  });
});

describe('placeToken', () => {
  const map = { width: 700, height: 350, grid };

  it('snaps when the map asks for it and keeps the free position otherwise', () => {
    expect(placeToken(map, 1, { x: 100, y: 100 })).toEqual({ x: 105, y: 105 });
    expect(placeToken({ ...map, grid: { ...grid, snap: false } }, 1, { x: 100, y: 100 })).toEqual({
      x: 100,
      y: 100,
    });
  });

  it('never leaves the map, even when the nearest cell centre is outside it', () => {
    expect(placeToken(map, 1, { x: -50, y: 9999 })).toEqual({ x: 35, y: 315 });
    expect(placeToken({ ...map, width: 100 }, 1, { x: 99, y: 10 })).toEqual({ x: 100, y: 35 });
    expect(clampToMap(map, { x: -1, y: 351 })).toEqual({ x: 0, y: 350 });
  });
});

describe('cellOf', () => {
  it('numbers cells from 1 and follows the offset', () => {
    expect(cellOf(grid, { x: 35, y: 35 })).toEqual({ col: 1, row: 1 });
    expect(cellOf(grid, { x: 140, y: 71 })).toEqual({ col: 3, row: 2 });
    expect(cellOf({ ...grid, offsetX: 20 }, { x: 19, y: 0 })).toEqual({ col: 0, row: 1 });
  });
});

describe('icons', () => {
  it('has unique ids across monster and player icons and resolves stored values', () => {
    const ids = [...MONSTER_ICONS, ...PLAYER_ICONS].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findBuiltinIcon('builtin:wolf')?.label).toBe('Волк');
    expect(findBuiltinIcon('builtin:wizard')?.label).toBe('Волшебник');
    expect(findBuiltinIcon('builtin:nope')).toBeUndefined();
    expect(findBuiltinIcon('/api/files/x.png')).toBeUndefined();
  });

  it('gives every participant a valid default that does not change', () => {
    for (const id of ['a', 'cmuzvc4fj00057kd8cgisvmbg', 'x'.repeat(40), '']) {
      const icon = defaultCharacterIcon(id);
      expect(PLAYER_ICONS.map((i) => 'builtin:' + i.id)).toContain(icon);
      expect(defaultCharacterIcon(id)).toBe(icon);
    }
  });

  it('lets players choose player icons only', () => {
    expect(characterIconSchema.safeParse({ icon: 'wizard' }).success).toBe(true);
    expect(characterIconSchema.safeParse({ icon: 'dragon' }).success).toBe(false);
    expect(characterIconSchema.safeParse({ icon: '/api/files/x.png' }).success).toBe(false);
  });
});

describe('tokenCreateSchema', () => {
  const ok = { mapId: 'm', icon: 'wolf', x: 1, y: 2 };

  it('accepts a minimal request and optional size and visibility', () => {
    expect(tokenCreateSchema.safeParse(ok).success).toBe(true);
    expect(tokenCreateSchema.safeParse({ ...ok, size: 3, visible: false }).success).toBe(true);
  });

  it.each([
    [{ icon: 'no-such-icon' }],
    [{ size: 0 }],
    [{ size: 5 }],
    [{ size: 1.5 }],
    [{ x: Number.NaN }],
    [{ y: 'low' }],
    [{ visible: 'no' }],
  ])('rejects %j', (patch) => {
    expect(tokenCreateSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });

  it('does not let a client pick the token type or owner', () => {
    const parsed = tokenCreateSchema.parse({
      ...ok,
      type: 'player_character',
      ownerParticipantId: 'p',
    });
    expect(parsed).not.toHaveProperty('type');
    expect(parsed).not.toHaveProperty('ownerParticipantId');
  });
});
