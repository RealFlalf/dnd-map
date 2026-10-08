import { displayNameSchema, type JoinError } from '@dnd-map/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ParticipantList } from '../components/ParticipantList';
import { useSession } from '../session/useSession';
import { getDisplayName, saveDisplayName } from '../storage';

const errorText: Record<JoinError | 'network', string> = {
  invalid_request: 'Проверьте имя и попробуйте ещё раз.',
  session_not_found: 'Сессия не найдена.',
  unknown_participant: 'Не удалось восстановить участника.',
  session_full: 'В сессии уже максимум участников.',
  internal: 'Ошибка сервера. Попробуйте обновить страницу.',
  network: 'Сервер недоступен. Проверьте соединение и обновите страницу.',
};

export function SessionPage() {
  const { inviteCode = '' } = useParams();
  const { state, joinAsPlayer } = useSession(inviteCode);

  switch (state.status) {
    case 'loading':
    case 'joining':
      return <Centered>Подключение…</Centered>;

    case 'not_found':
      return (
        <Centered>
          <p>Сессия с кодом «{inviteCode}» не найдена.</p>
          <Link to="/">На главную</Link>
        </Centered>
      );

    case 'failed':
      return (
        <Centered>
          <p className="error">{errorText[state.error]}</p>
          <Link to="/">На главную</Link>
        </Centered>
      );

    case 'need_name':
      return (
        <JoinForm
          error={state.error && errorText[state.error]}
          onSubmit={(name) => {
            saveDisplayName(name);
            joinAsPlayer(name);
          }}
        />
      );

    case 'joined':
      return (
        <div className="session">
          <header className="session-header">
            <Link to="/" className="brand">
              DnD Map
            </Link>
            <span className={state.connected ? 'badge ok' : 'badge warn'}>
              {state.connected ? 'На связи' : 'Нет связи, переподключаемся…'}
            </span>
          </header>
          <div className="session-body">
            <section className="map-placeholder">
              <p className="muted">
                {state.self.role === 'master'
                  ? 'Здесь появится карта: загрузка изображения и настройка сетки — следующий этап.'
                  : 'Мастер ещё не загрузил карту.'}
              </p>
            </section>
            <aside className="sidebar">
              <p>
                Вы — <strong>{state.self.displayName}</strong>,{' '}
                {state.self.role === 'master' ? 'Мастер' : 'Игрок'}
              </p>
              {state.self.role === 'master' && <InviteBox inviteCode={state.inviteCode} />}
              <ParticipantList participants={state.participants} selfId={state.self.id} />
            </aside>
          </div>
        </div>
      );
  }
}

function Centered({ children }: { children: ReactNode }) {
  return <main className="page narrow centered">{children}</main>;
}

function JoinForm({ error, onSubmit }: { error?: string; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(getDisplayName);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = displayNameSchema.safeParse(name);
    if (!parsed.success) return setLocalError('Введите имя (до 32 символов)');
    onSubmit(parsed.data);
  };

  return (
    <main className="page narrow">
      <form className="card" onSubmit={submit}>
        <h2>Вход в партию</h2>
        <p className="muted">Вы присоединитесь как Игрок.</p>
        <label>
          Ваше имя
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            autoComplete="nickname"
            autoFocus
            required
          />
        </label>
        {(localError ?? error) && <p className="error">{localError ?? error}</p>}
        <button type="submit">Войти</button>
      </form>
    </main>
  );
}

function InviteBox({ inviteCode }: { inviteCode: string }) {
  const link = `${window.location.origin}/s/${inviteCode}`;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API is unavailable on plain http from another device; the link stays selectable.
    }
  };

  return (
    <div className="invite">
      <span className="muted">Код приглашения</span>
      <code className="invite-code">{inviteCode}</code>
      <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="secondary" onClick={copy}>
        {copied ? 'Скопировано' : 'Копировать ссылку'}
      </button>
    </div>
  );
}
