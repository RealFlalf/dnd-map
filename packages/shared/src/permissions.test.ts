import { describe, expect, it } from 'vitest';
import { can, type Action, type Actor, type TokenSubject } from './permissions';

const master: Actor = { participantId: 'm', role: 'master' };
const player: Actor = { participantId: 'p1', role: 'player' };

const monster: TokenSubject = { type: 'monster', ownerParticipantId: null };
const ownCharacter: TokenSubject = { type: 'player_character', ownerParticipantId: 'p1' };
const otherCharacter: TokenSubject = { type: 'player_character', ownerParticipantId: 'p2' };

// One row per line of the access matrix (requirements, section 9).
const matrix: Array<[string, Action, TokenSubject | undefined, boolean, boolean]> = [
  // description,                         action,                token,          master, player
  ['upload / change the map', 'map.set', undefined, true, false],
  ['configure the grid', 'grid.update', undefined, true, false],
  ['place a monster', 'token.create', monster, true, false],
  ['move a monster', 'token.move', monster, true, false],
  ['delete a monster', 'token.delete', monster, true, false],
  ['hide / show a monster', 'token.setVisibility', monster, true, false],
  // The master runs the table, so every character is also theirs to place, move and remove.
  ["place a player's own character", 'token.create', ownCharacter, true, true],
  ["move a player's own character", 'token.move', ownCharacter, true, true],
  ["delete a player's own character", 'token.delete', ownCharacter, true, true],
  ["move someone else's character", 'token.move', otherCharacter, true, false],
  ['place a character for someone else', 'token.create', otherCharacter, true, false],
  ["delete someone else's character", 'token.delete', otherCharacter, true, false],
  ['hide a character', 'token.setVisibility', ownCharacter, false, false],
  ['choose a character icon', 'character.setIcon', undefined, false, true],
  ['draw a temporary line', 'line.draw', undefined, true, true],
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

  it('ties a player to their own character by participant id, not by anything the client sends', () => {
    const impostor: Actor = { participantId: 'p3', role: 'player' };
    for (const action of ['token.create', 'token.move', 'token.delete'] as const) {
      expect(can(impostor, action, ownCharacter)).toBe(false);
      expect(can(impostor, action, monster)).toBe(false);
    }
  });

  it('never lets anybody hide or show a character: characters are always visible', () => {
    expect(can(master, 'token.setVisibility', ownCharacter)).toBe(false);
    expect(can(master, 'token.setVisibility', otherCharacter)).toBe(false);
  });
});
