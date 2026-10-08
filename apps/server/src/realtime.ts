import { joinRequestSchema, MAX_PARTICIPANTS, PROTOCOL_VERSION } from '@dnd-map/shared';
import type {
  ClientToServerEvents,
  JoinRequest,
  JoinResult,
  ParticipantView,
  Role,
  ServerToClientEvents,
} from '@dnd-map/shared';
import type { Participant } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { Server, Socket } from 'socket.io';
import type { SessionService } from './sessions/service';

/** Set by a successful `session.join`; the room name is the session id. */
export interface SocketData {
  session?: { sessionId: string; inviteCode: string; participantId: string; role: Role };
}

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

interface RealtimeDeps {
  sessions: SessionService;
  log: FastifyBaseLogger;
}

export interface Realtime {
  /** Resolves once every in-flight event handler has finished (used on shutdown, before closing the DB). */
  drain(): Promise<void>;
}

export function registerRealtime(io: IoServer, { sessions, log }: RealtimeDeps): Realtime {
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
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

function toView(p: Participant, online: boolean): ParticipantView {
  return { id: p.id, displayName: p.displayName, role: p.role, online };
}
