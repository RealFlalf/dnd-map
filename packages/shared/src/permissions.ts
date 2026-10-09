import type { Role } from './session';

export type TokenType = 'monster' | 'player_character';

export type Action =
  | 'map.set'
  | 'grid.update'
  | 'token.create'
  | 'token.move'
  | 'token.delete'
  | 'token.setVisibility'
  | 'character.setIcon'
  | 'obstacle.edit'
  | 'fog.update'
  | 'line.draw';

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
    case 'obstacle.edit':
    case 'fog.update':
      return actor.role === 'master';

    case 'line.draw':
      // Anyone at the table may sketch over the map.
      return true;

    case 'character.setIcon':
      return actor.role === 'player';

    case 'token.setVisibility':
      return actor.role === 'master' && token?.type === 'monster';

    case 'token.create':
    case 'token.move':
    case 'token.delete':
      if (!token) return false;
      // The master runs the table: every token is theirs to place, move and remove.
      if (actor.role === 'master') return true;
      // A player controls their own character only; monsters and other players' characters are off limits.
      return token.type === 'player_character' && token.ownerParticipantId === actor.participantId;
  }
}
