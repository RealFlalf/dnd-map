import {
  can,
  cellOf,
  describeCells,
  displayNameSchema,
  OBSTACLE_KINDS,
  type ObstacleKind,
  type Point,
  type JoinError,
  type TokenView,
} from '@dnd-map/shared';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { MapCanvas } from '../components/MapCanvas';
import { MapControls } from '../components/MapControls';
import { ObstaclePanel } from '../components/ObstaclePanel';
import type { ObstacleTool } from '../components/obstacleTools';
import { ParticipantList } from '../components/ParticipantList';
import { CharacterPanel } from '../components/CharacterPanel';
import { MonsterPalette, PlayersToPlace, TokenList } from '../components/TokenPanels';
import {
  useSession,
  type CharacterActions,
  type MapActions,
  type ObstacleActions,
  isPlayerPlacement,
  monsterPlacing,
  type Placing,
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
  rate_limited: 'Слишком много запросов. Подождите минуту и обновите страницу.',
  internal: 'Ошибка сервера. Попробуйте обновить страницу.',
  network: 'Сервер недоступен. Проверьте соединение и обновите страницу.',
};

export function SessionPage() {
  const { inviteCode = '' } = useParams();
  const {
    state,
    outdated,
    joinAsPlayer,
    mapActions,
    tokenActions,
    characterActions,
    remoteDrags,
    characterNotice,
    obstacleActions,
    actionNotice,
  } = useSession(inviteCode);

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
          outdated={outdated}
          characterNotice={characterNotice}
          obstacleActions={obstacleActions}
          actionNotice={actionNotice}
        />
      );
  }
}

type Joined = Extract<SessionState, { status: 'joined' }>;

const placeErrors: Record<string, string> = {
  too_many_tokens: 'На карте уже максимум фишек. Удалите ненужные.',
  map_not_found: 'Сначала загрузите карту.',
  forbidden: 'Фишки мобов может ставить только Мастер.',
  participant_not_found: 'Такого игрока в сессии нет.',
  already_placed: 'Ваш персонаж уже стоит на этой карте.',
  offline: 'Нет связи с сервером — действие не выполнено.',
  rate_limited: 'Слишком быстро. Подождите секунду.',
  blocked: 'Здесь препятствие: поставить нельзя.',
  too_many_obstacles: 'На карте уже максимум препятствий.',
  invalid_request: 'Сюда поставить нельзя.',
};

