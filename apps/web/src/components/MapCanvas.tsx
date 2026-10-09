import {
  cellsRect,
  GRID_SCALE_MAX,
  GRID_SCALE_MIN,
  type MapView,
  type FogState,
  type ObstacleKind,
  type ObstacleView,
  type TokenView,
} from '@dnd-map/shared';
import type Konva from 'konva';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Image as KonvaImage, Layer, Rect, Shape, Stage } from 'react-konva';
import { isPlayerPlacement, type Placing, type RemoteDrags } from '../session/useSession';
import { FogLayer } from './FogLayer';
import { ObstacleLayer } from './ObstacleLayer';
import { TOOL_HINTS, type ObstacleTool } from './obstacleTools';
import { PALETTE_MIME, parsePlacement } from './placement';
import { TokenLayer } from './TokenLayer';
import { useElementSize } from './useElementSize';
import { useLoadedImage } from './useLoadedImage';

interface View {
  x: number;
  y: number;
  scale: number;
}

interface Point {
  x: number;
  y: number;
}

export interface CalibrationResult {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface TokensProps {
  list: TokenView[];
  selectedId: string | null;
  canMove(token: TokenView): boolean;
  remoteDrags: RemoteDrags;
  /** Null clears the selection (click on empty map). */
  onSelect(tokenId: string | null): void;
  onDrag(tokenId: string, x: number, y: number): void;
  onMove(tokenId: string, x: number, y: number): void;
}

export interface ObstaclesProps {
  list: ObstacleView[];
  selectedId: string | null;
  /** What the pointer does on the map: null leaves obstacles to be picked and selected. */
  tool: ObstacleTool | null;
  /** Obstacles stop this viewer's tokens (players); the master is not stopped. */
  stopsTokens: boolean;
  /** Master: a click on an obstacle (selects it, or erases it with the eraser). */
  onPick(obstacleId: string): void;
  /** Master: build `kind` between two points (the server snaps it to cells). */
  onDraw(kind: ObstacleKind, from: Point, to: Point): void;
  /** Master: shift the obstacle by whole cells. */
  onMove(obstacleId: string, dCol: number, dRow: number): void;
}

export interface FogProps {
  state: FogState;
  /** How dark the fog is drawn; 0 hides it. */
  opacity: number;
}

interface Props {
  map: MapView;
  fog: FogProps | null;
  obstacles: ObstaclesProps;
  tokens: TokensProps;
  /** While set, a click on the map places a token instead of selecting: a monster, or the player's own character. */
  placing: Placing | null;
  onPlace(spec: Placing, x: number, y: number): void;
  /** Centre the view on this point; a new object (new `nonce`) is a new request. */
  focus: { x: number; y: number; nonce: number } | null;
  /** While true, dragging draws a rectangle instead of panning; the rectangle becomes one grid cell. */
  calibrating: boolean;
  onCalibrated(result: CalibrationResult): void;
}

const FIT_MARGIN = 0.95;
const MIN_CALIBRATION_SIDE = 8; // image pixels
/** Below this many screen pixels per cell the grid is more noise than help, and costs frames. */
const MIN_CELL_ON_SCREEN = 6;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Phones get the downscaled preview: less data and no giant textures. */
const prefersPreview = () => window.matchMedia('(pointer: coarse)').matches;

export function MapCanvas({
  map,
  fog,
  obstacles,
  calibrating,
  onCalibrated,
  tokens,
  placing,
  onPlace,
  focus,
}: Props) {
  const [container, size, containerNode] = useElementSize<HTMLDivElement>();
  const stageRef = useRef<Konva.Stage>(null);
  const wallTool = obstacles.tool === 'wall';
  const [drawing, setDrawing] = useState<{ from: Point; to: Point } | null>(null);
  // While calibrating or drawing a wall a drag draws; it must not pan the map.
  const panLockedRef = useRef(calibrating || wallTool);
  panLockedRef.current = calibrating || wallTool;
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [selection, setSelection] = useState<{ from: Point; to: Point } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const fittedFor = useRef<string | null>(null);

  const [usePreview] = useState(prefersPreview);
  const loaded = useLoadedImage(usePreview ? map.previewUrl : map.imageUrl);

  const fitScale =
    size.width > 0 ? Math.min(size.width / map.width, size.height / map.height) * FIT_MARGIN : 1;
  const minScale = fitScale * 0.5;
  const maxScale = Math.max(8, fitScale * 4);

  const fit = useCallback(() => {
    if (size.width === 0) return;
    setView({
      scale: fitScale,
      x: (size.width - map.width * fitScale) / 2,
      y: (size.height - map.height * fitScale) / 2,
    });
  }, [fitScale, map.width, map.height, size.width, size.height]);

  // Fit once per map; later window resizes keep whatever zoom the user chose.
  useEffect(() => {
    if (size.width > 0 && fittedFor.current !== map.id) {
      fittedFor.current = map.id;
      fit();
    }
  }, [map.id, size.width, fit]);

  useEffect(() => {
    if (!calibrating) setSelection(null);
  }, [calibrating]);

  useEffect(() => {
    if (!focus) return;
    const { width, height } = sizeRef.current;
    setView((v) => ({ ...v, x: width / 2 - focus.x * v.scale, y: height / 2 - focus.y * v.scale }));
  }, [focus]);

  const zoomAt = useCallback(
    (point: Point, factor: number) =>
      setView((v) => {
        const scale = clamp(v.scale * factor, minScale, maxScale);
        const anchor = { x: (point.x - v.x) / v.scale, y: (point.y - v.y) / v.scale };
        return { scale, x: point.x - anchor.x * scale, y: point.y - anchor.y * scale };
      }),
    [minScale, maxScale],
  );

  const zoomFromCenter = (factor: number) =>
    zoomAt({ x: size.width / 2, y: size.height / 2 }, factor);

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const pointer = e.target.getStage()?.getPointerPosition();
    if (!pointer) return;
    zoomAt(pointer, Math.exp(-clamp(e.evt.deltaY, -100, 100) * 0.002));
  };

