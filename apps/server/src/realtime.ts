import {
  can,
  characterIconSchema,
  characterPlaceSchema,
  defaultCharacterIcon,
  BUILTIN_ICON_PREFIX,
  fogUpdateSchema,
  gridUpdateSchema,
  inAnyPolygon,
  joinRequestSchema,
  obstacleAddSchema,
  obstacleClearSchema,
  obstacleRefSchema,
  obstacleSightSchema,
  mapRefSchema,
  MAX_PARTICIPANTS,
  PROTOCOL_VERSION,
  tokenCreateSchema,
  tokenMoveSchema,
  tokenRefSchema,
  tokenVisibilitySchema,
} from '@dnd-map/shared';
import type {
  ActionResult,
  Actor,
  CharacterIconResult,
  ClientToServerEvents,
  GridUpdateResult,
  JoinRequest,
  FogState,
  JoinResult,
  ObstacleRemoveResult,
  ObstacleResult,
  ParticipantView,
  Role,
  ServerToClientEvents,
  TokenDeleteResult,
  TokenResult,
  TokenSubject,
  TokenView,
} from '@dnd-map/shared';
import type { Participant } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { Server, Socket } from 'socket.io';
import type { CharacterService } from './characters/service';
import type { MapService } from './maps/service';
import type { ObstacleOutcome, ObstacleService } from './obstacles/service';
import type { SessionService } from './sessions/service';
import { createSocketGuard } from './rate-limit';
import { patchFor, type TokenChange } from './tokens/patch';
import type { VisionService } from './vision/service';
import { seenByPlayers } from './vision/view';
import type { TokenOutcome, TokenService } from './tokens/service';

/**
 * Set by a successful `session.join`. A joined socket sits in two rooms: the session id (everyone)
 * and `<session id>:<role>` (masters or players), which lets the server send each role its own view.
 */
export interface SocketData {
  session?: { sessionId: string; inviteCode: string; participantId: string; role: Role };
}

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

interface RealtimeDeps {
  sessions: SessionService;
  maps: MapService;
  tokens: TokenService;
  characters: CharacterService;
  obstacles: ObstacleService;
  vision: VisionService;
  /** Drop events from connections that send too many (see rate-limit.ts). */
  rateLimit: boolean;
  log: FastifyBaseLogger;
}

const roleRoom = (sessionId: string, role: Role) => `${sessionId}:${role}`;

export interface Realtime {
  /** Sends the complete current state of a session to everyone who has joined it. */
  broadcastState(sessionId: string): Promise<void>;
  /** Tells everyone that a character changed its icon (and, if it is on the map, how it looks now). */
  announceCharacter(sessionId: string, change: TokenChange | null): Promise<void>;
  /** Resolves once every in-flight event handler has finished (used on shutdown, before closing the DB). */
  drain(): Promise<void>;
}

