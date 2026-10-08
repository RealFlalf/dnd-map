import type { JoinRequest, JoinResult, ParticipantView } from './session';

/**
 * Socket.IO contract shared by the server and the web client.
 * Bump PROTOCOL_VERSION on any breaking change to these events.
 */
export const PROTOCOL_VERSION = 2;

export interface HelloPayload {
  protocolVersion: number;
}

export interface PingResponse {
  serverTime: number;
}

export interface ServerToClientEvents {
  'system.hello': (payload: HelloPayload) => void;
  /** Full participant list of the joined session; sent whenever someone joins or leaves. */
  'session.participants': (participants: ParticipantView[]) => void;
}

export interface ClientToServerEvents {
  'system.ping': (ack: (res: PingResponse) => void) => void;
  /** Must be sent after every (re)connect; until then the socket belongs to no session. */
  'session.join': (request: JoinRequest, ack: (res: JoinResult) => void) => void;
}
