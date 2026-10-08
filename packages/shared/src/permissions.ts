import type { Role } from './session';

export type TokenType = 'monster' | 'player_character';

export type Action =
  | 'map.set'
  | 'grid.update'
  | 'token.create'
  | 'token.move'
  | 'token.delete'
  | 'token.setVisibility';

export interface Actor {
  participantId: string;
  role: Role;
}

export interface TokenSubject {
  type: TokenType;
  ownerParticipantId: string | null;
}

/**
 * Access matrix from the requirements (section 9). The server is the authority:
 * every incoming action is checked here; the client uses it only to hide controls.
 * Viewing the map is allowed to every joined participant and is not an action.
 */
export function can(actor: Actor, action: Action, token?: TokenSubject): boolean {
  switch (action) {
    case 'map.set':
    case 'grid.update':
      return actor.role === 'master';

    case 'token.setVisibility':
      return actor.role === 'master' && token?.type === 'monster';

    case 'token.create':
    case 'token.move':
    case 'token.delete':
      if (!token) return false;
      if (token.type === 'monster') return actor.role === 'master';
      // A player character belongs to exactly one player; nobody else may touch it, the master included.
      return actor.role === 'player' && token.ownerParticipantId === actor.participantId;
  }
}