  const imagePoint = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): Point | null =>
    e.target.getStage()?.getRelativePointerPosition() ?? null;

  const onPointerDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const p = imagePoint(e);
    if (!p) return;
    if (calibrating) setSelection({ from: p, to: p });
    else if (wallTool) setDrawing({ from: p, to: p });
  };

  const onPointerMove = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const p = imagePoint(e);
    if (!p) return;
    if (calibrating) setSelection((s) => (s ? { ...s, to: p } : s));
    else if (wallTool) setDrawing((d) => (d ? { ...d, to: p } : d));
  };

  const onPointerUp = () => {
    if (wallTool && drawing) {
      obstacles.onDraw('wall', drawing.from, drawing.to);
      setDrawing(null);
      return;
    }
    if (!calibrating || !selection) return;
    const width = Math.abs(selection.to.x - selection.from.x);
    const height = Math.abs(selection.to.y - selection.from.y);
    setSelection(null);
    if (Math.min(width, height) < MIN_CALIBRATION_SIDE) return; // a click, not a cell

    const scale = clamp((width + height) / 2, GRID_SCALE_MIN, GRID_SCALE_MAX);
    const left = Math.min(selection.from.x, selection.to.x);
    const top = Math.min(selection.from.y, selection.to.y);
    onCalibrated({ scale, offsetX: left, offsetY: top });
  };

  const onStageClick = (e: Konva.KonvaEventObject<PointerEvent>) => {
    // Clicks on a token are handled by the token itself.
    if (calibrating || e.target !== e.target.getStage()) return;
    const p = imagePoint(e);
    const tool = obstacles.tool;
    if ((tool === 'pillar' || tool === 'barrel') && p) obstacles.onDraw(tool, p, p);
    else if (placing && p) onPlace(placing, p.x, p.y);
    else {
      tokens.onSelect(null);
      obstacles.onPick('');
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(PALETTE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const spec = parsePlacement(e.dataTransfer.getData(PALETTE_MIME));
    if (!spec || !containerNode) return;
    e.preventDefault();
    const box = containerNode.getBoundingClientRect();
    onPlace(
      spec,
      (e.clientX - box.left - view.x) / view.scale,
      (e.clientY - box.top - view.y) / view.scale,
    );
  };

  /**
   * Two-finger zoom around the midpoint, panning with the midpoint's movement.
   * Uses native touch events on the container: while Konva drags the stage it stops delivering
   * touch events to the stage, so its own handlers would never see the second finger.
   */
  useEffect(() => {
    const node = containerNode;
    if (!node) return;
    let last: { center: Point; dist: number } | null = null;

    const measure = (e: TouchEvent) => {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      if (!t1 || !t2) return null;
      const box = node.getBoundingClientRect();
      const p1 = { x: t1.clientX - box.left, y: t1.clientY - box.top };
      const p2 = { x: t2.clientX - box.left, y: t2.clientY - box.top };
      return {
        center: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        dist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
      };
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      // Capture phase: runs before Konva sees the event. Pinching must never also drag the stage.
      const stage = stageRef.current;
      if (stage?.isDragging()) stage.stopDrag();
      stage?.draggable(false);
      last = measure(e);
    };

    const onMove = (e: TouchEvent) => {
      const now = measure(e);
      if (!now) return;
      e.preventDefault();
      const previous = last;
      last = now;
      if (!previous || previous.dist === 0 || now.dist === 0) return;

      setView((v) => {
        const scale = clamp((v.scale * now.dist) / previous.dist, minScale, maxScale);
        const anchor = { x: (now.center.x - v.x) / v.scale, y: (now.center.y - v.y) / v.scale };
        return {
          scale,
          x: now.center.x - anchor.x * scale + (now.center.x - previous.center.x),
          y: now.center.y - anchor.y * scale + (now.center.y - previous.center.y),
        };
      });
    };

    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) last = null;
      // Dragging comes back only when every finger is up, so the remaining finger of a pinch
      // does not suddenly start panning.
      if (e.touches.length === 0) stageRef.current?.draggable(!panLockedRef.current);
    };

    node.addEventListener('touchstart', onStart, { capture: true, passive: true });
    node.addEventListener('touchmove', onMove, { passive: false });
    node.addEventListener('touchend', onEnd, { passive: true });
    node.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      node.removeEventListener('touchstart', onStart, { capture: true });
      node.removeEventListener('touchmove', onMove);
      node.removeEventListener('touchend', onEnd);
      node.removeEventListener('touchcancel', onEnd);
    };
  }, [containerNode, minScale, maxScale]);

  const draw = useCallback(
    (ctx: Konva.Context, shape: Konva.Shape) => drawGrid(ctx, shape, map),
    [map],
  );

  return (
    <div
      ref={container}
      className={[
        'map-canvas',
        calibrating && 'calibrating',
        placing && 'placing',
        obstacles.tool && 'drawing',
      ]
        .filter(Boolean)
        .join(' ')}
      role="img"
      aria-label="Карта"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {size.width > 0 && (
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          x={view.x}
          y={view.y}
          scaleX={view.scale}
          scaleY={view.scale}
          draggable={!calibrating && !wallTool}
          onWheel={onWheel}
          onMouseDown={onPointerDown}
          onTouchStart={onPointerDown}
          onMouseMove={onPointerMove}
          onTouchMove={onPointerMove}
          onMouseUp={onPointerUp}
          onTouchEnd={onPointerUp}
          // One pointer event for mouse and touch: a tap also produces a compatibility click,
          // and listening to both placed every token twice on phones.
          onPointerClick={onStageClick}
          onDragEnd={(e) => {
            // Only the stage's own drag (not a child's) moves the view.
            if (e.target === e.target.getStage()) {
              setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
            }
          }}
        >
          {/* Picture and grid share one canvas: every extra full-screen layer costs time per frame. */}
          <Layer listening={false}>
            {loaded?.image && (
              <KonvaImage image={loaded.image} width={map.width} height={map.height} />
            )}
            {map.grid.visible && (
              <>
                <Shape
                  sceneFunc={draw}
                  stroke="rgba(0,0,0,0.45)"
                  strokeWidth={3}
                  strokeScaleEnabled={false}
                />
                <Shape
                  sceneFunc={draw}
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth={1}
                  strokeScaleEnabled={false}
                />
              </>
            )}
          </Layer>
          <ObstacleLayer
            obstacles={obstacles.list}
            selectedId={obstacles.selectedId}
            interactive={!calibrating && (obstacles.tool === null || obstacles.tool === 'erase')}
            movable={!calibrating && obstacles.tool === null && !placing}
            cell={map.grid.scale}
            onPick={obstacles.onPick}
            onMove={obstacles.onMove}
          />
          <TokenLayer
            obstacles={obstacles.list}
            stopsTokens={obstacles.stopsTokens}
            tokens={tokens.list}
            grid={map.grid}
            selectedId={tokens.selectedId}
            canMove={tokens.canMove}
            remoteDrags={tokens.remoteDrags}
            interactive={!calibrating}
            onSelect={tokens.onSelect}
            onDrag={tokens.onDrag}
            onMove={tokens.onMove}
          />
          {fog && fog.opacity > 0 && (
            <FogLayer fog={fog.state} width={map.width} height={map.height} opacity={fog.opacity} />
          )}
          {drawing && wallTool && <WallPreview map={map} from={drawing.from} to={drawing.to} />}
          {selection && (
            <Layer listening={false}>
              <Rect
                x={Math.min(selection.from.x, selection.to.x)}
                y={Math.min(selection.from.y, selection.to.y)}
                width={Math.abs(selection.to.x - selection.from.x)}
                height={Math.abs(selection.to.y - selection.from.y)}
                fill="rgba(224,138,82,0.25)"
                stroke="#e08a52"
                strokeWidth={2}
                strokeScaleEnabled={false}
                dash={[6, 4]}
              />
            </Layer>
          )}
        </Stage>
      )}

      {!loaded && <div className="map-status">Загрузка карты…</div>}
      {loaded?.failed && (
        <div className="map-status error">Не удалось загрузить изображение карты.</div>
      )}

      {obstacles.tool && !placing && <div className="map-hint">{TOOL_HINTS[obstacles.tool]}</div>}
      {placing && (
        <div className="map-hint">
          {placing === 'character'
            ? 'Нажмите на карту, чтобы поставить своего персонажа · Esc — отмена'
            : isPlayerPlacement(placing)
              ? `Нажмите на карту, чтобы поставить персонажа «${placing.name}» · Esc — отмена`
              : 'Нажмите на карту, чтобы поставить фишку · Esc — закончить'}
        </div>
      )}

      <div className="zoom-controls">
        <button type="button" aria-label="Приблизить" onClick={() => zoomFromCenter(1.25)}>
          +
        </button>
        <button type="button" aria-label="Отдалить" onClick={() => zoomFromCenter(1 / 1.25)}>
          −
        </button>
        <button type="button" aria-label="Вписать карту в экран" onClick={fit}>
          ⤢
        </button>
      </div>
    </div>
  );
}

