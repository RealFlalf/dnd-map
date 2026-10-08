import type { Role, TokensPatch, TokenView } from '@dnd-map/shared';

/** What happened to one token, from the point of view of the whole session. */
export interface TokenChange {
  version: number;
  /** The token after the change (for a deletion: as it was). */
  token: TokenView;
  /** Whether players could see the token before the change; false for a newly created one. */
  wasVisible: boolean;
  removed: boolean;
}

/**
 * The patch a participant of the given role is allowed to receive. Players hear nothing about
 * tokens they cannot see, so a hidden monster never appears in their traffic: they get an empty
 * patch (which only keeps their version counter in step), or a removal if it has just been hidden.
 */
export function patchFor(change: TokenChange, audience: Role): TokensPatch {
  const { version, token, wasVisible, removed } = change;
  const seesNow = audience === 'master' ? !removed : !removed && token.visible;
  const sawBefore = audience === 'master' ? true : wasVisible;

  if (seesNow) return { version, upserted: [token], removedIds: [] };
  if (sawBefore) return { version, upserted: [], removedIds: [token.id] };
  return { version, upserted: [], removedIds: [] };
}
