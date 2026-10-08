/**
 * Per-browser identity: one participant key per session, plus the last used name.
 * Storage can be unavailable (private mode, blocked site data), so every access is guarded:
 * without it the user simply joins as a new player next time.
 */
const KEYS = 'dnd-map:participant-keys';
const NAME = 'dnd-map:display-name';

function readKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYS);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeKeys(keys: Record<string, string>): void {
  try {
    localStorage.setItem(KEYS, JSON.stringify(keys));
  } catch {
    // ignore: see module comment
  }
}

export function getParticipantKey(inviteCode: string): string | undefined {
  return readKeys()[inviteCode];
}

export function saveParticipantKey(inviteCode: string, key: string): void {
  writeKeys({ ...readKeys(), [inviteCode]: key });
}

export function forgetParticipantKey(inviteCode: string): void {
  const { [inviteCode]: _removed, ...rest } = readKeys();
  writeKeys(rest);
}

export function getDisplayName(): string {
  try {
    return localStorage.getItem(NAME) ?? '';
  } catch {
    return '';
  }
}

export function saveDisplayName(name: string): void {
  try {
    localStorage.setItem(NAME, name);
  } catch {
    // ignore: see module comment
  }
}
