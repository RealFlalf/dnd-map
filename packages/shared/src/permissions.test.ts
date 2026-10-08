import { describe, expect, it } from 'vitest';
import { can, type Action, type Actor, type TokenRef } from './permissions';

const master: Actor = { participantId: 'm', role: 'master' };
const player: Actor = { participantId: 'p1', role: 'player' };

const monster: TokenRef = { type: 'monster', ownerParticipantId: null };
const ownCharacter: TokenRef = { type: 'player_character', ownerParticipantId: 'p1' };
const otherCharacter: TokenRef = { type: 'player_character', ownerParticipantId: 'p2' };

// One row per line of the access matrix (requirements, section 9).
const matrix: Array<[string, Action, TokenRef | undefined, boolean, boolean]> = [
  // description,                         action,                token,          master, player
  ['upload / change the map', 'map.set', undefined, true, false],
  ['configure the grid', 'grid.update', undefined, true, false],
  ['place a monster', 'token.create', monster, true, false],
  ['move a monster', 'token.move', monster, true, false],
  ['delete a monster', 'token.delete', monster, true, false],
  ['hide / show a monster', 'token.setVisibility', monster, true, false],
  ['place own character', 'token.create', ownCharacter, false, true],
  ['move own character', 'token.move', ownCharacter, false, true],
  ["move someone else's character", 'token.move', otherCharacter, false, false],
  ['place a character for someone else', 'token.create', otherCharacter, false, false],
  ["delete someone else's character", 'token.delete', otherCharacter, false, false],
  ['hide a character', 'token.setVisibility', ownCharacter, false, false],
];

describe('can()', () => {
  it.each(matrix)('%s', (_description, action, token, masterAllowed, playerAllowed) => {
    expect(can(master, action, token)).toBe(masterAllowed);
    // The player owns ownCharacter; for every other token ownership must not grant access.
    expect(can(player, action, token)).toBe(playerAllowed);
  });

  it('denies token actions when the token is missing', () => {
    for (const action of ['token.create', 'token.move', 'token.delete'] as const) {
      expect(can(master, action)).toBe(false);
      expect(can(player, action)).toBe(false);
    }
  });

  it('does not let a player act on a character with the same owner id but a master role', () => {
    const masterWithSameId: Actor = { participantId: 'p1', role: 'master' };
    expect(can(masterWithSameId, 'token.move', ownCharacter)).toBe(false);
  });
});
