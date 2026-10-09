import { describe, expect, it } from 'vitest';
import type { GridSettings } from './map';
import { remapObstacles, shiftObstacle, type ObstacleView } from './obstacle';

const grid = (scale: number, offsetX = 0, offsetY = 0): GridSettings => ({
  scale,
  offsetX,
  offsetY,
  visible: true,
  snap: true,
});
const map = { width: 700, height: 350 };
const wall = (x: number, y: number, width: number, height: number): ObstacleView => ({
  id: 'w',
  mapId: 'm',
  kind: 'wall',
  x,
  y,
  width,
  height,
  blocksMovement: true,
  blocksSight: true,
});

describe('remapObstacles', () => {
  it('scales an obstacle with its cells', () => {
    const { upserted, removedIds } = remapObstacles(map, grid(70), grid(100), [
      wall(70, 70, 210, 70),
    ]);
    expect(removedIds).toEqual([]);
    expect(upserted).toEqual([wall(100, 100, 300, 100)]);
  });

  it('moves it with the offset and reports nothing when nothing changed', () => {
    expect(
      remapObstacles(map, grid(70), grid(70, 10, 20), [wall(70, 70, 70, 70)]).upserted,
    ).toEqual([wall(80, 90, 70, 70)]);
    expect(remapObstacles(map, grid(70), grid(70), [wall(70, 70, 70, 70)])).toEqual({
      upserted: [],
      removedIds: [],
    });
  });

  it('cuts at the edge of the map and drops what ends up outside', () => {
    const edge = { ...wall(630, 0, 70, 70), id: 'edge' };
    const inside = { ...wall(0, 0, 70, 70), id: 'in' };
    const { upserted, removedIds } = remapObstacles(map, grid(70), grid(140), [edge, inside]);
    expect(removedIds).toEqual(['edge']);
    expect(upserted).toEqual([{ ...inside, width: 140, height: 140 }]);
  });

  it('survives a long slider drag back to the starting cell size without drifting', () => {
    let list = [wall(140, 70, 210, 70)];
    let current = grid(70);
    for (const scale of [73, 80, 91, 100, 111, 95, 83, 77, 70]) {
      const next = grid(scale);
      const delta = remapObstacles(map, current, next, list);
      list = list.map((o) => delta.upserted.find((u) => u.id === o.id) ?? o);
      current = next;
    }
    expect(list[0]!.x).toBeCloseTo(140, 1);
    expect(list[0]!.width).toBeCloseTo(210, 1);
  });
});

describe('shiftObstacle', () => {
  const g = grid(70);
  const at = (
    r: { x: number; y: number; width: number; height: number },
    dCol: number,
    dRow: number,
  ) => shiftObstacle({ ...map, grid: g }, r, dCol, dRow);

  it('shifts by whole cells', () => {
    expect(at({ x: 70, y: 70, width: 140, height: 70 }, 2, 1)).toEqual({
      x: 210,
      y: 140,
      width: 140,
      height: 70,
    });
  });

  it('stops at the edge of the map and returns null when it cannot move at all', () => {
    expect(at({ x: 70, y: 70, width: 70, height: 70 }, -9, -9)).toMatchObject({ x: 0, y: 0 });
    expect(at({ x: 560, y: 210, width: 140, height: 140 }, 5, 5)).toBeNull();
    expect(at({ x: 70, y: 70, width: 70, height: 70 }, 0, 0)).toBeNull();
  });

  it('works with an offset grid: only whole cells, never off the map', () => {
    const offset = grid(70, 30, 0);
    const moved = shiftObstacle(
      { ...map, grid: offset },
      { x: 30, y: 0, width: 70, height: 70 },
      -3,
      0,
    );
    expect(moved).toBeNull(); // x = 30 is less than a cell from the edge
  });
});
