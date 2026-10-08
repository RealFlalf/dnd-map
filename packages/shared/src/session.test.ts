import { describe, expect, it } from 'vitest';
import { inviteCodeSchema, joinRequestSchema } from './session';

describe('inviteCodeSchema', () => {
  it('normalizes case, spaces and dashes', () => {
    expect(inviteCodeSchema.parse(' k7m2-qx9p ')).toBe('K7M2QX9P');
  });

  it.each(['K7M2QX9', 'K7M2QX9PA', 'K0M2QX9P', 'I7M2QX9P', ''])('rejects %j', (code) => {
    expect(inviteCodeSchema.safeParse(code).success).toBe(false);
  });
});

describe('joinRequestSchema', () => {
  it('drops a requested role: roles are never chosen by the client', () => {
    const parsed = joinRequestSchema.parse({
      inviteCode: 'K7M2QX9P',
      displayName: 'Арагорн',
      role: 'master',
    });
    expect(parsed).toEqual({ inviteCode: 'K7M2QX9P', displayName: 'Арагорн' });
  });

  it('rejects blank names', () => {
    expect(
      joinRequestSchema.safeParse({ inviteCode: 'K7M2QX9P', displayName: '   ' }).success,
    ).toBe(false);
  });
});
