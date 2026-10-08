import { PrismaClient } from '@prisma/client';

export interface Db {
  prisma: PrismaClient;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string): Db {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  return {
    prisma,
    async ping() {
      await prisma.$queryRaw`SELECT 1`;
    },
    close: () => prisma.$disconnect(),
  };
}
