import { PrismaClient } from '@prisma/client';

/** Narrow view of the database that the HTTP/realtime layers depend on (easy to fake in tests). */
export interface Db {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string): Db & { prisma: PrismaClient } {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  return {
    prisma,
    async ping() {
      await prisma.$queryRaw`SELECT 1`;
    },
    close: () => prisma.$disconnect(),
  };
}
