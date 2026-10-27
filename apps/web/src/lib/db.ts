import { PrismaClient } from '@prisma/client';
import { withPoolParams } from './dbUrl';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function make() {
  const url = withPoolParams(process.env.DATABASE_URL || '');
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    ...(url ? { datasources: { db: { url } } } : {}),
  });
}

export const prisma = globalForPrisma.prisma ?? make();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
