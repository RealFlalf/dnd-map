import type { FogState } from '@dnd-map/shared';
import { memo } from 'react';
import { Layer, Line, Rect } from 'react-konva';

interface Props {
  fog: FogState;
  width: number;
  height: number;
  /** Players (and the master previewing them) get near-black fog; the master's own view only tints it. */
  opacity: number;
}

/**
 * A dark sheet over the whole map with the party's visible area cut out of it. Memoized: the
 * polygons change only when the server sends a new view, not while panning or zooming.
 */
export const FogLayer = memo(function FogLayer({ fog, width, height, opacity }: Props) {
  return (
    <Layer listening={false} opacity={opacity}>
      <Rect x={0} y={0} width={width} height={height} fill="#07060a" />
      {fog.polygons.map((polygon, i) => (
        <Line
          key={i}
          points={polygon.flatMap((p) => [p.x, p.y])}
          closed
          fill="#000"
          globalCompositeOperation="destination-out"
        />
      ))}
    </Layer>
  );
});
