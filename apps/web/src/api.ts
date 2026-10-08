import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  MAX_MAPS_PER_SESSION,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type UploadError,
} from '@dnd-map/shared';

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

const UPLOAD_ERRORS: Record<UploadError, string> = {
  forbidden: 'Загружать карты может только Мастер.',
  session_not_found: 'Сессия не найдена.',
  empty_body: 'Файл пустой.',
  invalid_image: 'Не удалось прочитать изображение — файл повреждён или это не картинка.',
  unsupported_format: 'Поддерживаются только JPG, PNG и WebP.',
  image_too_large: `Изображение слишком большое: сторона не должна превышать ${MAX_IMAGE_SIDE} px.`,
  too_many_maps: `В сессии уже ${MAX_MAPS_PER_SESSION} карт. Удалите ненужные и повторите.`,
};

/** Uploads a map image; the server then announces it to everyone through `state.snapshot`. */
export async function uploadMap(
  inviteCode: string,
  participantKey: string,
  file: File,
): Promise<void> {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(UPLOAD_ERRORS.unsupported_format);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`Файл больше ${MAX_IMAGE_BYTES / 1024 / 1024} МБ.`);
  }

  let res: Response;
  try {
    res = await fetch(`/api/sessions/${encodeURIComponent(inviteCode)}/maps`, {
      method: 'POST',
      headers: { 'Content-Type': file.type, 'X-Participant-Key': participantKey },
      body: file,
    });
  } catch {
    throw new Error('Не удалось отправить файл: нет связи с сервером.');
  }
  if (res.ok) return;

  const body = (await res.json().catch(() => null)) as { error?: UploadError } | null;
  if (res.status === 413 && !body?.error)
    throw new Error(`Файл больше ${MAX_IMAGE_BYTES / 1024 / 1024} МБ.`);
  throw new Error((body?.error && UPLOAD_ERRORS[body.error]) || `Ошибка сервера (${res.status}).`);
}
