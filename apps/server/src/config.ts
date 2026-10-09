import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  UPLOADS_DIR: z.string().default('uploads'),
  /** Per-connection and per-address request limits; turn off only for tests. */
  RATE_LIMIT: z.enum(['on', 'off']).default('on'),
  /** Built web client (apps/web/dist). When set, the server also serves the web app itself. */
  WEB_DIST_DIR: z.string().optional(),
  /** Sessions nobody has touched for this many days are deleted with their files. */
  SESSION_TTL_DAYS: z.coerce.number().positive().default(30),
  /** How often the cleanup runs; 0 switches it off (tests). */
  CLEANUP_INTERVAL_MINUTES: z.coerce.number().min(0).default(60),
  /** Set to 'true' behind a reverse proxy so limits use the real client address. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  /** How long a temporary line drawn over the map lives. */
  LINE_TTL_SECONDS: z.coerce.number().positive().max(3600).default(30),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
