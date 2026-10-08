import {
  ACCEPTED_IMAGE_TYPES,
  GRID_SCALE_MAX,
  GRID_SCALE_MIN,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  type MapView,
  type SessionState,
} from '@dnd-map/shared';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { MapActions } from '../session/useSession';

interface Props {
  world: SessionState;
  actions: MapActions;
  calibrating: boolean;
  onCalibratingChange(value: boolean): void;
}

/** Master-only controls: upload and switch maps, tune the grid. */
export function MapControls({ world, actions, calibrating, onCalibratingChange }: Props) {
  const current = world.maps.find((m) => m.id === world.currentMapId) ?? null;

  return (
    <>
      <MapList world={world} actions={actions} />
      {current && (
        <GridSettings
          map={current}
          actions={actions}
          calibrating={calibrating}
          onCalibratingChange={onCalibratingChange}
        />
      )}
    </>
  );
}

function MapList({ world, actions }: { world: SessionState; actions: MapActions }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await actions.upload(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить карту.');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = ''; // allow choosing the same file again
    }
  };

  const remove = async (index: number, map: MapView) => {
    if (!window.confirm(`Удалить карту ${index + 1}? Фишки на ней тоже будут удалены.`)) return;
    const res = await actions.deleteMap(map.id);
    if (!res.ok) setError('Не удалось удалить карту.');
  };

  return (
    <section className="panel">
      <h3>Карты</h3>
      <input
        ref={input}
        type="file"
        hidden
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <button type="button" disabled={uploading} onClick={() => input.current?.click()}>
        {uploading ? 'Загружаем…' : 'Загрузить карту'}
      </button>
      <p className="hint">
        JPG, PNG или WebP, до {MAX_IMAGE_BYTES / 1024 / 1024} МБ и {MAX_IMAGE_SIDE} px по стороне.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {world.maps.length > 0 && (
        <ul className="map-list">
          {world.maps.map((map, index) => (
            <li key={map.id} className={map.id === world.currentMapId ? 'current' : ''}>
              <button
                type="button"
                className="map-pick"
                aria-pressed={map.id === world.currentMapId}
                onClick={() => void actions.selectMap(map.id)}
              >
                <img src={map.previewUrl} alt="" width={56} height={42} loading="lazy" />
                <span>Карта {index + 1}</span>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Удалить карту ${index + 1}`}
                onClick={() => void remove(index, map)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GridSettings({
  map,
  actions,
  calibrating,
  onCalibratingChange,
}: {
  map: MapView;
  actions: MapActions;
  calibrating: boolean;
  onCalibratingChange(value: boolean): void;
}) {
  const { grid } = map;
  const set = (patch: Parameters<MapActions['updateGrid']>[1]) => actions.updateGrid(map.id, patch);

  return (
    <section className="panel">
      <h3>Сетка</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={grid.visible}
          onChange={(e) => set({ visible: e.target.checked })}
        />
        Показывать сетку
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={grid.snap}
          onChange={(e) => set({ snap: e.target.checked })}
        />
        Фишки встают в клетки
      </label>

      <SliderField
        label="Размер клетки, px"
        value={grid.scale}
        min={GRID_SCALE_MIN}
        max={GRID_SCALE_MAX}
        onChange={(scale) => set({ scale })}
      />
      <SliderField
        label="Смещение по X, px"
        value={grid.offsetX}
        min={0}
        max={Math.ceil(grid.scale)}
        onChange={(offsetX) => set({ offsetX })}
      />
      <SliderField
        label="Смещение по Y, px"
        value={grid.offsetY}
        min={0}
        max={Math.ceil(grid.scale)}
        onChange={(offsetY) => set({ offsetY })}
      />

      <button
        type="button"
        className={calibrating ? '' : 'secondary'}
        onClick={() => onCalibratingChange(!calibrating)}
      >
        {calibrating ? 'Отмена' : 'Подогнать по клетке'}
      </button>
      {calibrating && (
        <p className="hint">
          Растяните прямоугольник по одной клетке на карте — сетка подстроится.
        </p>
      )}
    </section>
  );
}

const round = (value: number) => Math.round(value * 10) / 10;

/** A slider for quick adjustment plus a number box for exact values (committed on Enter or blur). */
function SliderField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
}) {
  // While typing, the box shows what the user typed instead of the clamped, already applied value.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    const parsed = Number(draft?.replace(',', '.'));
    if (draft !== null && draft.trim() !== '' && Number.isFinite(parsed)) {
      onChange(Math.min(max, Math.max(min, parsed)));
    }
    setDraft(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') setDraft(null);
  };

  return (
    <div className="slider-field">
      <label>
        <span>{label}</span>
        <input
          type="number"
          step="any"
          min={min}
          max={max}
          value={draft ?? round(value)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </label>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step="any"
        value={Math.min(max, value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