function JoinedView({
  state,
  actions,
  tokenActions,
  characterActions,
  remoteDrags,
  outdated,
  characterNotice,
  obstacleActions,
  actionNotice,
}: {
  obstacleActions: ObstacleActions;
  actionNotice: { text: string; nonce: number } | null;
  outdated: boolean;
  characterNotice: { text: string; nonce: number } | null;
  state: Joined;
  actions: MapActions;
  tokenActions: TokenActions;
  characterActions: CharacterActions;
  remoteDrags: RemoteDrags;
}) {
  const [calibrating, setCalibrating] = useState(false);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<ObstacleTool | null>(null);
  const [selectedObstacleId, setSelectedObstacleId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ x: number; y: number; nonce: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { world, self } = state;
  const offline = !state.connected;
  const isMaster = self.role === 'master';
  const currentMap = world.maps.find((m) => m.id === world.currentMapId) ?? null;
  // The participant list is kept fresh by the server (icons change), `self` is the join-time snapshot.
  const me = state.participants.find((p) => p.id === self.id) ?? self;
  const myCharacter =
    world.tokens.find((t) => t.type === 'player_character' && t.ownerParticipantId === self.id) ??
    null;
  const playersWithoutCharacter = state.participants.filter(
    (p) =>
      p.role === 'player' &&
      !world.tokens.some((t) => t.type === 'player_character' && t.ownerParticipantId === p.id),
  );
  // A selection of a token that is gone (deleted, hidden, other map) simply stops applying.
  const selected = world.tokens.find((t) => t.id === selectedId) ?? null;

  // Without a connection nothing can be moved: a drop would only have to be taken back.
  const selectedObstacle = world.obstacles.find((o) => o.id === selectedObstacleId) ?? null;

  const pickObstacle = useCallback(
    (obstacleId: string) => {
      if (!isMaster) return;
      if (tool === 'erase' && obstacleId) obstacleActions.remove(obstacleId);
      else {
        setSelectedObstacleId(obstacleId || null); // an empty id means "clicked on the bare map"
        if (obstacleId) setSelectedId(null);
      }
    },
    [isMaster, tool, obstacleActions],
  );

  const drawObstacle = useCallback(
    async (kind: ObstacleKind, from: Point, to: Point) => {
      const res = await obstacleActions.add(kind, from, to);
      if (!res.ok) setNotice(placeErrors[res.error] ?? 'Не удалось построить.');
    },
    [obstacleActions],
  );

  const canMove = useCallback(
    (t: TokenView) =>
      !offline &&
      can({ participantId: self.id, role: self.role }, 'token.move', {
        type: t.type,
        ownerParticipantId: t.ownerParticipantId,
      }),
    [offline, self.id, self.role],
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
    async (spec: Placing, x: number, y: number) => {
      const res =
        spec === 'character'
          ? await tokenActions.placeCharacter(x, y)
          : isPlayerPlacement(spec)
            ? await tokenActions.placeCharacter(x, y, spec.forPlayer)
            : await tokenActions.create(spec, x, y);
      if (!res.ok) setNotice(placeErrors[res.error] ?? 'Не удалось поставить фишку.');
      // A character is placed once; monsters can be placed repeatedly while the mode stays on.
      else if (spec === 'character' || isPlayerPlacement(spec)) setPlacing(null);
    },
    [tokenActions],
  );

  // On a phone the panels live in a sheet below the map. It starts open when there is nothing to
  // look at yet (no map) or the player still has to place a character, and closes when the user
  // starts placing or calibrating so that the whole map can be tapped.
  const [sheetOpen, setSheetOpen] = useState(() => !currentMap || (!isMaster && !myCharacter));
  useEffect(() => {
    if (placing || calibrating || tool) setSheetOpen(false);
  }, [placing, calibrating, tool]);
  // Starting to place something ends obstacle editing.
  useEffect(() => {
    if (placing) setTool(null);
  }, [placing]);

  // A reason why the last thing the user did did not work (e.g. a move into a wall).
  useEffect(() => {
    if (actionNotice) setNotice(actionNotice.text);
  }, [actionNotice]);

  useEffect(() => {
    if (offline) {
      setPlacing(null);
      setCalibrating(false);
      setTool(null);
    }
  }, [offline]);

  // Something the master did to my character: tell me, so that it does not look like a glitch.
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => {
    if (!characterNotice) return;
    setInfo(characterNotice.text);
    const timer = setTimeout(() => setInfo(null), 5000);
    return () => clearTimeout(timer);
  }, [characterNotice]);

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
        setTool(null);
        setSelectedObstacleId(null);
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !typing &&
        isMaster &&
        selectedObstacle
      ) {
        e.preventDefault();
        obstacleActions.remove(selectedObstacle.id);
        setSelectedObstacleId(null);
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
  }, [canDelete, isMaster, obstacleActions, selected, selectedObstacle, tokenActions]);

  return (
    <div className={offline ? 'session offline' : 'session'}>
      {outdated && (
        <div className="update-banner" role="alert">
          Вышла новая версия приложения.
          <button type="button" onClick={() => window.location.reload()}>
            Обновить страницу
          </button>
        </div>
      )}
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
              obstacles={{
                list: world.obstacles,
                selectedId: selectedObstacle?.id ?? null,
                tool: isMaster ? tool : null,
                stopsTokens: !isMaster,
                onPick: pickObstacle,
                onDraw: (kind, from, to) => void drawObstacle(kind, from, to),
              }}
              tokens={{
                list: world.tokens,
                selectedId: selected?.id ?? null,
                canMove,
                remoteDrags,
                onSelect: (id) => {
                  setSelectedId(id);
                  if (id) setSelectedObstacleId(null);
                },
                onDrag: tokenActions.drag,
                onMove: tokenActions.move,
              }}
              placing={calibrating || tool ? null : placing}
              onPlace={(spec, x, y) => void place(spec, x, y)}
              focus={focus}
            />
          ) : null}
          {currentMap ? (
            // The canvas is a picture to assistive technology; this list says what is on it.
            <ul className="sr-only" aria-label="Препятствия">
              {world.obstacles.map((o) => (
                <li key={o.id}>
                  {OBSTACLE_KINDS[o.kind].label}, клетки {describeCells(currentMap.grid, o)}
                  {o.blocksSight ? '' : ' (не закрывает обзор)'}
                </li>
              ))}
            </ul>
          ) : null}
          {currentMap ? (
            <ul className="sr-only" aria-label="Фишки на карте" aria-live="polite">
              {world.tokens.map((t) => {
                const { col, row } = cellOf(currentMap.grid, t);
                return (
                  <li key={t.id} data-token-id={t.id}>
                    {t.name}, клетка {col}, {row}
                    {t.visible ? '' : ' (скрыт от игроков)'}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted map-placeholder">
              {isMaster
                ? 'Загрузите изображение карты в панели справа.'
                : 'Мастер ещё не загрузил карту.'}
            </p>
          )}
          {offline && (
            <div className="map-hint offline-pill" role="status">
              Нет связи — переподключаемся…
            </div>
          )}
          {info && !notice && (
            <div className="toast info" role="status">
              {info}
            </div>
          )}
          {notice && (
            <div className="toast" role="status">
              {notice}
            </div>
          )}
        </section>
        <button
          type="button"
          className="sheet-handle"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen((open) => !open)}
        >
          {sheetOpen ? 'Скрыть панель ▾' : 'Панель ▴'}
        </button>
        <aside className={sheetOpen ? 'sidebar open' : 'sidebar'}>
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
                if (value) {
                  setPlacing(null);
                  setTool(null);
                }
              }}
            />
          )}
          {isMaster && currentMap && (
            <ObstaclePanel
              tool={tool}
              onToolChange={(next) => {
                setTool(next);
                if (next) {
                  setPlacing(null);
                  setCalibrating(false);
                }
              }}
              grid={currentMap.grid}
              obstacles={world.obstacles}
              selected={selectedObstacle}
              actions={obstacleActions}
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
              <MonsterPalette placing={monsterPlacing(placing)} onPlacingChange={setPlacing} />
              <PlayersToPlace
                players={playersWithoutCharacter}
                placing={isPlayerPlacement(placing) ? placing : null}
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
