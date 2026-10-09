import type {
  ActionResult,
  GridChanged,
  GridUpdate,
  GridUpdateResult,
  MapRef,
  SessionState,
} from './map';
import type {
  ObstacleAdd,
  ObstacleClear,
  ObstacleRef,
  ObstacleRemoveResult,
  ObstacleResult,
  ObstacleSight,
  ObstaclesPatch,
} from './obstacle';
import type {
  CharacterIconRequest,
  CharacterIconResult,
  CharacterPlace,
  TokenCreate,
  TokenDeleteResult,
  TokenDragging,
  TokenMove,
  TokenRef,
  TokenResult,
  TokensPatch,
  TokenVisibility,
} from './token';
import type { JoinRequest, JoinResult, ParticipantView } from './session';

/**
 * Socket.IO contract shared by the server and the web client.
 * Bump PROTOCOL_VERSION on any breaking change to these events.
 */
export const PROTOCOL_VERSION = 6;

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
  /** Complete state after structural changes (map added, selected or deleted). */
  'state.snapshot': (state: SessionState) => void;
  /** Small change of the grid of one map. A gap in `version` means a missed update: call `state.sync`. */
  'grid.changed': (change: GridChanged) => void;
  /** Change of the tokens on the current map, already filtered for the receiver's role. */
  'tokens.changed': (patch: TokensPatch) => void;
  /** Change of the obstacles on the current map. */
  'obstacles.changed': (patch: ObstaclesPatch) => void;
  /** Live position of a token someone is dragging right now. Not versioned, never stored. */
  'token.dragging': (drag: TokenDragging) => void;
}

export interface ClientToServerEvents {
  'system.ping': (ack: (res: PingResponse) => void) => void;
  /** Must be sent after every (re)connect; until then the socket belongs to no session. */
  'session.join': (request: JoinRequest, ack: (res: JoinResult) => void) => void;
  /** Returns the current state of the joined session, or null if the socket has not joined one. */
  'state.sync': (ack: (state: SessionState | null) => void) => void;
  /** Master only. Other participants receive `grid.changed`. */
  'grid.update': (request: GridUpdate, ack: (res: GridUpdateResult) => void) => void;
  /** Master only. Makes an already uploaded map the current one. */
  'map.select': (request: MapRef, ack: (res: ActionResult) => void) => void;
  /** Master only. */
  'map.delete': (request: MapRef, ack: (res: ActionResult) => void) => void;
  /** Master only (monsters). Players receive `tokens.changed` unless the monster is placed hidden. */
  'token.create': (request: TokenCreate, ack: (res: TokenResult) => void) => void;
  /** Final position after a drag; the server snaps it to the grid if the map asks for that. */
  'token.move': (request: TokenMove, ack: (res: TokenResult) => void) => void;
  'token.delete': (request: TokenRef, ack: (res: TokenDeleteResult) => void) => void;
  /** Master only. Hiding a monster removes it from every player's state. */
  'token.setVisibility': (request: TokenVisibility, ack: (res: TokenResult) => void) => void;
  /** Player only: picks one of the shipped icons. Uploaded icons go through the icon upload route. */
  'character.setIcon': (
    request: CharacterIconRequest,
    ack: (res: CharacterIconResult) => void,
  ) => void;
  /** Player only: puts the player's own character on the current map (once per map). */
  'character.place': (request: CharacterPlace, ack: (res: TokenResult) => void) => void;
  /** Master only. The server snaps the rectangle to whole grid cells. */
  'obstacle.add': (request: ObstacleAdd, ack: (res: ObstacleResult) => void) => void;
  /** Master only. */
  'obstacle.remove': (request: ObstacleRef, ack: (res: ObstacleRemoveResult) => void) => void;
  /** Master only: whether the obstacle blocks the line of sight. */
  'obstacle.setSight': (request: ObstacleSight, ack: (res: ObstacleResult) => void) => void;
  /** Master only: removes every obstacle of the map. */
  'obstacle.clear': (request: ObstacleClear, ack: (res: ObstacleRemoveResult) => void) => void;
  /** Intermediate position while dragging; fire and forget, send at most ~20 times per second. */
  'token.drag': (request: TokenMove) => void;
}
