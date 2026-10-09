import type { ObstacleView } from '@dnd-map/shared';
import { memo } from 'react';
import { Circle, Group, Layer, Rect } from 'react-konva';

interface Props {
  obstacles: ObstacleView[];
  selectedId: string | null;
  /** The master can pick obstacles (to select or erase them); for everyone else they are scenery. */
  interactive: boolean;
  /** Master: the selected obstacle can be dragged, one cell at a time. */
  movable: boolean;
  /** Size of a grid cell, in map pixels. */
  cell: number;
  onPick(obstacleId: string): void;
  onMove(obstacleId: string, dCol: number, dRow: number): void;
}

const WALL = '#4a4540';
const OUTLINE = '#1d1a17';
const SELECTED = '#e08a52';

/**
 * Memoized for the same reason as the token layer: panning and zooming must not re-render
 * hundreds of shapes.
 */
export const ObstacleLayer = memo(function ObstacleLayer({
  obstacles,
  selectedId,
  interactive,
  movable,
  cell,
  onPick,
  onMove,
}: Props) {
  return (
    <Layer listening={interactive}>
      {obstacles.map((o) => (
        <ObstacleShape
          key={o.id}
          o={o}
          selected={o.id === selectedId}
          movable={movable && o.id === selectedId}
          cell={cell}
          onPick={onPick}
          onMove={onMove}
        />
      ))}
    </Layer>
  );
});

function ObstacleShape({
  o,
  selected,
  movable,
  cell,
  onPick,
  onMove,
}: {
  o: ObstacleView;
  selected: boolean;
  movable: boolean;
  cell: number;
  onPick(obstacleId: string): void;
  onMove(obstacleId: string, dCol: number, dRow: number): void;
}) {
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  const half = Math.min(o.width, o.height) / 2;
  // Dashed outline and a lighter fill: this object does not hide what is behind it.
  const seeThrough = !o.blocksSight;
  const pick = { onPointerClick: () => onPick(o.id) };

  return (
    <Group
      draggable={movable}
      // It travels cell by cell: the shapes inside are drawn where the obstacle is now.
      onDragMove={(e) => {
        e.target.position({
          x: Math.round(e.target.x() / cell) * cell,
          y: Math.round(e.target.y() / cell) * cell,
        });
      }}
      onDragEnd={(e) => {
        e.cancelBubble = true; // the stage must not take it for a pan
        const dCol = Math.round(e.target.x() / cell);
        const dRow = Math.round(e.target.y() / cell);
        e.target.position({ x: 0, y: 0 }); // the new place comes back from the state
        if (dCol !== 0 || dRow !== 0) onMove(o.id, dCol, dRow);
      }}
    >
      {o.kind === 'wall' && (
        <Rect
          x={o.x}
          y={o.y}
          width={o.width}
          height={o.height}
          fill={WALL}
          opacity={seeThrough ? 0.6 : 0.95}
          stroke={OUTLINE}
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          dash={seeThrough ? [6, 4] : undefined}
          perfectDrawEnabled={false}
          {...pick}
        />
      )}
      {o.kind === 'pillar' && (
        <Circle
          x={cx}
          y={cy}
          radius={half * 0.85}
          fill="#6d6760"
          opacity={seeThrough ? 0.6 : 1}
          stroke={OUTLINE}
          strokeWidth={2}
          strokeScaleEnabled={false}
          dash={seeThrough ? [6, 4] : undefined}
          perfectDrawEnabled={false}
          {...pick}
        />
      )}
      {o.kind === 'barrel' && (
        <>
          <Circle
            x={cx}
            y={cy}
            radius={half * 0.8}
            fill="#8a5a2b"
            stroke={OUTLINE}
            strokeWidth={2}
            strokeScaleEnabled={false}
            perfectDrawEnabled={false}
            {...pick}
          />
          <Circle
            x={cx}
            y={cy}
            radius={half * 0.5}
            stroke="#5b3a1a"
            strokeWidth={2}
            strokeScaleEnabled={false}
            listening={false}
          />
        </>
      )}
      {selected && (
        <Rect
          x={o.x}
          y={o.y}
          width={o.width}
          height={o.height}
          stroke={SELECTED}
          strokeWidth={3}
          strokeScaleEnabled={false}
          dash={[8, 4]}
          listening={false}
        />
      )}
    </Group>
  );
}
