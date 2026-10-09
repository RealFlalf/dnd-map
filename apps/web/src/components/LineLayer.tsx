import { LINE_FADE_MS, lineColor } from '@dnd-map/shared';
import Konva from 'konva';
import { memo, useEffect, useRef } from 'react';
import { Layer, Line } from 'react-konva';
import type { LiveLine } from '../session/useLines';

/** Screen pixels: a line reads the same at any zoom. */
const WIDTH = 4;

interface Props {
  lines: LiveLine[];
  /** The stroke being drawn right now, not sent yet. */
  stroke: { points: number[]; color: string } | null;
}

/** Temporary lines over everything else on the map, fading out at the end of their life. */
export const LineLayer = memo(function LineLayer({ lines, stroke }: Props) {
  return (
    <Layer listening={false}>
      {lines.map((l) => (
        <FadingLine key={l.id} line={l} />
      ))}
      {stroke && stroke.points.length >= 4 && (
        <Line {...lineLook(stroke.color)} points={stroke.points} opacity={0.8} />
      )}
    </Layer>
  );
});

const lineLook = (color: string) => ({
  stroke: color,
  strokeWidth: WIDTH,
  strokeScaleEnabled: false,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
  tension: 0.3,
  // A dark edge so the line shows on light and dark maps alike; cheaper than a shadow blur.
  shadowColor: 'rgba(0,0,0,0.6)',
  shadowOffset: { x: 1, y: 1 },
  shadowForStrokeEnabled: true,
});

function FadingLine({ line }: { line: LiveLine }) {
  const ref = useRef<Konva.Line>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const left = line.expiresAt - Date.now();
    const fade = Math.min(LINE_FADE_MS, Math.max(0, left));
    node.opacity(left < LINE_FADE_MS ? Math.max(0, left / LINE_FADE_MS) : 1);
    let tween: Konva.Tween | undefined;
    const timer = setTimeout(
      () => {
        tween = new Konva.Tween({ node, opacity: 0, duration: fade / 1000 });
        tween.play();
      },
      Math.max(0, left - fade),
    );
    return () => {
      clearTimeout(timer);
      tween?.destroy();
    };
  }, [line.expiresAt]);

  return (
    <Line
      ref={ref}
      {...lineLook(lineColor(line))}
      points={line.points}
      dash={line.pending ? [8, 6] : undefined}
    />
  );
}
