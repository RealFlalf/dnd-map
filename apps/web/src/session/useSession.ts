import {
  applyGridUpdate,
  canMove,
  placeToken,
  tokenRadius,
  PROTOCOL_VERSION,
  type ActionResult,
  type GridChanged,
  type GridSideEffects,
  shiftObstacle,
  type GridUpdate,
  type JoinError,
  type JoinRequest,
  type LineView,
  type ObstacleKind,
  type ObstaclesPatch,
  type ObstacleView,
  type Point,
  type ParticipantView,
  type SessionState as WorldState,
  type TokenDragging,
  type TokensPatch,
  type TokenView,
} from '@dnd-map/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLines } from './useLines';
import { findSession, uploadIcon, uploadMap } from '../api';
import { socket } from '../socket';
import { forgetParticipantKey, getParticipantKey, saveParticipantKey } from '../storage';

export type SessionState =
  | { status: 'loading' }
  | { status: 'not_found' }
  | { status: 'need_name'; error?: JoinError }
  | { status: 'joining' }
  | {
      status: 'joined';
      inviteCode: string;
      self: ParticipantView;
      participants: ParticipantView[];
      /** Maps, grid and tokens, kept in step with the server through snapshots and versioned patches. */
      world: WorldState;
      connected: boolean;
    }
  | { status: 'failed'; error: JoinError | 'network' };

export type GridPatch = Omit<GridUpdate, 'mapId'>;

export interface MapActions {
  /** Applies the change locally at once and sends it to the server, at most ~10 times per second. */
  updateGrid(mapId: string, patch: GridPatch): void;
  selectMap(mapId: string): Promise<ActionResult>;
  deleteMap(mapId: string): Promise<ActionResult>;
  /** Rejects with a user-readable message. */
  upload(file: File): Promise<void>;
}

export interface PlacementSpec {
  icon: string;
  size: number;
  visible: boolean;
}

/** The master is placing the character of this player. */
export interface PlayerPlacement {
  forPlayer: string;
  name: string;
}

/** What a click on the map places right now. */
export type Placing = PlacementSpec | 'character' | PlayerPlacement;

export const isPlayerPlacement = (placing: Placing | null): placing is PlayerPlacement =>
  typeof placing === 'object' && placing !== null && 'forPlayer' in placing;

/** The monster being placed, if that is what is being placed. */
export const monsterPlacing = (placing: Placing | null): PlacementSpec | null =>
  typeof placing === 'object' && placing !== null && 'icon' in placing ? placing : null;

export interface ObstacleActions {
  /** The server snaps the rectangle between the two points to whole cells. */
  add(kind: ObstacleKind, from: Point, to: Point): Promise<ActionResult>;
  remove(obstacleId: string): void;
  /** Shifts the obstacle by whole cells; shown at once, the server holds it back at the map's edge. */
  move(obstacleId: string, dCol: number, dRow: number): void;
  setSight(obstacleId: string, blocksSight: boolean): void;
  clear(): Promise<ActionResult>;
}

export interface FogActions {
  /** Changes the fog of the current map; shown at once, sent to the server at most every ~150 ms. */
  update(change: { enabled?: boolean; radius?: number }): void;
}

export interface TokenActions {
  create(spec: PlacementSpec, x: number, y: number): Promise<ActionResult>;
  /** Puts a character on the current map: the player's own, or (master) the given player's. */
  placeCharacter(x: number, y: number, participantId?: string): Promise<ActionResult>;
  /** Shows the token at its snapped position at once; the server's answer confirms or reverts it. */
  move(tokenId: string, x: number, y: number): void;
  /** Live position while dragging (throttled); other participants see the token follow. */
  drag(tokenId: string, x: number, y: number): void;
  remove(tokenId: string): void;
  setVisible(tokenId: string, visible: boolean): void;
}

export interface CharacterActions {
  /** Picks one of the shipped player icons (by id). */
  setIcon(iconId: string): Promise<ActionResult>;
  /** Rejects with a user-readable message. */
  uploadIcon(file: File): Promise<void>;
}