export function registerRealtime(
  io: IoServer,
  { sessions, maps, tokens, characters, obstacles, vision, rateLimit, log }: RealtimeDeps,
): Realtime {
  const inFlight = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const onlineParticipantIds = async (sessionId: string): Promise<Set<string>> => {
    const sockets = await io.in(sessionId).fetchSockets();
    return new Set(sockets.flatMap((s) => s.data.session?.participantId ?? []));
  };

  const participantViews = async (sessionId: string): Promise<ParticipantView[]> => {
    const [participants, online] = await Promise.all([
      sessions.listParticipants(sessionId),
      onlineParticipantIds(sessionId),
    ]);
    return participants.map((p) => toView(p, online.has(p.id)));
  };

  const broadcastParticipants = async (sessionId: string): Promise<void> => {
    io.to(sessionId).emit('session.participants', await participantViews(sessionId));
  };

  /**
   * Who may drag a token and whether players see it, for relaying live drags (~20 messages a second
   * per dragging client). Reading this from the database every time was the bottleneck under load.
   * Entries are dropped as soon as the token changes or the session's map changes, and expire
   * quickly anyway, so a hidden monster is never relayed to players on stale information.
   */
  const dragCache = new Map<string, { sessionId: string; token: TokenView; expiresAt: number }>();
  const DRAG_CACHE_MS = 2000;
  /**
   * What the party currently sees, for deciding whether a live drag may be shown to players. Kept
   * very briefly and dropped by forgetSession whenever characters, obstacles, the fog or the map
   * change, so a monster is never shown on stale information.
   */
  const fogCache = new Map<string, { fog: FogState; expiresAt: number }>();
  const forgetSession = (sessionId: string) => {
    for (const [id, entry] of dragCache) if (entry.sessionId === sessionId) dragCache.delete(id);
    fogCache.delete(sessionId);
  };
  const currentFog = async (sessionId: string): Promise<FogState> => {
    const cached = fogCache.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) return cached.fog;
    const fog = await vision.fogOf(sessionId);
    fogCache.set(sessionId, { fog, expiresAt: Date.now() + DRAG_CACHE_MS });
    return fog;
  };

  const broadcastState = async (sessionId: string): Promise<void> => {
    forgetSession(sessionId); // the current map (and with it the draggable tokens) may have changed
    const [forMaster, forPlayers] = await Promise.all([
      maps.getState(sessionId, 'master'),
      maps.getState(sessionId, 'player'),
    ]);
    io.to(roleRoom(sessionId, 'master')).emit('state.snapshot', forMaster);
    io.to(roleRoom(sessionId, 'player')).emit('state.snapshot', forPlayers);
  };

  /** Runs an event handler that answers through an ack; failures are logged and reported as 'internal'. */
  const acked = <R>(name: string, ack: unknown, work: () => Promise<R>, onError: R): void => {
    if (typeof ack !== 'function') return; // clients are untrusted: a missing ack must not crash us
    const reply = ack as (result: R) => void;
    track(
      work().then(reply, (err: unknown) => {
        log.error(err, `${name} failed`);
        reply(onError);
      }),
    );
  };

  const actorOf = (joined: NonNullable<SocketData['session']>): Actor => ({
    participantId: joined.participantId,
    role: joined.role,
  });

  const gridUpdate = async (socket: IoSocket, request: unknown): Promise<GridUpdateResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    if (!can(actorOf(joined), 'grid.update')) return { ok: false, error: 'forbidden' };
    const parsed = gridUpdateSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    const result = await maps.updateGrid(joined.sessionId, parsed.data);
    if (!result) return { ok: false, error: 'map_not_found' };

    socket.to(joined.sessionId).emit('grid.changed', {
      version: result.version,
      mapId: parsed.data.mapId,
      grid: result.grid,
    });
    return { ok: true, ...result };
  };

  /** Shared by map.select and map.delete: master only, then `run` reports whether the map existed. */
  const mapAction = async (
    socket: IoSocket,
    request: unknown,
    run: (sessionId: string, mapId: string) => Promise<boolean>,
  ): Promise<ActionResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    if (!can(actorOf(joined), 'map.set')) return { ok: false, error: 'forbidden' };
    const parsed = mapRefSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    if (!(await run(joined.sessionId, parsed.data.mapId)))
      return { ok: false, error: 'map_not_found' };
    await broadcastState(joined.sessionId);
    return { ok: true };
  };

  const tokenSubject = (t: TokenView): TokenSubject => ({
    type: t.type,
    ownerParticipantId: t.ownerParticipantId,
  });

  /**
   * Tells everybody what a token change means to them (the sender is skipped when `from` is a
   * socket). The master hears everything. Players hear what they may see: without fog a monster
   * unless it is hidden; with fog also only what is within sight. When a character appears,
   * moves or goes, the party's sight itself changes, and every player gets a whole new view.
   */
  const emitPatches = async (
    from: IoSocket | IoServer,
    sessionId: string,
    change: TokenChange,
  ): Promise<void> => {
    forgetSession(sessionId);
    dragCache.delete(change.token.id);
    const fog = await currentFog(sessionId);

    if (fog.enabled && change.token.type === 'player_character') {
      // The party's sight changed: everybody gets a new view, the master too (for the lit area).
      await broadcastState(sessionId);
      return;
    }
    from.to(roleRoom(sessionId, 'master')).emit('tokens.changed', patchFor(change, 'master'));
    if (!fog.enabled) {
      from.to(roleRoom(sessionId, 'player')).emit('tokens.changed', patchFor(change, 'player'));
    } else {
      const seen = {
        before: change.previous !== null && seenByPlayers(change.previous, fog),
        now: !change.removed && seenByPlayers(change.token, fog),
      };
      from
        .to(roleRoom(sessionId, 'player'))
        .emit('tokens.changed', patchFor(change, 'player', seen));
    }
  };

  const emitTokenChange = async (socket: IoSocket, sessionId: string, outcome: TokenOutcome) => {
    if (outcome.ok) await emitPatches(socket, sessionId, outcome.change);
  };

  const announceCharacter = async (sessionId: string, change: TokenChange | null) => {
    if (change) await emitPatches(io, sessionId, change);
    await broadcastParticipants(sessionId);
  };

  const placeCharacter = async (socket: IoSocket, request: unknown): Promise<TokenResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    const parsed = characterPlaceSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };
    // A player places their own character; the master must say whose.
    const ownerId = parsed.data.participantId ?? joined.participantId;
    if (joined.role === 'master' && !parsed.data.participantId) {
      return { ok: false, error: 'invalid_request' };
    }
    const target = { type: 'player_character', ownerParticipantId: ownerId } as const;
    if (!can(actorOf(joined), 'token.create', target)) return { ok: false, error: 'forbidden' };

    const outcome = await tokens.placeCharacter(
      joined.sessionId,
      joined.participantId,
      ownerId,
      parsed.data,
      { ignoreObstacles: joined.role === 'master' },
    );
    return tokenResult(socket, joined.sessionId, outcome);
  };

  const setCharacterIcon = async (
    socket: IoSocket,
    request: unknown,
  ): Promise<CharacterIconResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    if (!can(actorOf(joined), 'character.setIcon')) return { ok: false, error: 'forbidden' };
    const parsed = characterIconSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    const result = await characters.setIcon(
      joined.sessionId,
      joined.participantId,
      BUILTIN_ICON_PREFIX + parsed.data.icon,
    );
    await announceCharacter(joined.sessionId, result.change);
    return { ok: true, icon: result.icon };
  };

  const tokenResult = async (
    socket: IoSocket,
    sessionId: string,
    outcome: TokenOutcome,
  ): Promise<TokenResult> => {
    if (!outcome.ok) return outcome;
    await emitTokenChange(socket, sessionId, outcome);
    return { ok: true, version: outcome.change.version, token: outcome.change.token };
  };

  const createToken = async (socket: IoSocket, request: unknown): Promise<TokenResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    // Clients can only create monsters; player characters come with the players' own flow.
    if (!can(actorOf(joined), 'token.create', { type: 'monster', ownerParticipantId: null })) {
      return { ok: false, error: 'forbidden' };
    }
    const parsed = tokenCreateSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    // Only the master gets here (checked above), and the master ignores obstacles.
    const outcome = await tokens.create(joined.sessionId, joined.participantId, parsed.data, {
      ignoreObstacles: true,
    });
    return tokenResult(socket, joined.sessionId, outcome);
  };

  const moveToken = async (socket: IoSocket, request: unknown): Promise<TokenResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    const parsed = tokenMoveSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    const outcome = await tokens.move(
      joined.sessionId,
      joined.participantId,
      parsed.data.tokenId,
      parsed.data,
      (t) => can(actorOf(joined), 'token.move', tokenSubject(t)),
      { ignoreObstacles: joined.role === 'master' },
    );
    return tokenResult(socket, joined.sessionId, outcome);
  };

  const setTokenVisibility = async (socket: IoSocket, request: unknown): Promise<TokenResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    const parsed = tokenVisibilitySchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    const outcome = await tokens.setVisibility(
      joined.sessionId,
      joined.participantId,
      parsed.data.tokenId,
      parsed.data.visible,
      (t) => can(actorOf(joined), 'token.setVisibility', tokenSubject(t)),
    );
    return tokenResult(socket, joined.sessionId, outcome);
  };

  const deleteToken = async (socket: IoSocket, request: unknown): Promise<TokenDeleteResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    const parsed = tokenRefSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    const outcome = await tokens.delete(
      joined.sessionId,
      joined.participantId,
      parsed.data.tokenId,
      (t) => can(actorOf(joined), 'token.delete', tokenSubject(t)),
    );
    if (!outcome.ok) return outcome;
    await emitTokenChange(socket, joined.sessionId, outcome);
    return { ok: true, version: outcome.change.version };
  };

  /** Relays a live drag position. Nothing is stored, and a hidden monster is only shown to masters. */
  const relayDrag = async (socket: IoSocket, request: unknown): Promise<void> => {
    const joined = socket.data.session;
    const parsed = tokenMoveSchema.safeParse(request);
    if (!joined || !parsed.success) return;
    const { tokenId } = parsed.data;
    const now = Date.now();
    let cached = dragCache.get(tokenId);
    if (!cached || cached.expiresAt < now || cached.sessionId !== joined.sessionId) {
      const found = await tokens.find(joined.sessionId, tokenId);
      if (!found) return;
      cached = { sessionId: joined.sessionId, token: found, expiresAt: now + DRAG_CACHE_MS };
      dragCache.set(tokenId, cached);
      if (dragCache.size > 10_000) {
        for (const [id, entry] of dragCache) if (entry.expiresAt < now) dragCache.delete(id);
      }
    }
    const token = cached.token;
    if (!can(actorOf(joined), 'token.move', tokenSubject(token))) return;

    // Players see a drag only if they could see the monster itself: not hidden, and (with fog) in sight.
    let shownToPlayers = token.visible;
    if (shownToPlayers && token.type === 'monster') {
      const fog = await currentFog(joined.sessionId);
      if (fog.enabled && !inAnyPolygon(parsed.data, fog.polygons)) shownToPlayers = false;
    }
    const room = shownToPlayers ? joined.sessionId : roleRoom(joined.sessionId, 'master');
    socket.to(room).emit('token.dragging', parsed.data);
  };

  const updateFog = async (
    socket: IoSocket,
    request: unknown,
  ): Promise<ActionResult<{ version: number }>> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    if (!can(actorOf(joined), 'fog.update')) return { ok: false, error: 'forbidden' };
    const parsed = fogUpdateSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    const result = await maps.updateFog(joined.sessionId, joined.participantId, parsed.data);
    if (!result) return { ok: false, error: 'map_not_found' };
    // Everybody's view changes: players get theirs without what is now out of sight (or all of it back).
    await broadcastState(joined.sessionId);
    return { ok: true, version: result.version };
  };

  /** Runs an obstacle edit for the master and passes the change on to everybody else. */
  const editObstacles = async <R extends object>(
    socket: IoSocket,
    request: unknown,
    schema: { safeParse(value: unknown): { success: true; data: R } | { success: false } },
    run: (sessionId: string, actorId: string, data: R) => Promise<ObstacleOutcome>,
  ): Promise<ObstacleResult | ObstacleRemoveResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    if (!can(actorOf(joined), 'obstacle.edit')) return { ok: false, error: 'forbidden' };
    const parsed = schema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    const outcome = await run(joined.sessionId, joined.participantId, parsed.data);
    if (!outcome.ok) return outcome;
    const { patch, obstacle } = outcome;
    if (patch.upserted.length > 0 || patch.removedIds.length > 0) {
      // Walls change what the party sees: with fog players get a whole new view, without it the patch.
      forgetSession(joined.sessionId);
      const fog = await currentFog(joined.sessionId);
      if (fog.enabled)
        await broadcastState(joined.sessionId); // the area in sight changes for both roles
      else socket.to(joined.sessionId).emit('obstacles.changed', patch);
    }
    return obstacle
      ? { ok: true, version: patch.version, obstacle }
      : { ok: true, version: patch.version };
  };

  const join = async (socket: IoSocket, request: JoinRequest): Promise<JoinResult> => {
    const parsed = joinRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };
    const req = parsed.data;

    const session = await sessions.findByInviteCode(req.inviteCode);
    if (!session) return { ok: false, error: 'session_not_found' };

    const online = await onlineParticipantIds(session.id);
    let participant: Participant;
    let participantKey: string | undefined;

    if ('key' in req) {
      const found = await sessions.findParticipantByKey(session.id, req.key);
      if (!found) return { ok: false, error: 'unknown_participant' };
      // A second tab of someone already online does not take an extra seat.
      if (!online.has(found.id) && online.size >= MAX_PARTICIPANTS) {
        return { ok: false, error: 'session_full' };
      }
      participant = found;
    } else {
      if (online.size >= MAX_PARTICIPANTS) return { ok: false, error: 'session_full' };
      ({ participant, participantKey } = await sessions.addPlayer(session.id, req.displayName));
    }

    // Re-joining from the same socket (e.g. another session in the same tab) leaves the old room.
    const previous = socket.data.session;
    if (previous) {
      await socket.leave(previous.sessionId);
      await socket.leave(roleRoom(previous.sessionId, previous.role));
      if (previous.sessionId !== session.id) await broadcastParticipants(previous.sessionId);
    }

    socket.data.session = {
      sessionId: session.id,
      inviteCode: session.inviteCode,
      participantId: participant.id,
      role: participant.role,
    };
    await socket.join([session.id, roleRoom(session.id, participant.role)]);
    await sessions.touch(session.id, participant.id);

    const participants = await participantViews(session.id);
    socket.to(session.id).emit('session.participants', participants);

    return {
      ok: true,
      inviteCode: session.inviteCode,
      self: toView(participant, true),
      participants,
      state: await maps.getState(session.id, participant.role),
      ...(participantKey && { participantKey }),
    };
  };

  io.on('connection', (socket) => {
    socket.use(
      createSocketGuard({ enabled: rateLimit, disconnect: () => socket.disconnect(true) }),
    );

    socket.emit('system.hello', { protocolVersion: PROTOCOL_VERSION });

    socket.on('system.ping', (ack) => {
      // Clients are untrusted: a missing ack must not crash the handler.
      if (typeof ack === 'function') ack({ serverTime: Date.now() });
    });

    socket.on('session.join', (request, ack) =>
      acked('session.join', ack, () => join(socket, request), {
        ok: false,
        error: 'internal',
      } as const),
    );

    socket.on('state.sync', (ack) => {
      const joined = socket.data.session;
      if (!joined) return typeof ack === 'function' ? ack(null) : undefined;
      acked('state.sync', ack, () => maps.getState(joined.sessionId, joined.role), null);
    });

    socket.on('grid.update', (request, ack) =>
      acked('grid.update', ack, () => gridUpdate(socket, request), {
        ok: false,
        error: 'internal',
      } as const),
    );
    socket.on('map.select', (request, ack) =>
      acked('map.select', ack, () => mapAction(socket, request, maps.selectMap), {
        ok: false,
        error: 'internal',
      } as const),
    );
    socket.on('map.delete', (request, ack) =>
      acked('map.delete', ack, () => mapAction(socket, request, maps.deleteMap), {
        ok: false,
        error: 'internal',
      } as const),
    );

    socket.on('token.create', (request, ack) =>
      acked('token.create', ack, () => createToken(socket, request), {
        ok: false,
        error: 'internal',
      } as const),
    );
    socket.on('token.move', (request, ack) =>
      acked('token.move', ack, () => moveToken(socket, request), {
        ok: false,
        error: 'internal',
      } as const),
    );
    socket.on('token.delete', (request, ack) =>
      acked('token.delete', ack, () => deleteToken(socket, request), {
        ok: false,
        error: 'internal',
      } as const),
    );
    socket.on('token.setVisibility', (request, ack) =>
      acked('token.setVisibility', ack, () => setTokenVisibility(socket, request), {
        ok: false,
        error: 'internal',
      } as const),
    );
    socket.on('fog.update', (request, ack) =>
      acked('fog.update', ack, () => updateFog(socket, request), {
        ok: false,
        error: 'internal',
      } as const),
    );
    socket.on('obstacle.add', (request, ack) =>
      acked(
        'obstacle.add',
        ack,
        () =>
          editObstacles(socket, request, obstacleAddSchema, (sid, actor, data) =>
            obstacles.add(sid, actor, data),
          ),
        { ok: false, error: 'internal' } as const,
      ),
    );
    socket.on('obstacle.remove', (request, ack) =>
      acked(
        'obstacle.remove',
        ack,
        () =>
          editObstacles(socket, request, obstacleRefSchema, (sid, actor, data) =>
            obstacles.remove(sid, actor, data.obstacleId),
          ),
        { ok: false, error: 'internal' } as const,
      ),
    );
    socket.on('obstacle.setSight', (request, ack) =>
      acked(
        'obstacle.setSight',
        ack,
        () =>
          editObstacles(socket, request, obstacleSightSchema, (sid, actor, data) =>
            obstacles.setSight(sid, actor, data.obstacleId, data.blocksSight),
          ),
        { ok: false, error: 'internal' } as const,
      ),
    );
    socket.on('obstacle.clear', (request, ack) =>
      acked(
        'obstacle.clear',
        ack,
        () =>
          editObstacles(socket, request, obstacleClearSchema, (sid, actor, data) =>
            obstacles.clear(sid, actor, data.mapId),
          ),
        { ok: false, error: 'internal' } as const,
      ),
    );
    socket.on('character.setIcon', (request, ack) =>
      acked('character.setIcon', ack, () => setCharacterIcon(socket, request), {
        ok: false,
        error: 'internal',
      } as const),
    );
    socket.on('character.place', (request, ack) =>
      acked('character.place', ack, () => placeCharacter(socket, request), {
        ok: false,
        error: 'internal',
      } as const),
    );
    socket.on('token.drag', (request) =>
      track(relayDrag(socket, request).catch((err) => log.error(err, 'token.drag failed'))),
    );

    // By the time 'disconnect' fires the socket has already left its rooms.
    socket.on('disconnect', () => {
      const joined = socket.data.session;
      if (!joined) return;
      track(
        (async () => {
          await sessions.touch(joined.sessionId, joined.participantId);
          await broadcastParticipants(joined.sessionId);
        })().catch((err: unknown) => log.error(err, 'disconnect handling failed')),
      );
    });
  });

  return {
    broadcastState,
    announceCharacter,
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

function toView(p: Participant, online: boolean): ParticipantView {
  return {
    id: p.id,
    displayName: p.displayName,
    role: p.role,
    online,
    icon: p.iconUrl ?? defaultCharacterIcon(p.id),
  };
}
