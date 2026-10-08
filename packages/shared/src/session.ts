import { z } from 'zod';
import type { SessionState } from './map';

export type Role = 'master' | 'player';

/** Simultaneously connected participants per session, master included. */
export const MAX_PARTICIPANTS = 10;

/** No 0/O, 1/I/L: codes are read aloud and typed by hand. */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;

/** Accepts user input like " k7m2-qx9p " and returns "K7M2QX9P". */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const inviteCodeSchema = z
  .string()
  .transform(normalizeInviteCode)
  .pipe(z.string().regex(new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`)));

export const displayNameSchema = z.string().trim().min(1).max(32);

export const participantKeySchema = z.string().min(32).max(128);

export const createSessionRequestSchema = z.object({
  displayName: displayNameSchema,
});
export type CreateSessionRequest = z.input<typeof createSessionRequestSchema>;

export interface CreateSessionResponse {
  inviteCode: string;
  /** Secret identifying the master; the client keeps it to reclaim the role. */
  participantKey: string;
}

/** Rejoin with a stored key, or join as a new player with a name. There is no way to ask for a role. */
export const joinRequestSchema = z.union([
  z.object({ inviteCode: inviteCodeSchema, key: participantKeySchema }),
  z.object({ inviteCode: inviteCodeSchema, displayName: displayNameSchema }),
]);
export type JoinRequest = z.input<typeof joinRequestSchema>;

export interface ParticipantView {
  id: string;
  displayName: string;
  role: Role;
  online: boolean;
  /** Character icon: `builtin:<id>` or a file URL. Masters have none worth showing. */
  icon: string;
}

export type JoinError =
  'invalid_request' | 'session_not_found' | 'unknown_participant' | 'session_full' | 'internal';

export type JoinResult =
  | {
      ok: true;
      inviteCode: string;
      self: ParticipantView;
      participants: ParticipantView[];
      state: SessionState;
      /** Present only when a new participant was created; must be stored by the client. */
      participantKey?: string;
    }
  | { ok: false; error: JoinError };
