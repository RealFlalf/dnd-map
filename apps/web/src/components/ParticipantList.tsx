import { useState } from 'react';
import { Panel } from './Panel';
import type { ParticipantView } from '@dnd-map/shared';
import { TokenIcon } from './TokenIcon';

export function ParticipantList({
  participants,
  selfId,
  onRemove,
}: {
  participants: ParticipantView[];
  selfId: string;
  /** Master only: remove a player from the session (asked once more before it happens). */
  onRemove?: (participantId: string) => void;
}) {
  // Whose removal is waiting for a second click.
  const [confirming, setConfirming] = useState<string | null>(null);
  // Master first, then online players, then those who left.
  const sorted = [...participants].sort(
    (a, b) =>
      Number(b.role === 'master') - Number(a.role === 'master') ||
      Number(b.online) - Number(a.online),
  );

  return (
    <Panel
      id="participants"
      title={<>Участники ({participants.filter((p) => p.online).length} онлайн)</>}
    >
      <ul className="participants">
        {sorted.map((p) => (
          <li key={p.id} className={p.online ? '' : 'offline'}>
            <span
              className={p.online ? 'dot on' : 'dot'}
              aria-label={p.online ? 'онлайн' : 'офлайн'}
            />
            {p.role === 'player' && <TokenIcon icon={p.icon} size={22} />}
            <span className="name">
              {p.displayName}
              {p.id === selfId && ' (вы)'}
            </span>
            {p.role === 'master' && <span className="role">Мастер</span>}
            {onRemove && p.role === 'player' && confirming !== p.id && (
              <button
                type="button"
                className="secondary small"
                aria-label={`Удалить игрока ${p.displayName}`}
                onClick={() => setConfirming(p.id)}
              >
                Удалить
              </button>
            )}
            {onRemove && confirming === p.id && (
              <span className="confirm" role="group" aria-label={`Удалить ${p.displayName}?`}>
                <button
                  type="button"
                  className="danger small"
                  onClick={() => {
                    setConfirming(null);
                    onRemove(p.id);
                  }}
                >
                  Да, удалить
                </button>
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => setConfirming(null)}
                >
                  Отмена
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {onRemove && confirming && (
        <p className="hint">
          Игрок и его персонажи на всех картах будут удалены. По ссылке-приглашению он сможет войти
          снова, но уже как новый игрок.
        </p>
      )}
    </Panel>
  );
}
