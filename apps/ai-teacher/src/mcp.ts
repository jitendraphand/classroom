#!/usr/bin/env node
/**
 * MCP server over stdio: `npm run mcp` (or point an MCP client at it).
 *
 * stdout carries the protocol, so it is taken before anything else loads:
 * stray writes (LiveKit's logger writes to stdout unless stdout.write was
 * replaced first) go to stderr, and only the transport writes the real stdout.
 */
import { Writable } from 'node:stream';

const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => process.stderr.write(chunk as string, enc as BufferEncoding, cb as () => void)) as typeof process.stdout.write;
const protocolOut = new Writable({
  write(chunk, encoding, cb) {
    realWrite(chunk, encoding, cb);
  },
});

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { fromEnv } = await import('./config');
const { createServer } = await import('./server');

const { base, cfg } = fromEnv();
const { server, session } = createServer(base, cfg);
await server.connect(new StdioServerTransport(process.stdin, protocolOut));
const bye = async () => {
  await session.live?.leave().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
