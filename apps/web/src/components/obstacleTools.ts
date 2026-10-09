import type { ObstacleKind } from '@dnd-map/shared';

/** What the master's pointer does on the map: build a kind of obstacle, or remove one. */
export type ObstacleTool = ObstacleKind | 'erase';

/** Shown over the map while a tool is active. */
export const TOOL_HINTS: Record<ObstacleTool, string> = {
  wall: 'Протяните прямоугольник по клеткам, чтобы построить стену · Esc — закончить',
  pillar: 'Нажимайте на клетки, чтобы ставить столбы · Esc — закончить',
  barrel: 'Нажимайте на клетки, чтобы ставить бочки · Esc — закончить',
  erase: 'Нажмите на объект, чтобы убрать его · Esc — закончить',
};
