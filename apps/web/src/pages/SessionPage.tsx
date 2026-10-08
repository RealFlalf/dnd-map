import { can, displayNameSchema, type JoinError, type TokenView } from '@dnd-map/shared';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { MapCanvas } from '../components/MapCanvas';
import { MapControls } from '../components/MapControls';
import { ParticipantList } from '../components/ParticipantList';
import { CharacterPanel } from '../components/CharacterPanel';
import { MonsterPalette, TokenList } from '../components/TokenPanels';
import {
  useSession,
  type CharacterActions,
  type MapActions,
  type PlacementSpec,
  type RemoteDrags,
  type SessionState,
  type TokenActions,
} from '../session/useSession';
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
  const { state, joinAsPlayer, mapActions, tokenActions, characterActions, remoteDrags } =
    useSession(inviteCode);

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
        <JoinedView
          state={state}
          actions={mapActions}
          tokenActions={tokenActions}
          characterActions={characterActions}
          remoteDrags={remoteDrags}
        />
      );
  }
}

type Joined = Extract<SessionState, { status: 'joined' }>;

const placeErrors: Record<string, string> = {
  too_many_tokens: 'На карте уже максимум фишек. Удалите ненужные.',
  map_not_found: 'Сначала загрузите карту.',
  forbidden: 'Фишки мобов может ставить только Мастер.',
  already_placed: 'Ваш персонаж уже стоит на этой карте.',
};

function JoinedView({
  state,
  actions,
  tokenActions,
  characterActions,
  remoteDrags,
}: {
  state: Joined;
  actions: MapActions;
  tokenActions: TokenActions;
  characterActions: CharacterActions;
  remoteDrags: RemoteDrags;
}) {
  const [calibrating, setCalibrating] = useState(false);
  const [placing, setPlacing] = useState<PlacementSpec | 'character' | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ x: number; y: number; nonce: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { world, self } = state;
  const isMaster = self.role === 'master';
  const currentMap = world.maps.find((m) => m.id === world.currentMapId) ?? null;
  // The participant list is kept fresh by the server (icons change), `self` is the join-time snapshot.
  const me = state.participants.find((p) => p.id === self.id) ?? self;
  const myCharacter =
    world.tokens.find((t) => t.type === 'player_character' && t.ownerParticipantId === self.id) ??
    null;
  // A selection of a token that is gone (deleted, hidden, other map) simply stops applying.
  const selected = world.tokens.find((t) => t.id === selectedId) ?? null;

  const canMove = useCallback(
    (t: TokenView) =>
      can({ participantId: self.id, role: self.role }, 'token.move', {
        type: t.type,
        ownerParticipantId: t.ownerParticipantId,
      }),
    [self.id, self.role],
  );

  const canDelete = useCallback(
    (t: TokenView) =>
      can({ participantId: self.id, role: self.role }, 'token.delete', {
        type: t.type,
        ownerParticipantId: t.ownerParticipantId,
      }),
    [self.id, self.role],
  );

  const place = useCallback(
    async (spec: PlacementSpec | 'character', x: number, y: number) => {
      const res =
        spec === 'character'
          ? await tokenActions.placeCharacter(x, y)
          : await tokenActions.create(spec, x, y);
      if (!res.ok) setNotice(placeErrors[res.error] ?? 'Не удалось поставить фишку.');
      // A character is placed once; monsters can be placed repeatedly while the mode stays on.
      else if (spec === 'character') setPlacing(null);
    },
    [tokenActions],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Keyboard: Esc leaves placing mode and clears the selection; Delete removes the selected token.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === 'Escape') {
        setPlacing(null);
        setCalibrating(false);
        setSelectedId(null);
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !typing &&
        selected &&
        canDelete(selected)
      ) {
        e.preventDefault();
        tokenActions.remove(selected.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canDelete, selected, tokenActions]);

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
        <section className="map-area">
          {currentMap ? (
            <MapCanvas
              map={currentMap}
              calibrating={calibrating && isMaster}
              onCalibrated={(result) => {
                actions.updateGrid(currentMap.id, result);
                setCalibrating(false);
              }}
              tokens={{
                list: world.tokens,
                selectedId: selected?.id ?? null,
                canMove,
                remoteDrags,
                onSelect: setSelectedId,
                onDrag: tokenActions.drag,
                onMove: tokenActions.move,
              }}
              placing={calibrating ? null : placing}
              onPlace={(spec, x, y) => void place(spec, x, y)}
              focus={focus}
            />
          ) : (
            <p className="muted map-placeholder">
              {isMaster
                ? 'Загрузите изображение карты в панели справа.'
                : 'Мастер ещё не загрузил карту.'}
            </p>
          )}
          {notice && (
            <div className="toast" role="status">
              {notice}
            </div>
          )}
        </section>
        <aside className="sidebar">
          <p>
            Вы — <strong>{self.displayName}</strong>, {isMaster ? 'Мастер' : 'Игрок'}
          </p>
          {isMaster && <InviteBox inviteCode={state.inviteCode} />}
          {isMaster && (
            <MapControls
              world={world}
              actions={actions}
              calibrating={calibrating}
              onCalibratingChange={(value) => {
                setCalibrating(value);
                if (value) setPlacing(null);
              }}
            />
          )}
          {!isMaster && (
            <CharacterPanel
              me={me}
              token={myCharacter}
              hasMap={!!currentMap}
              placing={placing === 'character'}
              onPlacingChange={(value) => setPlacing(value ? 'character' : null)}
              characterActions={characterActions}
              tokenActions={tokenActions}
            />
          )}
          {isMaster && currentMap && (
            <>
              <MonsterPalette
                placing={placing === 'character' ? null : placing}
                onPlacingChange={setPlacing}
              />
              <TokenList
                tokens={world.tokens}
                grid={currentMap.grid}
                selectedId={selected?.id ?? null}
                onSelect={(token) => {
                  setSelectedId(token.id);
                  setFocus({ x: token.x, y: token.y, nonce: Date.now() });
                }}
                actions={tokenActions}
              />
            </>
          )}
          <ParticipantList participants={state.participants} selfId={self.id} />
        </aside>
      </div>
    </div>
  );
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
