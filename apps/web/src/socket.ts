import type { ClientToServerEvents, ServerToClientEvents } from '@dnd-map/shared';
import { io, type Socket } from 'socket.io-client';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** One connection per tab; served from the same origin (Vite proxies /socket.io in dev). */
export const socket: AppSocket = io({ autoConnect: false });
