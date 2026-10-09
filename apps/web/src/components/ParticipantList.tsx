import { Panel } from './Panel';
import type { ParticipantView } from '@dnd-map/shared';
import { TokenIcon } from './TokenIcon';

export function ParticipantList({
  participants,
  selfId,
}: {
  participants: ParticipantView[];
  selfId: string;
}) {
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
          </li>
        ))}
      </ul>
    </Panel>
  );
}