/** Positions of tokens that other participants are dragging right now. */
export type RemoteDrags = Readonly<Record<string, { x: number; y: number }>>;

const GRID_SEND_INTERVAL_MS = 100;
const FOG_SEND_INTERVAL_MS = 150;
const DRAG_SEND_INTERVAL_MS = 50;
/** A remote drag that goes quiet this long (e.g. the dragger lost connection) is forgotten. */
const REMOTE_DRAG_TIMEOUT_MS = 2000;

const applyTokensPatch = (tokens: TokenView[], patch: TokensPatch): TokenView[] => {
  const removed = new Set(patch.removedIds);
  const next = tokens.filter((t) => !removed.has(t.id));
  for (const token of patch.upserted) {
    const at = next.findIndex((t) => t.id === token.id);
    if (at >= 0) next[at] = token;
    else next.push(token);
  }
  return next;
};

/** What the server says the grid change did to the obstacles and (with fog) the area in sight. */
const withGridEffects = (
  world: WorldState,
  mapId: string,
  effects: GridSideEffects,
): WorldState => {
  if (mapId !== world.currentMapId) return world;
  return {
    ...world,
    obstacles: effects.obstacles
      ? applyObstaclesPatch(world.obstacles, { version: 0, ...effects.obstacles })
      : world.obstacles,
    fog: effects.fog ?? world.fog,
  };
};

const applyObstaclesPatch = (list: ObstacleView[], patch: ObstaclesPatch): ObstacleView[] => {
  const removed = new Set(patch.removedIds);
  const next = list.filter((o) => !removed.has(o.id));
  for (const obstacle of patch.upserted) {
    const at = next.findIndex((o) => o.id === obstacle.id);
    if (at >= 0) next[at] = obstacle;
    else next.push(obstacle);
  }
  return next;
};

/**
 * Connects to a session and keeps the membership alive across reconnects:
 * every (re)connect re-sends `session.join` with the stored participant key.
 */
