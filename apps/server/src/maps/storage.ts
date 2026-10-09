import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

/**
 * `<uuid>.<ext>` for map originals, `<uuid>.preview.webp` for map previews and
 * `<uuid>.icon.webp` for character icons. Anything else is never touched.
 */
export const FILE_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.preview|\.icon)?\.(jpg|png|webp)$/;

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
  /** Every stored file with its last modification time (used by the cleanup job). */
  list(): Promise<Array<{ name: string; modifiedAt: Date }>>;
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

    async list() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const files = await Promise.all(
        names
          .filter((name) => FILE_NAME_PATTERN.test(name))
          .map(async (name) => {
            const info = await stat(path.join(root, name)).catch(() => null);
            return info?.isFile() ? { name, modifiedAt: info.mtime } : null;
          }),
      );
      return files.filter((f) => f !== null);
    },
  };
}
