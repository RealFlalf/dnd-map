/**
 * Socket.IO contract shared by the server and the web client.
 * Bump PROTOCOL_VERSION on any breaking change to these events.
 */
export const PROTOCOL_VERSION = 1;

export interface HelloPayload {
  protocolVersion: number;
}

export interface PingResponse {
  serverTime: number;
}

export interface ServerToClientEvents {
  'system.hello': (payload: HelloPayload) => void;
}

export interface ClientToServerEvents {
  'system.ping': (ack: (res: PingResponse) => void) => void;
}