export function useSession(rawInviteCode: string) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [remoteDrags, setRemoteDrags] = useState<RemoteDrags>({});
  /** The server speaks a newer protocol than this page: the page must be reloaded. */
  const [outdated, setOutdated] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // What to send on the next connect; switches to the key once the server has issued one.
  const request = useRef<JoinRequest | null>(null);
  // Latest world, readable from socket handlers without waiting for a render.
  const worldRef = useRef<WorldState | null>(null);
  const gridQueue = useRef<{
    mapId: string;
    pending: GridPatch | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ mapId: '', pending: null, timer: null });
  /** Who I am (set on join); used to recognise changes to my own character made by someone else. */
  const selfId = useRef<string | null>(null);
  const selfRole = useRef<'master' | 'player' | null>(null);
  /** Why something the user just did did not work (a move into a wall, ...). */
  const [actionNotice, setActionNotice] = useState<{ text: string; nonce: number } | null>(null);
  const [characterNotice, setCharacterNotice] = useState<{ text: string; nonce: number } | null>(
    null,
  );
  /** Temporary lines the server still had when we (re)joined. */
  const [lineSeed, setLineSeed] = useState<{ lines: LineView[]; nonce: number } | null>(null);
  const dragTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastDragSent = useRef(0);

  const applyWorld = useCallback((world: WorldState) => {
    worldRef.current = world;
    setState((s) => (s.status === 'joined' ? { ...s, world } : s));
  }, []);

  const forgetRemoteDrags = useCallback((ids?: string[]) => {
    const timers = dragTimers.current;
    for (const id of ids ?? [...timers.keys()]) {
      clearTimeout(timers.get(id));
      timers.delete(id);
    }
    setRemoteDrags((drags) => {
      if (!ids) return Object.keys(drags).length ? {} : drags;
      if (!ids.some((id) => id in drags)) return drags;
      const next = { ...drags };
      for (const id of ids) delete next[id];
      return next;
    });
  }, []);

  /** Asks the server for the full state; used after a missed update or a rejected change. */
  const resync = useCallback(async () => {
    try {
      const world = await socket.timeout(5000).emitWithAck('state.sync');
      if (world && world.version >= (worldRef.current?.version ?? 0)) {
        applyWorld(world);
        forgetRemoteDrags();
      }
    } catch {
      // Offline: the next successful join delivers fresh state anyway.
    }
  }, [applyWorld, forgetRemoteDrags]);

  const sendJoin = useCallback(async () => {
    const req = request.current;
    if (!req) return;
    let result;
    try {
      result = await socket.timeout(5000).emitWithAck('session.join', req);
    } catch {
      return; // no ack: the disconnect/reconnect cycle will retry
    }

    if (result.ok) {
      if (result.participantKey) saveParticipantKey(result.inviteCode, result.participantKey);
      const key = result.participantKey ?? ('key' in req ? req.key : undefined);
      if (key) request.current = { inviteCode: result.inviteCode, key };
      selfId.current = result.self.id;
      selfRole.current = result.self.role;
      worldRef.current = result.state;
      forgetRemoteDrags();
      setLineSeed({ lines: result.lines, nonce: Date.now() });
      setState({
        status: 'joined',
        inviteCode: result.inviteCode,
        self: result.self,
        participants: result.participants,
        world: result.state,
        connected: true,
      });
      return;
    }

    request.current = null;
    socket.disconnect();
    if (result.error === 'unknown_participant') {
      // The stored key is stale (e.g. the database was reset): join again as a new player.
      forgetParticipantKey(req.inviteCode);
      setState({ status: 'need_name' });
    } else if (result.error === 'session_not_found') {
      setState({ status: 'not_found' });
    } else if (result.error === 'invalid_request') {
      setState({ status: 'need_name', error: result.error });
    } else {
      setState({ status: 'failed', error: result.error });
    }
  }, [forgetRemoteDrags]);

  useEffect(() => {
    let cancelled = false;
    const queue = gridQueue.current;
    const timers = dragTimers.current;
    /** Tells a player when somebody else (the master) moved, placed or removed their character. */
    const announceChangesToMyCharacter = (before: TokenView[], patch: TokensPatch) => {
      const me = selfId.current;
      // My own changes are never sent back to me (the server skips the sender), so anything that
      // arrives here about my character was done by somebody else.
      if (!me) return;
      const isMine = (t: TokenView) => t.type === 'player_character' && t.ownerParticipantId === me;
      const mine = before.find(isMine);
      const now = patch.upserted.find(isMine);
      let text: string | null = null;
      if (mine && now && (mine.x !== now.x || mine.y !== now.y)) {
        text = 'Мастер переместил вашего персонажа';
      } else if (!mine && now) {
        text = 'Мастер поставил вашего персонажа на карту';
      } else if (mine && patch.removedIds.includes(mine.id)) {
        text = 'Мастер убрал вашего персонажа с карты';
      }
      if (text) setCharacterNotice({ text, nonce: Date.now() });
    };
    const onConnect = () => {
      clearTimeout(reconnectTimer.current);
      void sendJoin();
    };
    const onDisconnect = (reason: string) => {
      setState((s) => (s.status === 'joined' ? { ...s, connected: false } : s));
      // When the server closes a connection itself (a deploy, flood protection) socket.io does not
      // reconnect on its own. Come back after a random pause so that nobody storms the new server together.
      if (reason === 'io server disconnect' && request.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(() => socket.connect(), 1000 + Math.random() * 2000);
      }
    };
    const onHello = ({ protocolVersion }: { protocolVersion: number }) =>
      setOutdated(protocolVersion !== PROTOCOL_VERSION);
    // A phone that slept or lost its network does not notice quickly; look again when it wakes up.
    const onWake = () => {
      if (document.visibilityState !== 'visible' || !request.current) return;
      if (!socket.connected) socket.connect();
      else void resync();
    };
    const onParticipants = (participants: ParticipantView[]) =>
      setState((s) => (s.status === 'joined' ? { ...s, participants } : s));
    const onSnapshot = (world: WorldState) => {
      if (!worldRef.current || world.version >= worldRef.current.version) {
        applyWorld(world);
        forgetRemoteDrags();
      }
    };
    const onGridChanged = (change: GridChanged) => {
      const world = worldRef.current;
      if (!world || change.version <= world.version) return;
      if (change.version > world.version + 1) return void resync(); // an update was missed
      applyWorld({
        ...withGridEffects(world, change.mapId, change),
        version: change.version,
        maps: world.maps.map((m) => (m.id === change.mapId ? { ...m, grid: change.grid } : m)),
      });
    };
    const onTokensChanged = (patch: TokensPatch) => {
      const world = worldRef.current;
      if (!world || patch.version <= world.version) return;
      if (patch.version > world.version + 1) return void resync();
      announceChangesToMyCharacter(world.tokens, patch);
      applyWorld({
        ...world,
        version: patch.version,
        tokens: applyTokensPatch(world.tokens, patch),
      });
      forgetRemoteDrags([...patch.upserted.map((t) => t.id), ...patch.removedIds]);
    };
    const onObstaclesChanged = (patch: ObstaclesPatch) => {
      const world = worldRef.current;
      if (!world || patch.version <= world.version) return;
      if (patch.version > world.version + 1) return void resync();
      applyWorld({
        ...world,
        version: patch.version,
        obstacles: applyObstaclesPatch(world.obstacles, patch),
      });
    };
    const onTokenDragging = ({ tokenId, x, y }: TokenDragging) => {
      setRemoteDrags((drags) => ({ ...drags, [tokenId]: { x, y } }));
      clearTimeout(timers.get(tokenId));
      timers.set(
        tokenId,
        setTimeout(() => forgetRemoteDrags([tokenId]), REMOTE_DRAG_TIMEOUT_MS),
      );
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('system.hello', onHello);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    socket.on('session.participants', onParticipants);
    socket.on('state.snapshot', onSnapshot);
    socket.on('grid.changed', onGridChanged);
    socket.on('tokens.changed', onTokensChanged);
    socket.on('obstacles.changed', onObstaclesChanged);
    socket.on('token.dragging', onTokenDragging);

    findSession(rawInviteCode)
      .then((inviteCode) => {
        if (cancelled) return;
        if (!inviteCode) return setState({ status: 'not_found' });
        const key = getParticipantKey(inviteCode);
        if (!key) return setState({ status: 'need_name' });
        request.current = { inviteCode, key };
        setState({ status: 'joining' });
        socket.connect();
      })
      .catch(() => !cancelled && setState({ status: 'failed', error: 'network' }));

    return () => {
      cancelled = true;
      request.current = null;
      worldRef.current = null;
      if (queue.timer) clearTimeout(queue.timer);
      queue.timer = null;
      queue.pending = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      clearTimeout(reconnectTimer.current);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
      socket.off('system.hello', onHello);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('session.participants', onParticipants);
      socket.off('state.snapshot', onSnapshot);
      socket.off('grid.changed', onGridChanged);
      socket.off('tokens.changed', onTokensChanged);
      socket.off('obstacles.changed', onObstaclesChanged);
      socket.off('token.dragging', onTokenDragging);
      socket.disconnect();
    };
  }, [rawInviteCode, sendJoin, applyWorld, resync, forgetRemoteDrags]);

  const joinAsPlayer = useCallback(
    (displayName: string) => {
      request.current = { inviteCode: rawInviteCode, displayName };
      setState({ status: 'joining' });
      if (socket.connected) void sendJoin();
      else socket.connect();
    },
    [rawInviteCode, sendJoin],
  );

  const mapActions = useMemo<MapActions>(() => {
    const queue = gridQueue.current;

    const send = () => {
      if (!queue.pending) return;
      const payload = { mapId: queue.mapId, ...queue.pending };
      queue.pending = null;
      socket
        .timeout(5000)
        .emitWithAck('grid.update', payload)
        .then((res) => {
          if (!res.ok) return resync(); // refused: drop the optimistic change
          // Events are ordered per connection, so anything before this ack has been applied already.
          const world = worldRef.current;
          if (!world) return;
          applyWorld({
            ...withGridEffects(world, payload.mapId, res),
            version: Math.max(world.version, res.version),
          });
        })
        .catch(() => resync());
    };

    // Leading and trailing edge: the first change goes out at once, later ones are merged per interval.
    const tick = () => {
      queue.timer = null;
      if (!queue.pending) return;
      send();
      queue.timer = setTimeout(tick, GRID_SEND_INTERVAL_MS);
    };

    const run = async (
      event: 'map.select' | 'map.delete',
      mapId: string,
    ): Promise<ActionResult> => {
      if (!socket.connected) return { ok: false, error: 'offline' };
      try {
        const res = await socket.timeout(5000).emitWithAck(event, { mapId });
        if (!res.ok) void resync();
        return res;
      } catch {
        return { ok: false, error: 'internal' };
      }
    };

    return {
      updateGrid(mapId, patch) {
        if (!socket.connected) return; // the sliders are disabled offline; never queue stale edits
        if (queue.pending && queue.mapId !== mapId) send();
        const world = worldRef.current;
        if (world) {
          applyWorld({
            ...world,
            maps: world.maps.map((m) =>
              m.id === mapId ? { ...m, grid: applyGridUpdate(m.grid, patch) } : m,
            ),
          });
        }
        queue.mapId = mapId;
        queue.pending = { ...queue.pending, ...patch };
        if (!queue.timer) tick();
      },
      selectMap: (mapId) => run('map.select', mapId),
      deleteMap: (mapId) => run('map.delete', mapId),
      async upload(file) {
        if (!socket.connected) throw new Error('Нет связи с сервером.');
        const req = request.current;
        const key = req && 'key' in req ? req.key : undefined;
        if (!req || !key) throw new Error('Нет подключения к сессии.');
        await uploadMap(req.inviteCode, key, file);
      },
    };
  }, [applyWorld, resync]);

  const tokenActions = useMemo<TokenActions>(() => {
    /** Applies the server's version of a token. Acks arrive in order with other events, so a gap means a loss. */
    const confirm = (version: number, change: (tokens: TokenView[]) => TokenView[]) => {
      const world = worldRef.current;
      if (!world) return;
      if (version > world.version + 1) return void resync();
      applyWorld({
        ...world,
        version: Math.max(world.version, version),
        tokens: change(world.tokens),
      });
    };

    const replace = (token: TokenView) => (tokens: TokenView[]) =>
      applyTokensPatch(tokens, { version: 0, upserted: [token], removedIds: [] });

    /** Optimistic local edit of one token, if it exists. */
    const edit = (tokenId: string, change: (token: TokenView) => TokenView | null) => {
      const world = worldRef.current;
      if (!world) return;
      applyWorld({
        ...world,
        tokens: world.tokens.flatMap((t) => (t.id === tokenId ? (change(t) ?? []) : [t])),
      });
    };

    return {
      async create(spec, x, y) {
        if (!socket.connected) return { ok: false, error: 'offline' };
        const world = worldRef.current;
        if (!world?.currentMapId) return { ok: false, error: 'map_not_found' };
        try {
          const res = await socket.timeout(5000).emitWithAck('token.create', {
            mapId: world.currentMapId,
            icon: spec.icon,
            size: spec.size,
            visible: spec.visible,
            x,
            y,
          });
          if (res.ok) confirm(res.version, replace(res.token));
          return res;
        } catch {
          return { ok: false, error: 'internal' };
        }
      },

      async placeCharacter(x, y, participantId) {
        if (!socket.connected) return { ok: false, error: 'offline' };
        const world = worldRef.current;
        if (!world?.currentMapId) return { ok: false, error: 'map_not_found' };
        try {
          const res = await socket.timeout(5000).emitWithAck('character.place', {
            mapId: world.currentMapId,
            x,
            y,
            ...(participantId && { participantId }),
          });
          if (res.ok) confirm(res.version, replace(res.token));
          return res;
        } catch {
          return { ok: false, error: 'internal' };
        }
      },

      move(tokenId, x, y) {
        const world = worldRef.current;
        const map = world?.maps.find((m) => m.id === world.currentMapId);
        if (!world || !map) return;
        if (!socket.connected) {
          // The drop is not sent. Publish a fresh copy of the token so it slides back to where the
          // server last had it (the token node follows its data, not where it was released).
          applyWorld({
            ...world,
            tokens: world.tokens.map((t) => (t.id === tokenId ? { ...t } : t)),
          });
          return;
        }
        const token = world.tokens.find((t) => t.id === tokenId);
        if (token && selfRole.current !== 'master') {
          const to = placeToken(map, token.size, { x, y });
          if (!canMove(token, to, tokenRadius(map.grid, token.size), world.obstacles).ok) {
            // The server would say no as well: do not even ask, and put the token back at once.
            applyWorld({
              ...world,
              tokens: world.tokens.map((t) => (t.id === tokenId ? { ...t } : t)),
            });
            setActionNotice({ text: 'Туда не пройти: мешает препятствие', nonce: Date.now() });
            return;
          }
        }
        edit(tokenId, (t) => ({ ...t, ...placeToken(map, t.size, { x, y }) }));
        socket
          .timeout(5000)
          .emitWithAck('token.move', { tokenId, x, y })
          .then((res) => {
            if (res.ok) return confirm(res.version, replace(res.token));
            if (res.error === 'blocked') {
              setActionNotice({ text: 'Туда не пройти: мешает препятствие', nonce: Date.now() });
            }
            return resync();
          })
          .catch(() => resync());
      },

      drag(tokenId, x, y) {
        if (!socket.connected) return;
        const now = performance.now();
        if (now - lastDragSent.current < DRAG_SEND_INTERVAL_MS) return;
        lastDragSent.current = now;
        socket.volatile.emit('token.drag', { tokenId, x, y });
      },

      remove(tokenId) {
        if (!socket.connected) return;
        edit(tokenId, () => null);
        socket
          .timeout(5000)
          .emitWithAck('token.delete', { tokenId })
          .then((res) => (res.ok ? confirm(res.version, (tokens) => tokens) : resync()))
          .catch(() => resync());
      },

      setVisible(tokenId, visible) {
        if (!socket.connected) return;
        edit(tokenId, (t) => ({ ...t, visible }));
        socket
          .timeout(5000)
          .emitWithAck('token.setVisibility', { tokenId, visible })
          .then((res) => (res.ok ? confirm(res.version, replace(res.token)) : resync()))
          .catch(() => resync());
      },
    };
  }, [applyWorld, resync]);

  const obstacleActions = useMemo<ObstacleActions>(() => {
    /** Applies the server's version of the obstacles; a gap in versions means a missed update. */
    const confirm = (version: number, change: (list: ObstacleView[]) => ObstacleView[]) => {
      const world = worldRef.current;
      if (!world) return;
      if (version > world.version + 1) return void resync();
      applyWorld({
        ...world,
        version: Math.max(world.version, version),
        obstacles: change(world.obstacles),
      });
    };
    const upsert = (o: ObstacleView) => (list: ObstacleView[]) =>
      applyObstaclesPatch(list, { version: 0, upserted: [o], removedIds: [] });
    /** Optimistic local edit of one obstacle. */
    const editLocal = (id: string, change: (o: ObstacleView) => ObstacleView | null) => {
      const world = worldRef.current;
      if (!world) return;
      applyWorld({
        ...world,
        obstacles: world.obstacles.flatMap((o) => (o.id === id ? (change(o) ?? []) : [o])),
      });
    };

    return {
      async add(kind, from, to) {
        if (!socket.connected) return { ok: false, error: 'offline' };
        const world = worldRef.current;
        if (!world?.currentMapId) return { ok: false, error: 'map_not_found' };
        try {
          const res = await socket
            .timeout(5000)
            .emitWithAck('obstacle.add', { mapId: world.currentMapId, kind, from, to });
          if (res.ok) confirm(res.version, upsert(res.obstacle));
          return res;
        } catch {
          return { ok: false, error: 'internal' };
        }
      },

      remove(obstacleId) {
        if (!socket.connected) return;
        editLocal(obstacleId, () => null);
        socket
          .timeout(5000)
          .emitWithAck('obstacle.remove', { obstacleId })
          .then((res) => (res.ok ? confirm(res.version, (list) => list) : resync()))
          .catch(() => resync());
      },

      move(obstacleId, dCol, dRow) {
        if (!socket.connected) return;
        const world = worldRef.current;
        const map = world?.maps.find((m) => m.id === world.currentMapId);
        if (!map) return;
        editLocal(obstacleId, (o) => ({ ...o, ...shiftObstacle(map, o, dCol, dRow) }));
        socket
          .timeout(5000)
          .emitWithAck('obstacle.move', { obstacleId, dCol, dRow })
          .then((res) => (res.ok ? confirm(res.version, upsert(res.obstacle)) : void resync()))
          .catch(() => resync());
      },

      setSight(obstacleId, blocksSight) {
        if (!socket.connected) return;
        editLocal(obstacleId, (o) => ({ ...o, blocksSight }));
        socket
          .timeout(5000)
          .emitWithAck('obstacle.setSight', { obstacleId, blocksSight })
          .then((res) => (res.ok ? confirm(res.version, (list) => list) : resync()))
          .catch(() => resync());
      },

      async clear() {
        if (!socket.connected) return { ok: false, error: 'offline' };
        const world = worldRef.current;
        if (!world?.currentMapId) return { ok: false, error: 'map_not_found' };
        try {
          const res = await socket
            .timeout(5000)
            .emitWithAck('obstacle.clear', { mapId: world.currentMapId });
          if (res.ok) confirm(res.version, () => []);
          return res;
        } catch {
          return { ok: false, error: 'internal' };
        }
      },
    };
  }, [applyWorld, resync]);

  const fogActions = useMemo<FogActions>(() => {
    let pending: { enabled?: boolean; radius?: number } = {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      timer = null;
      const world = worldRef.current;
      const change = pending;
      pending = {};
      if (!world?.currentMapId || !socket.connected) return;
      socket
        .timeout(5000)
        .emitWithAck('fog.update', { mapId: world.currentMapId, ...change })
        .then((res) => {
          if (!res.ok) void resync();
        })
        .catch(() => void resync());
    };
    return {
      update(change) {
        const world = worldRef.current;
        if (!world?.currentMapId || !socket.connected) return;
        // The polygons stay as they were until the server sends the new ones.
        applyWorld({ ...world, fog: { ...world.fog, ...change } });
        pending = { ...pending, ...change };
        // A switch is sent at once; only the slider, which fires continuously, is throttled.
        if (change.enabled !== undefined) {
          if (timer) clearTimeout(timer);
          send();
        } else timer ??= setTimeout(send, FOG_SEND_INTERVAL_MS);
      },
    };
  }, [applyWorld, resync]);

  const characterActions = useMemo<CharacterActions>(
    () => ({
      async setIcon(iconId) {
        if (!socket.connected) return { ok: false, error: 'offline' };
        try {
          return await socket.timeout(5000).emitWithAck('character.setIcon', { icon: iconId });
        } catch {
          return { ok: false, error: 'internal' };
        }
      },
      async uploadIcon(file) {
        if (!socket.connected) throw new Error('Нет связи с сервером.');
        const req = request.current;
        const key = req && 'key' in req ? req.key : undefined;
        if (!req || !key) throw new Error('Нет подключения к сессии.');
        await uploadIcon(req.inviteCode, key, file);
      },
    }),
    [],
  );

  const { lines, draw: drawLine } = useLines(
    lineSeed,
    state.status === 'joined' ? state.self : null,
  );

  return {
    state,
    lines,
    drawLine,
    outdated,
    joinAsPlayer,
    mapActions,
    tokenActions,
    characterActions,
    remoteDrags,
    characterNotice,
    obstacleActions,
    fogActions,
    actionNotice,
  };
}
