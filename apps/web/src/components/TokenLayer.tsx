import type { GridSettings, TokenView } from '@dnd-map/shared';
import Konva from 'konva';
import { useEffect, useRef } from 'react';
import { Circle, Group, Layer, Text } from 'react-konva';
import type { RemoteDrags } from '../session/useSession';
import { EMOJI_FONT, iconStyle } from './TokenIcon';

const MOVE_TWEEN_SECONDS = 0.08;
const TOKEN_FILL_RATIO = 0.9; // a token covers 90% of its cells so neighbours stay distinguishable

interface Props {
  tokens: TokenView[];
  grid: GridSettings;
  selectedId: string | null;
  /** Whether the viewer may move this token; decided by the same rules the server enforces. */
  canMove(token: TokenView): boolean;
  remoteDrags: RemoteDrags;
  /** False while the grid is being calibrated: tokens must not react then. */
  interactive: boolean;
  onSelect(tokenId: string): void;
  onDrag(tokenId: string, x: number, y: number): void;
  onMove(tokenId: string, x: number, y: number): void;
}

export function TokenLayer({ tokens, remoteDrags, interactive, ...rest }: Props) {
  return (
    <Layer listening={interactive}>
      {tokens.map((token) => (
        <TokenNode key={token.id} token={token} remote={remoteDrags[token.id]} {...rest} />
      ))}
    </Layer>
  );
}

function TokenNode({
  token,
  remote,
  grid,
  selectedId,
  canMove,
  onSelect,
  onDrag,
  onMove,
}: { token: TokenView; remote?: { x: number; y: number } } & Omit<
  Props,
  'tokens' | 'remoteDrags' | 'interactive'
>) {
  const group = useRef<Konva.Group>(null);
  const tween = useRef<Konva.Tween | null>(null);
  // Position is owned by Konva (dragging) and by the tween below, not by React props, so it is
  // given once at mount; later changes are animated instead of jumping.
  const start = useRef({ x: token.x, y: token.y });
  const target = remote ?? token;

  useEffect(() => {
    const node = group.current;
    if (!node || node.isDragging()) return;
    tween.current?.destroy();
    tween.current = new Konva.Tween({
      node,
      x: target.x,
      y: target.y,
      duration: MOVE_TWEEN_SECONDS,
      easing: Konva.Easings.EaseOut,
    });
    tween.current.play();
  }, [target.x, target.y]);

  useEffect(() => () => tween.current?.destroy(), []);

  const radius = (token.size * grid.scale * TOKEN_FILL_RATIO) / 2;
  const { color, glyph } = iconStyle(token.icon);
  const selected = token.id === selectedId;

  return (
    <Group
      ref={group}
      x={start.current.x}
      y={start.current.y}
      draggable={canMove(token)}
      opacity={token.visible ? 1 : 0.55}
      // Without this the press would also start panning the map (the stage is draggable too).
      onMouseDown={(e) => void (e.cancelBubble = true)}
      onTouchStart={(e) => void (e.cancelBubble = true)}
      onClick={() => onSelect(token.id)}
      onTap={() => onSelect(token.id)}
      onDragStart={() => {
        tween.current?.destroy();
        onSelect(token.id);
      }}
      onDragMove={(e) => onDrag(token.id, e.target.x(), e.target.y())}
      onDragEnd={(e) => onMove(token.id, e.target.x(), e.target.y())}
    >
      {selected && (
        <Circle radius={radius + 5} stroke="#e08a52" strokeWidth={3} strokeScaleEnabled={false} />
      )}
      <Circle
        radius={radius}
        fill={color}
        stroke={token.visible ? '#ffffff' : '#e8e0d0'}
        strokeWidth={2}
        strokeScaleEnabled={false}
        dash={token.visible ? undefined : [6, 4]}
        shadowColor="#000000"
        shadowBlur={6}
        shadowOpacity={0.45}
      />
      <Text
        x={-radius}
        y={-radius}
        width={radius * 2}
        height={radius * 2}
        align="center"
        verticalAlign="middle"
        text={glyph}
        fontSize={radius * 1.15}
        fontFamily={EMOJI_FONT}
        listening={false}
      />
    </Group>
  );
}
