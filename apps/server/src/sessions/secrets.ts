import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from '@dnd-map/shared';
import { createHash, randomBytes, randomInt } from 'node:crypto';

/** 256-bit random secret; only its hash is stored. */
export function generateParticipantKey(): string {
  return randomBytes(32).toString('base64url');
}

/** The key is high-entropy random data, so a fast hash is enough (no password stretching needed). */
export function hashParticipantKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return code;
}
