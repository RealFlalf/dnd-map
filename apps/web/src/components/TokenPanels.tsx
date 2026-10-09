import { Panel } from './Panel';
import {
  cellOf,
  MONSTER_ICONS,
  TOKEN_SIZE_MAX,
  type GridSettings,
  type TokenView,
} from '@dnd-map/shared';
import { useState, type DragEvent, type KeyboardEvent } from 'react';
import type { ParticipantView } from '@dnd-map/shared';
import type { PlacementSpec, PlayerPlacement, TokenActions } from '../session/useSession';
import { PALETTE_MIME, serializePlacement } from './placement';
import { TokenIcon } from './TokenIcon';

const SIZE_CHOICES = Array.from({ length: Math.min(TOKEN_SIZE_MAX, 3) }, (_, i) => i + 1);

/** Master: pick a monster, then click the map or drag the icon onto it. */
export function MonsterPalette({
  placing,
  onPlacingChange,
}: {
  placing: PlacementSpec | null;
  onPlacingChange(spec: PlacementSpec | null): void;
}) {
  const [size, setSize] = useState(1);
  const [hidden, setHidden] = useState(false);
  const spec = (icon: string): PlacementSpec => ({ icon, size, visible: !hidden });

  // Changing size or visibility applies to what is being placed right now.
  const update = (change: { size?: number; hidden?: boolean }) => {
    if (change.size !== undefined) setSize(change.size);
    if (change.hidden !== undefined) setHidden(change.hidden);
    if (placing) {
      onPlacingChange({
        ...placing,
        size: change.size ?? size,
        visible: !(change.hidden ?? hidden),
      });
    }
  };

  const toggle = (icon: string) => onPlacingChange(placing?.icon === icon ? null : spec(icon));

  const onKeyDown = (e: KeyboardEvent, icon: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle(icon);
  };

  const onDragStart = (e: DragEvent, icon: string) => {
    e.dataTransfer.setData(PALETTE_MIME, serializePlacement(spec(icon)));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <Panel id="monsters" title={<>Мобы</>}>
      <div className="palette">
        {MONSTER_ICONS.map((icon) => (
          // A div, not a button: Firefox does not start drags from buttons.
          <div
            key={icon.id}
            role="button"
            tabIndex={0}
            draggable
            aria-pressed={placing?.icon === icon.id}
            title={icon.label}
            className={placing?.icon === icon.id ? 'palette-item active' : 'palette-item'}
            onClick={() => toggle(icon.id)}
            onKeyDown={(e) => onKeyDown(e, icon.id)}
            onDragStart={(e) => onDragStart(e, icon.id)}
          >
            <TokenIcon icon={`builtin:${icon.id}`} size={36} />
            <span>{icon.label}</span>
          </div>
        ))}
      </div>

      <div className="size-choice" role="group" aria-label="Размер фишки">
        <span>Размер:</span>
        {SIZE_CHOICES.map((n) => (
          <button
            key={n}
            type="button"
            className={n === size ? '' : 'secondary'}
            aria-pressed={n === size}
            onClick={() => update({ size: n })}
          >
            {n}×{n}
          </button>
        ))}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(e) => update({ hidden: e.target.checked })}
        />
        Ставить скрытыми от игроков
      </label>
      <p className="hint">
        Нажмите на значок и затем на карту — или перетащите значок на карту. Esc — закончить.
      </p>
    </Panel>
  );
}

/** Master: every token of the current map with its cell, plus show/hide and delete. */
export function TokenList({
  tokens,
  grid,
  selectedId,
  onSelect,
  actions,
}: {
  tokens: TokenView[];
  grid: GridSettings;
  selectedId: string | null;
  /** Selecting from the list also brings the token into view. */
  onSelect(token: TokenView): void;
  actions: Pick<TokenActions, 'remove' | 'setVisible'>;
}) {
  return (
    <Panel id="tokens" title={<>Фишки на карте ({tokens.length})</>}>
      {tokens.length === 0 ? (
        <p className="hint">Пока пусто.</p>
      ) : (
        <ul className="token-list">
          {tokens.map((token) => {
            const { col, row } = cellOf(grid, token);
            return (
              <li
                key={token.id}
                className={[token.id === selectedId && 'selected', !token.visible && 'is-hidden']
                  .filter(Boolean)
                  .join(' ')}
              >
                <button type="button" className="token-pick" onClick={() => onSelect(token)}>
                  <TokenIcon icon={token.icon} size={28} />
                  <span className="token-name">{token.name}</span>
                  <span className="token-cell" title="Клетка: колонка, ряд">
                    {col}, {row}
                  </span>
                </button>
                {/* Characters are always visible to everyone; only monsters can be hidden. */}
                {token.type === 'monster' && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={token.visible ? `Скрыть: ${token.name}` : `Показать: ${token.name}`}
                    title={token.visible ? 'Скрыть от игроков' : 'Показать игрокам'}
                    onClick={() => actions.setVisible(token.id, !token.visible)}
                  >
                    {token.visible ? '👁' : '🚫'}
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Удалить: ${token.name}`}
                  title={token.type === 'monster' ? 'Удалить' : 'Снять персонажа с карты'}
                  onClick={() => actions.remove(token.id)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** Master: players who have no character on this map yet, to be put there on their behalf. */
export function PlayersToPlace({
  players,
  placing,
  onPlacingChange,
}: {
  players: ParticipantView[];
  placing: PlayerPlacement | null;
  onPlacingChange(placement: PlayerPlacement | null): void;
}) {
  if (players.length === 0) return null;
  return (
    <Panel id="unplaced" title={<>Игроки без персонажа</>}>
      <ul className="token-list">
        {players.map((p) => {
          const active = placing?.forPlayer === p.id;
          return (
            <li key={p.id}>
              <span className="token-pick static">
                <TokenIcon icon={p.icon} size={28} />
                <span className="token-name">{p.displayName}</span>
                <span
                  className={p.online ? 'dot on' : 'dot'}
                  aria-label={p.online ? 'онлайн' : 'офлайн'}
                />
              </span>
              <button
                type="button"
                className={active ? '' : 'secondary'}
                aria-pressed={active}
                onClick={() =>
                  onPlacingChange(active ? null : { forPlayer: p.id, name: p.displayName })
                }
              >
                {active ? 'Отмена' : 'Поставить'}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="hint">Нажмите «Поставить» и затем на карту.</p>
    </Panel>
  );
}
