import { Panel } from './Panel';
import { FOG_RADIUS_MAX, FOG_RADIUS_MIN, type FogState } from '@dnd-map/shared';
import type { FogActions } from '../session/useSession';
import { SliderField } from './MapControls';

interface Props {
  fog: FogState;
  actions: FogActions;
  /** The master looks at the map the way the players do. */
  preview: boolean;
  onPreviewChange(value: boolean): void;
  hasCharacters: boolean;
}

/** Master: fog of war — players see only as far as their characters do, and not through walls. */
export function FogPanel({ fog, actions, preview, onPreviewChange, hasCharacters }: Props) {
  return (
    <Panel id="fog" title={<>Туман войны</>}>
      <label className="check">
        <input
          type="checkbox"
          checked={fog.enabled}
          onChange={(e) => actions.update({ enabled: e.target.checked })}
        />
        Включить туман
      </label>
      {fog.enabled && (
        <>
          <SliderField
            label="Обзор, клеток"
            value={fog.radius}
            min={FOG_RADIUS_MIN}
            max={FOG_RADIUS_MAX}
            onChange={(radius) => actions.update({ radius: Math.round(radius * 2) / 2 })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={preview}
              onChange={(e) => onPreviewChange(e.target.checked)}
            />
            Смотреть как игроки
          </label>
          {!hasCharacters && (
            <p className="hint">Поставьте на карту персонажей — без них вся карта затемнена.</p>
          )}
        </>
      )}
      <p className="hint">
        Карта и препятствия видны игрокам всегда, но вне обзора затемнены. Мобов вне обзора (и
        сквозь стены и столбы) игроки не видят — они им даже не отправляются. Обзор общий у всех
        персонажей.
      </p>
    </Panel>
  );
}
