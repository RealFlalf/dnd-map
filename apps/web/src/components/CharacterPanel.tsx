import {
  MAX_ICON_BYTES,
  PLAYER_ICONS,
  type ParticipantView,
  type TokenView,
} from '@dnd-map/shared';
import { useRef, useState } from 'react';
import type { CharacterActions, TokenActions } from '../session/useSession';
import { TokenIcon } from './TokenIcon';

interface Props {
  me: ParticipantView;
  /** The player's character on the current map, if it has been placed. */
  token: TokenView | null;
  hasMap: boolean;
  placing: boolean;
  onPlacingChange(value: boolean): void;
  characterActions: CharacterActions;
  tokenActions: Pick<TokenActions, 'remove'>;
}

/** Player: choose an icon, put the character on the map or take it off again. */
export function CharacterPanel({
  me,
  token,
  hasMap,
  placing,
  onPlacingChange,
  characterActions,
  tokenActions,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guarded = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить значок.');
    } finally {
      setBusy(false);
    }
  };

  const pick = (iconId: string) =>
    guarded(async () => {
      const res = await characterActions.setIcon(iconId);
      if (!res.ok) throw new Error('Не удалось сменить значок.');
    });

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void guarded(() => characterActions.uploadIcon(file)).finally(() => {
      if (input.current) input.current.value = ''; // allow choosing the same file again
    });
  };

  return (
    <section className="panel">
      <h3>Мой персонаж</h3>
      <div className="character-head">
        <TokenIcon icon={me.icon} size={48} />
        <strong>{me.displayName}</strong>
      </div>

      {token ? (
        <>
          <p className="hint">Ваша фишка на карте — перетащите её, чтобы походить.</p>
          <button type="button" className="secondary" onClick={() => tokenActions.remove(token.id)}>
            Убрать с карты
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={placing ? '' : 'secondary'}
            disabled={!hasMap}
            onClick={() => onPlacingChange(!placing)}
          >
            {placing ? 'Отмена' : 'Поставить на карту'}
          </button>
          {!hasMap && <p className="hint">Мастер ещё не загрузил карту.</p>}
        </>
      )}

      <h3>Значок</h3>
      <div className="icon-grid">
        {PLAYER_ICONS.map((icon) => (
          <button
            key={icon.id}
            type="button"
            title={icon.label}
            aria-label={icon.label}
            aria-pressed={me.icon === `builtin:${icon.id}`}
            className={me.icon === `builtin:${icon.id}` ? 'icon-choice active' : 'icon-choice'}
            disabled={busy}
            onClick={() => void pick(icon.id)}
          >
            <TokenIcon icon={`builtin:${icon.id}`} size={34} />
          </button>
        ))}
      </div>

      <input
        ref={input}
        type="file"
        hidden
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? 'Сохраняем…' : 'Загрузить свой значок'}
      </button>
      <p className="hint">
        JPG, PNG или WebP до {MAX_ICON_BYTES / 1024 / 1024} МБ. Картинка обрежется по центру до
        квадрата и будет показана кругом.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
