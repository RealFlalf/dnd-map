import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

/** `<uuid>.<ext>` for originals, `<uuid>.preview.webp` for previews. Anything else is never touched. */
export const FILE_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.preview)?\.(jpg|png|webp)$/;

export const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface StoredFile {
  stream: Readable;
  size: number;
  contentType: string;
}

/** Where uploaded images live. The local-disk implementation can be swapped for S3 later. */
export interface FileStorage {
  save(name: string, data: Buffer): Promise<void>;
  /** Missing files are ignored. */
  remove(name: string): Promise<void>;
  open(name: string): Promise<StoredFile | null>;
}

export function createLocalStorage(dir: string): FileStorage {
  const root = path.resolve(dir);

  const resolve = (name: string): string => {
    if (!FILE_NAME_PATTERN.test(name)) throw new Error(`Invalid file name: ${name}`);
    return path.join(root, name);
  };

  return {
    async save(name, data) {
      const file = resolve(name);
      await mkdir(root, { recursive: true });
      await writeFile(file, data);
    },

    async remove(name) {
      await rm(resolve(name), { force: true });
    },

    async open(name) {
      if (!FILE_NAME_PATTERN.test(name)) return null;
      const file = resolve(name);
      try {
        const info = await stat(file);
        if (!info.isFile()) return null;
        const ext = name.slice(name.lastIndexOf('.') + 1);
        return {
          stream: createReadStream(file),
          size: info.size,
          contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}
