import {
  describeCells,
  OBSTACLE_KINDS,
  type GridSettings,
  type ObstacleKind,
  type ObstacleView,
} from '@dnd-map/shared';
import type { ObstacleActions } from '../session/useSession';
import { TOOL_HINTS, type ObstacleTool } from './obstacleTools';

const TOOLS: Array<{ tool: ObstacleTool; label: string }> = [
  { tool: 'wall', label: OBSTACLE_KINDS.wall.label },
  { tool: 'pillar', label: OBSTACLE_KINDS.pillar.label },
  { tool: 'barrel', label: OBSTACLE_KINDS.barrel.label },
  { tool: 'erase', label: 'Ластик' },
];

interface Props {
  tool: ObstacleTool | null;
  onToolChange(tool: ObstacleTool | null): void;
  grid: GridSettings;
  obstacles: ObstacleView[];
  selected: ObstacleView | null;
  actions: Pick<ObstacleActions, 'remove' | 'setSight' | 'clear'>;
}

/** Master: build walls, pillars and barrels, remove them, choose what hides what is behind it. */
export function ObstaclePanel({ tool, onToolChange, grid, obstacles, selected, actions }: Props) {
  const clear = () => {
    if (!window.confirm(`Убрать все препятствия на карте (${obstacles.length})?`)) return;
    void actions.clear();
  };

  return (
    <section className="panel">
      <h3>Препятствия</h3>
      <div className="tool-row" role="group" aria-label="Инструмент">
        {TOOLS.map(({ tool: t, label }) => (
          <button
            key={t}
            type="button"
            className={tool === t ? '' : 'secondary'}
            aria-pressed={tool === t}
            onClick={() => onToolChange(tool === t ? null : t)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="hint">
        {tool
          ? TOOL_HINTS[tool]
          : 'Через препятствия не пройти. Стены и столбы закрывают обзор, бочки — нет. Мастер ходит сквозь всё.'}
      </p>

      {selected && (
        <div className="selected-obstacle">
          <strong>
            {OBSTACLE_KINDS[selected.kind as ObstacleKind].label}, клетки{' '}
            {describeCells(grid, selected)}
          </strong>
          <label className="check">
            <input
              type="checkbox"
              checked={selected.blocksSight}
              onChange={(e) => actions.setSight(selected.id, e.target.checked)}
            />
            Закрывает обзор
          </label>
          <button type="button" className="secondary" onClick={() => actions.remove(selected.id)}>
            Удалить
          </button>
        </div>
      )}

      {obstacles.length > 0 && (
        <button type="button" className="secondary" onClick={clear}>
          Убрать все ({obstacles.length})
        </button>
      )}
    </section>
  );
}
