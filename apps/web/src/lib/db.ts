import { PrismaClient } from '@prisma/client';
import { noteDbQuery, noteDbWrite } from './dbCacheVersion';
import { withPoolParams } from './dbUrl';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'executeRaw', 'executeRawUnsafe']);

function make() {
  const url = withPoolParams(process.env.DATABASE_URL || '');
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    ...(url ? { datasources: { db: { url } } } : {}),
  });
  // Every successful write invalidates the read cache (lib/dbCache).
  client.$use(async (params, next) => {
    noteDbQuery();
    const out = await next(params);
    if (WRITES.has(params.action)) noteDbWrite();
    return out;
  });
  return client;
}

export const prisma = globalForPrisma.prisma ?? make();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
