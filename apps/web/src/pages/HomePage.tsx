import { displayNameSchema, inviteCodeSchema } from '@dnd-map/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { createSession } from '../api';
import { getDisplayName, saveDisplayName, saveParticipantKey } from '../storage';

export function HomePage() {
  const navigate = useNavigate();
  const [name, setName] = useState(getDisplayName);
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = displayNameSchema.safeParse(name);
    if (!parsed.success) return setCreateError('Введите имя (до 32 символов)');

    setCreating(true);
    setCreateError(null);
    try {
      const { inviteCode, participantKey } = await createSession({ displayName: parsed.data });
      saveDisplayName(parsed.data);
      saveParticipantKey(inviteCode, participantKey);
      navigate(`/s/${inviteCode}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Не удалось создать сессию');
      setCreating(false);
    }
  };

  const onJoin = (e: FormEvent) => {
    e.preventDefault();
    const parsed = inviteCodeSchema.safeParse(code);
    if (!parsed.success) return setCodeError('Код состоит из 8 букв и цифр');
    navigate(`/s/${parsed.data}`);
  };

  return (
    <main className="page narrow">
      <h1>DnD Map</h1>
      <p className="muted">Интерактивная карта для настольных ролевых игр.</p>

      <form className="card" onSubmit={onCreate}>
        <h2>Новая партия</h2>
        <p className="muted">Вы станете Мастером и получите ссылку для игроков.</p>
        <label>
          Ваше имя
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            autoComplete="nickname"
            required
          />
        </label>
        {createError && <p className="error">{createError}</p>}
        <button type="submit" disabled={creating}>
          {creating ? 'Создаём…' : 'Создать сессию'}
        </button>
      </form>

      <form className="card" onSubmit={onJoin}>
        <h2>Присоединиться</h2>
        <label>
          Код приглашения
          <input
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setCodeError(null);
            }}
            placeholder="K7M2QX9P"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        {codeError && <p className="error">{codeError}</p>}
        <button type="submit" className="secondary">
          Войти
        </button>
      </form>
    </main>
  );
}
