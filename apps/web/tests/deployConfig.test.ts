import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const mode of ['public-ip', 'domain-tls', 'sslip-tls']) {
  test(`${mode}: fresh configuration writes LiveKit keys, webhook and RTC address without deploying`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'GROK-TEST-config-'));
    try {
      mkdirSync(join(dir, 'infra'));
      cpSync(resolve('../../scripts'), join(dir, 'scripts'), { recursive: true });
      cpSync(resolve('../../infra/livekit.example.yaml'), join(dir, 'infra/livekit.example.yaml'));
      const key = 'GROK-TEST-api-key';
      const secret = 'GROK-TEST-only-not-a-real-secret-0123456789';
      writeFileSync(join(dir, '.env'), `LIVEKIT_API_KEY=${key}\nLIVEKIT_API_SECRET=${secret}\nNEXTAUTH_SECRET=${secret}\nPOSTGRES_PASSWORD=${secret}\n`);
      mkdirSync(join(dir, 'bin'));
      // No DNS lookup and no container/cloud operation during this local fixture test.
      writeFileSync(join(dir, 'bin/getent'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(dir, 'bin/docker'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      const result = spawnSync('bash', [join(dir, `scripts/configure-${mode}.sh`)], {
        env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, PUBLIC_IP: '203.0.113.10', DOMAIN: 'classroom.example' },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 0, 'configuration should succeed');
      const yaml = readFileSync(join(dir, 'infra/livekit.yaml'), 'utf8');
      assert.ok(yaml.includes(`${key}: ${secret}`), 'LiveKit and web use the same credentials');
      assert.ok(yaml.includes('use_external_ip: true'));
      assert.ok(yaml.includes('node_ip: 203.0.113.10'));
      assert.ok(yaml.includes('http://127.0.0.1:3000/api/livekit/webhook'));
      assert.ok(!yaml.includes('__LIVEKIT_'));
      assert.ok(!result.stdout.includes(secret) && !result.stdout.includes(key), 'credentials must never be printed');
      assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
