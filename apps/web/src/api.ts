import type { CreateSessionRequest, CreateSessionResponse } from '@dnd-map/shared';

export async function createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Не удалось создать сессию (${res.status})`);
  return res.json() as Promise<CreateSessionResponse>;
}

/** Returns the canonical invite code, or null if there is no such session. */
export async function findSession(inviteCode: string): Promise<string | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(inviteCode)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Сервер недоступен (${res.status})`);
  const body = (await res.json()) as { inviteCode: string };
  return body.inviteCode;
}
