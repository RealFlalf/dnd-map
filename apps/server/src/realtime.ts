import { PROTOCOL_VERSION } from '@dnd-map/shared';
import type { ClientToServerEvents, ServerToClientEvents } from '@dnd-map/shared';
import type { Server } from 'socket.io';

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;

export function registerRealtime(io: IoServer): void {
  io.on('connection', (socket) => {
    socket.emit('system.hello', { protocolVersion: PROTOCOL_VERSION });

    socket.on('system.ping', (ack) => {
      // Clients are untrusted: a missing ack must not crash the handler.
      if (typeof ack === 'function') ack({ serverTime: Date.now() });
    });
  });
}
