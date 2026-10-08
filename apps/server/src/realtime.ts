import {
  can,
  gridUpdateSchema,
  joinRequestSchema,
  mapRefSchema,
  MAX_PARTICIPANTS,
  PROTOCOL_VERSION,
} from '@dnd-map/shared';
import type {
  ActionResult,
  Actor,
  ClientToServerEvents,
  GridUpdateResult,
  JoinRequest,
  JoinResult,
  ParticipantView,
  Role,
  ServerToClientEvents,
} from '@dnd-map/shared';
import type { Participant } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { Server, Socket } from 'socket.io';
import type { MapService } from './maps/service';
import type { SessionService } from './sessions/service';

/** Set by a successful `session.join`; the room name is the session id. */
export interface SocketData {
  session?: { sessionId: string; inviteCode: string; participantId: string; role: Role };
}

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

interface RealtimeDeps {
  sessions: SessionService;
  maps: MapService;
  log: FastifyBaseLogger;
}

export interface Realtime {
  /** Sends the complete current state of a session to everyone who has joined it. */
  broadcastState(sessionId: string): Promise<void>;
  /** Resolves once every in-flight event handler has finished (used on shutdown, before closing the DB). */
  drain(): Promise<void>;
}

export function registerRealtime(io: IoServer, { sessions, maps, log }: RealtimeDeps): Realtime {
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
    io.to(sessionId).emit('state.snapshot', await maps.getState(sessionId));
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
      if (previous.sessionId !== session.id) await broadcastParticipants(previous.sessionId);
    }

    socket.data.session = {
      sessionId: session.id,
      inviteCode: session.inviteCode,
      participantId: participant.id,
      role: participant.role,
    };
    await socket.join(session.id);
    await sessions.touch(session.id, participant.id);

    const participants = await participantViews(session.id);
    socket.to(session.id).emit('session.participants', participants);

    return {
      ok: true,
      inviteCode: session.inviteCode,
      self: toView(participant, true),
      participants,
      state: await maps.getState(session.id),
      ...(participantKey && { participantKey }),
    };
  };

  io.on('connection', (socket) => {
    socket.emit('system.hello', { protocolVersion: PROTOCOL_VERSION });

    socket.on('system.ping', (ack) => {
      // Clients are untrusted: a missing ack must not crash the handler.
      if (typeof ack === 'function') ack({ serverTime: Date.now() });
    });

    socket.on('session.join', (request, ack) => {
      if (typeof ack !== 'function') return;
      track(
        join(socket, request).then(ack, (err: unknown) => {
          log.error(err, 'session.join failed');
          ack({ ok: false, error: 'internal' });
        }),
      );
    });

    socket.on('state.sync', (ack) => {
      if (typeof ack !== 'function') return;
      const joined = socket.data.session;
      if (!joined) return ack(null);
      track(
        maps.getState(joined.sessionId).then(ack, (err: unknown) => {
          log.error(err, 'state.sync failed');
          ack(null);
        }),
      );
    });

    socket.on('grid.update', (request, ack) => {
      if (typeof ack !== 'function') return;
      track(
        gridUpdate(socket, request).then(ack, (err: unknown) => {
          log.error(err, 'grid.update failed');
          ack({ ok: false, error: 'internal' });
        }),
      );
    });

    socket.on('map.select', (request, ack) => {
      if (typeof ack !== 'function') return;
      track(
        mapAction(socket, request, maps.selectMap).then(ack, (err: unknown) => {
          log.error(err, 'map.select failed');
          ack({ ok: false, error: 'internal' });
        }),
      );
    });

    socket.on('map.delete', (request, ack) => {
      if (typeof ack !== 'function') return;
      track(
        mapAction(socket, request, maps.deleteMap).then(ack, (err: unknown) => {
          log.error(err, 'map.delete failed');
          ack({ ok: false, error: 'internal' });
        }),
      );
    });

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
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

function toView(p: Participant, online: boolean): ParticipantView {
  return { id: p.id, displayName: p.displayName, role: p.role, online };
}
