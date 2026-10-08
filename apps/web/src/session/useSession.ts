import {
  applyGridUpdate,
  type ActionResult,
  type GridChanged,
  type GridUpdate,
  type JoinError,
  type JoinRequest,
  type ParticipantView,
  type SessionState as WorldState,
} from '@dnd-map/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findSession, uploadMap } from '../api';
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
      /** Maps and grid, kept in step with the server through snapshots and versioned patches. */
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

const GRID_SEND_INTERVAL_MS = 100;

/**
 * Connects to a session and keeps the membership alive across reconnects:
 * every (re)connect re-sends `session.join` with the stored participant key.
 */
export function useSession(rawInviteCode: string) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  // What to send on the next connect; switches to the key once the server has issued one.
  const request = useRef<JoinRequest | null>(null);
  // Latest world, readable from socket handlers without waiting for a render.
  const worldRef = useRef<WorldState | null>(null);
  const gridQueue = useRef<{
    mapId: string;
    pending: GridPatch | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ mapId: '', pending: null, timer: null });

  const applyWorld = useCallback((world: WorldState) => {
    worldRef.current = world;
    setState((s) => (s.status === 'joined' ? { ...s, world } : s));
  }, []);

  /** Asks the server for the full state; used after a missed update or a rejected change. */
  const resync = useCallback(async () => {
    try {
      const world = await socket.timeout(5000).emitWithAck('state.sync');
      if (world && world.version >= (worldRef.current?.version ?? 0)) applyWorld(world);
    } catch {
      // Offline: the next successful join delivers fresh state anyway.
    }
  }, [applyWorld]);

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
      worldRef.current = result.state;
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
  }, []);

  useEffect(() => {
    let cancelled = false;
    const queue = gridQueue.current;
    const onConnect = () => void sendJoin();
    const onDisconnect = () =>
      setState((s) => (s.status === 'joined' ? { ...s, connected: false } : s));
    const onParticipants = (participants: ParticipantView[]) =>
      setState((s) => (s.status === 'joined' ? { ...s, participants } : s));
    const onSnapshot = (world: WorldState) => {
      if (!worldRef.current || world.version >= worldRef.current.version) applyWorld(world);
    };
    const onGridChanged = (change: GridChanged) => {
      const world = worldRef.current;
      if (!world || change.version <= world.version) return;
      if (change.version > world.version + 1) return void resync(); // an update was missed
      applyWorld({
        ...world,
        version: change.version,
        maps: world.maps.map((m) => (m.id === change.mapId ? { ...m, grid: change.grid } : m)),
      });
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('session.participants', onParticipants);
    socket.on('state.snapshot', onSnapshot);
    socket.on('grid.changed', onGridChanged);

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
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('session.participants', onParticipants);
      socket.off('state.snapshot', onSnapshot);
      socket.off('grid.changed', onGridChanged);
      socket.disconnect();
    };
  }, [rawInviteCode, sendJoin, applyWorld, resync]);

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
          if (world && res.version > world.version) applyWorld({ ...world, version: res.version });
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
        const req = request.current;
        const key = req && 'key' in req ? req.key : undefined;
        if (!req || !key) throw new Error('Нет подключения к сессии.');
        await uploadMap(req.inviteCode, key, file);
      },
    };
  }, [applyWorld, resync]);

  return { state, joinAsPlayer, mapActions };
}