/**
 * Draws only the lines inside the visible part of the map. The visible area is read from the
 * live stage transform, not from React state, so the grid stays correct while the stage is dragged.
 */
function drawGrid(ctx: Konva.Context, shape: Konva.Shape, map: MapView): void {
  const stage = shape.getStage();
  if (!stage) return;
  const zoom = stage.scaleX();
  const { scale, offsetX, offsetY } = map.grid;
  if (scale * zoom < MIN_CELL_ON_SCREEN) return;

  const left = Math.max(0, -stage.x() / zoom);
  const top = Math.max(0, -stage.y() / zoom);
  const right = Math.min(map.width, (stage.width() - stage.x()) / zoom);
  const bottom = Math.min(map.height, (stage.height() - stage.y()) / zoom);
  if (right <= left || bottom <= top) return;

  ctx.beginPath();
  // Lines are computed by index (not by repeated addition) so rounding errors never accumulate.
  for (let i = Math.ceil((left - offsetX) / scale); ; i++) {
    const x = offsetX + i * scale;
    if (x > right) break;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let i = Math.ceil((top - offsetY) / scale); ; i++) {
    const y = offsetY + i * scale;
    if (y > bottom) break;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.strokeShape(shape);
}

/** The cells a wall would cover if the mouse were released now. */
function WallPreview({ map, from, to }: { map: MapView; from: Point; to: Point }) {
  const rect = cellsRect(map, from, to);
  if (!rect) return null;
  return (
    <Layer listening={false}>
      <Rect
        {...rect}
        fill="rgba(74,69,64,0.55)"
        stroke="#e08a52"
        strokeWidth={2}
        strokeScaleEnabled={false}
        dash={[6, 4]}
      />
    </Layer>
  );
}
