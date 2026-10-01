#!/usr/bin/env node
/**
 * School admin bootstrap / recovery. Plain Node (no tsx) so it runs inside the
 * production image:
 *
 *   node scripts/admin.mjs bootstrap
 *       Entrypoint, every boot. Creates the ONE admin from ADMIN_EMAIL if no
 *       admin exists yet; otherwise does nothing (a redeploy never resets it).
 *   node scripts/admin.mjs create [--email you@school.org]
 *       Same as bootstrap, but fails when no email is given / configured.
 *   node scripts/admin.mjs reset-password --yes-reset-admin-password
 *       Lost-password recovery: new generated password, every admin session
 *       ends, password change forced on next login.
 *   node scripts/admin.mjs status
 *       Says whether an admin exists (email only; never a password).
 *
 * Options: --password-file PATH (default $ADMIN_PASSWORD_FILE or
 * /app/secrets/admin-initial-password), --print (print the password once to
 * this console instead of writing the file).
 *
 * The generated password is written to the password file (mode 0600, in a
 * directory that should be root/container-only; docker-compose mounts
 * ./secrets there). Only when that file cannot be written is it printed, once,
 * to this console. It is never logged otherwise and never committed. The admin
 * must change it on first sign-in, so a copy left in old logs stops working.
 */
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TAG = '[classroom:admin]';

function generatePassword(length = 20) {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s.replace(/(.{5})(?=.)/g, '$1-');
}

function parseArgs(argv) {
  const out = { cmd: argv[0] || 'status', flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2);
    if (inline !== undefined) out.flags[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[k] = argv[++i];
    else out.flags[k] = true;
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deliver(password, email, flags, reason) {
  const file = String(flags['password-file'] || process.env.ADMIN_PASSWORD_FILE || '/app/secrets/admin-initial-password');
  if (!flags.print) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, 'w', 0o600);
      fs.writeSync(fd, `# ${reason} for ${email} (${new Date().toISOString()})\n# Sign in at /login; you must change it immediately. Delete this file afterwards.\n${password}\n`);
      fs.closeSync(fd);
      fs.chmodSync(file, 0o600);
      console.log(`${TAG} ${reason}: password written to ${file} (mode 0600). On the host: ./secrets/${path.basename(file)}`);
      return;
    } catch (e) {
      console.warn(`${TAG} could not write ${file} (${e.code || e.message}); printing it ONCE below instead.`);
    }
  }
  const line = '='.repeat(64);
  console.log(`\n${line}\n${TAG} ${reason}\n  email:    ${email}\n  password: ${password}\n  Shown once. You must change it at first sign-in.\n${line}\n`);
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.admin.findMany({ select: { id: true, email: true } });

    if (cmd === 'status') {
      console.log(existing.length ? `${TAG} admin exists: ${existing[0].email}` : `${TAG} no admin yet`);
      return 0;
    }

    if (cmd === 'bootstrap' || cmd === 'create') {
      if (existing.length) {
        console.log(`${TAG} admin already exists (${existing[0].email}); nothing to do. Use reset-password to recover access.`);
        return 0;
      }
      const email = String(flags.email || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      if (!email) {
        const msg = `${TAG} no admin account yet. Set ADMIN_EMAIL in .env and run ./scripts/create-admin.sh (or restart web).`;
        if (cmd === 'bootstrap') {
          console.warn(msg);
          return 0;
        }
        console.error(msg);
        return 2;
      }
      if (!EMAIL_RE.test(email)) {
        console.error(`${TAG} ADMIN_EMAIL is not a valid email address.`);
        return cmd === 'bootstrap' ? 0 : 2;
      }
      const clash = await prisma.teacher.findUnique({ where: { email } });
      if (clash) {
        console.error(`${TAG} ${email} is already a teacher account; choose a different ADMIN_EMAIL.`);
        return cmd === 'bootstrap' ? 0 : 2;
      }
      const password = generatePassword();
      try {
        await prisma.admin.create({
          data: { email, passwordHash: await bcrypt.hash(password, 12), mustChangePassword: true },
        });
      } catch (e) {
        // Two containers booting at once: the other one won.
        if (e && e.code === 'P2002') {
          console.log(`${TAG} admin was created concurrently; nothing to do.`);
          return 0;
        }
        throw e;
      }
      deliver(password, email, flags, 'Initial admin password');
      return 0;
    }

    if (cmd === 'reset-password') {
      if (!flags['yes-reset-admin-password']) {
        console.error(`${TAG} refusing: pass --yes-reset-admin-password to confirm resetting the admin password.`);
        return 2;
      }
      if (!existing.length) {
        console.error(`${TAG} no admin exists yet; run create first.`);
        return 2;
      }
      const password = generatePassword();
      const admin = await prisma.admin.update({
        where: { id: existing[0].id },
        data: {
          passwordHash: await bcrypt.hash(password, 12),
          mustChangePassword: true,
          sessionVersion: { increment: 1 },
        },
      });
      deliver(password, admin.email, flags, 'Reset admin password');
      return 0;
    }

    console.error(`${TAG} unknown command "${cmd}". Use bootstrap | create | reset-password | status.`);
    return 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`${TAG} failed:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
