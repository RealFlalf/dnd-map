import {
  can,
  characterIconSchema,
  characterPlaceSchema,
  defaultCharacterIcon,
  BUILTIN_ICON_PREFIX,
  gridUpdateSchema,
  joinRequestSchema,
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
  JoinResult,
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
import type { SessionService } from './sessions/service';
import { patchFor, type TokenChange } from './tokens/patch';
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
  { sessions, maps, tokens, characters, log }: RealtimeDeps,
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

  const broadcastState = async (sessionId: string): Promise<void> => {
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

  /** Sends every role the patch it may see, to everyone in the session except the sender. */
  const emitPatches = (from: IoSocket | IoServer, sessionId: string, change: TokenChange) => {
    for (const role of ['master', 'player'] as const) {
      from.to(roleRoom(sessionId, role)).emit('tokens.changed', patchFor(change, role));
    }
  };

  const emitTokenChange = (socket: IoSocket, sessionId: string, outcome: TokenOutcome) => {
    if (outcome.ok) emitPatches(socket, sessionId, outcome.change);
  };

  const announceCharacter = async (sessionId: string, change: TokenChange | null) => {
    if (change) emitPatches(io, sessionId, change);
    await broadcastParticipants(sessionId);
  };

  const placeCharacter = async (socket: IoSocket, request: unknown): Promise<TokenResult> => {
    const joined = socket.data.session;
    if (!joined) return { ok: false, error: 'not_joined' };
    const mine = { type: 'player_character', ownerParticipantId: joined.participantId } as const;
    if (!can(actorOf(joined), 'token.create', mine)) return { ok: false, error: 'forbidden' };
    const parsed = characterPlaceSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };

    const outcome = await tokens.placeCharacter(
      joined.sessionId,
      joined.participantId,
      parsed.data,
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

  const tokenResult = (socket: IoSocket, sessionId: string, outcome: TokenOutcome): TokenResult => {
    if (!outcome.ok) return outcome;
    emitTokenChange(socket, sessionId, outcome);
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

    const outcome = await tokens.create(joined.sessionId, joined.participantId, parsed.data);
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
    emitTokenChange(socket, joined.sessionId, outcome);
    return { ok: true, version: outcome.change.version };
  };

  /** Relays a live drag position. Nothing is stored, and a hidden monster is only shown to masters. */
  const relayDrag = async (socket: IoSocket, request: unknown): Promise<void> => {
    const joined = socket.data.session;
    const parsed = tokenMoveSchema.safeParse(request);
    if (!joined || !parsed.success) return;
    const token = await tokens.find(joined.sessionId, parsed.data.tokenId);
    if (!token || !can(actorOf(joined), 'token.move', tokenSubject(token))) return;

    const room = token.visible ? joined.sessionId : roleRoom(joined.sessionId, 'master');
    socket.to(room).emit('token.dragging', parsed.data);
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
