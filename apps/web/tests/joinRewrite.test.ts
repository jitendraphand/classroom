import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';

for (const query of ['FirstName=GROK-TEST-Student&SID=GROK-TEST-1&Grade=7&Division=A', 't=GROK-TEST-token']) {
  test(`HTTPS school join rewrites to the local HTTP listener: ${query.startsWith('t=') ? 'signed' : 'unsigned'}`, () => {
    const req = new NextRequest(`https://classroom.example/join?${query}`);
    const response = middleware(req);
    const target = new URL(response.headers.get('x-middleware-rewrite')!);
    assert.equal(target.protocol, 'http:');
    assert.equal(target.hostname, '127.0.0.1');
    assert.equal(target.port, process.env.PORT || '3000');
    assert.equal(target.pathname, '/api/student/join');
    assert.equal(target.searchParams.toString(), req.nextUrl.searchParams.toString());
  });
}
