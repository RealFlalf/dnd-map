import type { TokenView } from '@dnd-map/shared';
import { describe, expect, it } from 'vitest';
import { patchFor, type TokenChange } from './patch';

const token = (visible: boolean): TokenView => ({
  id: 't1',
  mapId: 'm1',
  type: 'monster',
  ownerParticipantId: null,
  name: 'Волк 1',
  icon: 'builtin:wolf',
  x: 105,
  y: 105,
  size: 1,
  visible,
});

const change = (over: Partial<TokenChange> & { visible: boolean }): TokenChange => ({
  version: 7,
  token: token(over.visible),
  wasVisible: over.visible,
  removed: false,
  ...over,
});

const empty = { version: 7, upserted: [], removedIds: [] };

describe('patchFor', () => {
  it('shows a visible token to everyone', () => {
    const c = change({ visible: true });
    expect(patchFor(c, 'master')).toEqual({ version: 7, upserted: [c.token], removedIds: [] });
    expect(patchFor(c, 'player')).toEqual({ version: 7, upserted: [c.token], removedIds: [] });
  });

  it('tells players nothing about a hidden token, but keeps their version moving', () => {
    const c = change({ visible: false });
    expect(patchFor(c, 'master').upserted).toEqual([c.token]);
    expect(patchFor(c, 'player')).toEqual(empty);
  });

  it('removes a token from players when it gets hidden, and adds it when it is revealed', () => {
    const hidden = change({ visible: false, wasVisible: true });
    expect(patchFor(hidden, 'player')).toEqual({ version: 7, upserted: [], removedIds: ['t1'] });
    expect(patchFor(hidden, 'master').upserted).toHaveLength(1);

    const revealed = change({ visible: true, wasVisible: false });
    expect(patchFor(revealed, 'player').upserted).toEqual([revealed.token]);
  });

  it('announces a deletion to those who could see the token only', () => {
    const visible = change({ visible: true, removed: true });
    expect(patchFor(visible, 'master')).toEqual({ version: 7, upserted: [], removedIds: ['t1'] });
    expect(patchFor(visible, 'player')).toEqual({ version: 7, upserted: [], removedIds: ['t1'] });

    const hidden = change({ visible: false, wasVisible: false, removed: true });
    expect(patchFor(hidden, 'master').removedIds).toEqual(['t1']);
    expect(patchFor(hidden, 'player')).toEqual(empty);
  });
});
