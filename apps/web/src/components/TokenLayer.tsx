import {
  canMove as canTravel,
  snapToGrid,
  tokenRadius,
  type GridSettings,
  type ObstacleView,
  type TokenView,
} from '@dnd-map/shared';
import Konva from 'konva';
import { memo, useCallback, useEffect, useRef } from 'react';
import { Circle, Group, Image as KonvaImage, Layer, Text } from 'react-konva';
import type { RemoteDrags } from '../session/useSession';
import { EMOJI_FONT, iconFace } from './TokenIcon';
import { useLoadedImage } from './useLoadedImage';

const MOVE_TWEEN_SECONDS = 0.08;
const TOKEN_FILL_RATIO = 0.9; // a token covers 90% of its cells so neighbours stay distinguishable

interface Props {
  tokens: TokenView[];
  grid: GridSettings;
  selectedId: string | null;
  /** Whether the viewer may move this token; decided by the same rules the server enforces. */
  canMove(token: TokenView): boolean;
  remoteDrags: RemoteDrags;
  /** Obstacles and whether they stop this viewer (players are stopped, the master is not). */
  obstacles: ObstacleView[];
  stopsTokens: boolean;
  /** False while the grid is being calibrated: tokens must not react then. */
  interactive: boolean;
  onSelect(tokenId: string): void;
  onDrag(tokenId: string, x: number, y: number): void;
  onMove(tokenId: string, x: number, y: number): void;
}

/**
 * Memoized: panning and zooming change the view many times a second, and none of that concerns
 * the tokens. Without this every frame would re-render (and diff) every token.
 */
export const TokenLayer = memo(function TokenLayer({
  tokens,
  remoteDrags,
  interactive,
  ...rest
}: Props) {
  return (
    <Layer listening={interactive}>
      {tokens.map((token) => (
        <TokenNode key={token.id} token={token} remote={remoteDrags[token.id]} {...rest} />
      ))}
    </Layer>
  );
});

const TokenNode = memo(function TokenNode({
  token,
  remote,
  grid,
  selectedId,
  canMove,
  obstacles,
  stopsTokens,
  onSelect,
  onDrag,
  onMove,
}: { token: TokenView; remote?: { x: number; y: number } } & Omit<
  Props,
  'tokens' | 'remoteDrags' | 'interactive'
>) {
  const group = useRef<Konva.Group>(null);
  const outline = useRef<Konva.Circle>(null);
  const outlineColor = token.visible ? '#ffffff' : '#e8e0d0';
  const tween = useRef<Konva.Tween | null>(null);
  // Position is owned by Konva (dragging) and by the tween below, not by React props, so it is
  // given once at mount; later changes are animated instead of jumping.
  const start = useRef({ x: token.x, y: token.y });
  const target = remote ?? token;

  const face = iconFace(token.icon);
  const picture = useLoadedImage(face.kind === 'image' ? face.url : null);

  const targetRef = useRef(target);
  targetRef.current = target;

  /** Moves the node to where the data says the token is. */
  const slideToTarget = useCallback(() => {
    const node = group.current;
    if (!node) return;
    tween.current?.destroy();
    tween.current = new Konva.Tween({
      node,
      x: targetRef.current.x,
      y: targetRef.current.y,
      duration: MOVE_TWEEN_SECONDS,
      easing: Konva.Easings.EaseOut,
    });
    tween.current.play();
  }, []);

  // Follow the data: remote drags, confirmed moves, and corrections after a refused move (which
  // arrive as a new token object even when the position is the same).
  useEffect(() => {
    if (!group.current?.isDragging()) slideToTarget();
  }, [target.x, target.y, token, slideToTarget]);

  // When a token stops being movable in the middle of a drag (the connection was lost), Konva drops
  // the drag silently, without a drag-end event, and the node would stay where the finger was.
  const movable = canMove(token);
  useEffect(() => {
    if (movable) return;
    if (group.current?.isDragging()) group.current.stopDrag();
    slideToTarget();
  }, [movable, slideToTarget]);

  useEffect(() => () => tween.current?.destroy(), []);

  const radius = (token.size * grid.scale * TOKEN_FILL_RATIO) / 2;
  const selected = token.id === selectedId;

  return (
    <Group
      ref={group}
      x={start.current.x}
      y={start.current.y}
      draggable={movable}
      opacity={token.visible ? 1 : 0.55}
      // Without this the press would also start panning the map (the stage is draggable too).
      onMouseDown={(e) => void (e.cancelBubble = true)}
      onTouchStart={(e) => void (e.cancelBubble = true)}
      onPointerClick={() => onSelect(token.id)}
      onDragStart={() => {
        tween.current?.destroy();
        onSelect(token.id);
      }}
      onDragMove={(e) => {
        onDrag(token.id, e.target.x(), e.target.y());
        if (!stopsTokens) return;
        // Shows at once whether this drop would be refused: the outline turns red.
        const raw = { x: e.target.x(), y: e.target.y() };
        const to = grid.snap ? snapToGrid(grid, token.size, raw) : raw;
        const free = canTravel(token, to, tokenRadius(grid, token.size), obstacles).ok;
        outline.current?.stroke(free ? outlineColor : '#e53935');
      }}
      onDragEnd={(e) => {
        outline.current?.stroke(outlineColor);
        onMove(token.id, e.target.x(), e.target.y());
      }}
    >
      {selected && (
        <Circle radius={radius + 5} stroke="#e08a52" strokeWidth={3} strokeScaleEnabled={false} />
      )}
      {/* A offset dark disc instead of a blurred shadow: blurring costs a lot on every frame. */}
      <Circle x={2} y={3} radius={radius} fill="rgba(0,0,0,0.35)" listening={false} />
      <Circle
        ref={outline}
        radius={radius}
        fill={face.kind === 'emoji' ? face.color : '#6b665e'}
        stroke={outlineColor}
        strokeWidth={2}
        strokeScaleEnabled={false}
        dash={token.visible ? undefined : [6, 4]}
        perfectDrawEnabled={false}
      />
      {face.kind === 'emoji' && (
        <Text
          x={-radius}
          y={-radius}
          width={radius * 2}
          height={radius * 2}
          align="center"
          verticalAlign="middle"
          text={face.glyph}
          fontSize={radius * 1.15}
          fontFamily={EMOJI_FONT}
          listening={false}
        />
      )}
      {picture?.image && (
        <Group
          listening={false}
          clipFunc={(ctx) => {
            ctx.arc(0, 0, radius, 0, Math.PI * 2, false);
          }}
        >
          <KonvaImage
            image={picture.image}
            x={-radius}
            y={-radius}
            width={radius * 2}
            height={radius * 2}
          />
        </Group>
      )}
    </Group>
  );
});
