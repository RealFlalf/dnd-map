import type { Role, TokensPatch, TokenView } from '@dnd-map/shared';

/** What happened to one token, from the point of view of the whole session. */
export interface TokenChange {
  version: number;
  /** The token after the change (for a deletion: as it was). */
  token: TokenView;
  /** The token as it was before the change; null for a newly created one. */
  previous: TokenView | null;
  /** Whether players could see the token before the change (the master's "visible" flag only). */
  wasVisible: boolean;
  removed: boolean;
}

/**
 * The patch a participant of the given role is allowed to receive. Players hear nothing about
 * tokens they cannot see, so a hidden monster never appears in their traffic: they get an empty
 * patch (which only keeps their version counter in step), or a removal if it has just been hidden.
 */
export function patchFor(
  change: TokenChange,
  audience: Role,
  /** With fog: whether players saw the token before and see it now (hidden flag and distance both counted). */
  seen?: { before: boolean; now: boolean },
): TokensPatch {
  const { version, token, wasVisible, removed } = change;
  const seesNow = audience === 'master' ? !removed : seen ? seen.now : !removed && token.visible;
  const sawBefore = audience === 'master' ? true : seen ? seen.before : wasVisible;

  if (seesNow) return { version, upserted: [token], removedIds: [] };
  if (sawBefore) return { version, upserted: [], removedIds: [token.id] };
  return { version, upserted: [], removedIds: [] };
}
