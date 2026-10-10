import { PrismaClient } from '@prisma/client';
import { noteDbQuery, noteDbWrite } from './dbCacheVersion';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'executeRaw', 'executeRawUnsafe']);

function make() {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
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
