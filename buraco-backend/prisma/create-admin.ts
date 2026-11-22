/**
 * Creates an admin-panel account, or resets an existing admin's password, from the server's
 * command line. The password is typed in hidden (never on screen, in the shell history or in a
 * file). Use it for the first admin on a new server; after that, super admins add staff in the
 * panel (Admins page).
 *
 *   npx ts-node prisma/create-admin.ts
 *
 * Asks for: email, name, role (SUPER_ADMIN / MODERATOR / SUPPORT) and the password twice.
 * Reads DATABASE_URL from .env like the server does.
 */
import { PrismaClient, AdminRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import * as readline from 'readline';
import 'dotenv/config';

const MIN_PASSWORD = 12;

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Reads a line without showing what is typed. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(1);          // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); // Backspace
        else value += ch;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
  try {
    const email = (await ask('Admin email: ')).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That is not an email address.');

    const existing = await prisma.adminUser.findUnique({ where: { email } });
    let name = existing?.name ?? '';
    let role: AdminRole = existing?.role ?? AdminRole.SUPER_ADMIN;
    if (existing) {
      console.log(`${email} already exists (${existing.role}${existing.isActive ? '' : ', switched off'}). Its password will be reset and it will be switched on.`);
    } else {
      name = (await ask('Name shown in the panel: ')) || 'Admin';
      const r = (await ask('Role [SUPER_ADMIN / MODERATOR / SUPPORT] (Enter = SUPER_ADMIN): ')).toUpperCase();
      if (r) {
        if (!(r in AdminRole)) throw new Error(`Unknown role: ${r}`);
        role = r as AdminRole;
      }
    }

    const password = await askHidden(`Password (${MIN_PASSWORD}+ characters, hidden): `);
    if (password.length < MIN_PASSWORD) throw new Error(`The password must have at least ${MIN_PASSWORD} characters.`);
    if ((await askHidden('Password again: ')) !== password) throw new Error('The two passwords are different.');

    const passwordHash = await bcrypt.hash(password, 12);
    if (existing) {
      await prisma.adminUser.update({ where: { id: existing.id }, data: { passwordHash, isActive: true } });
      console.log(`Done: password reset for ${email}.`);
    } else {
      await prisma.adminUser.create({ data: { email, name, role, passwordHash } });
      console.log(`Done: ${email} can now log in to the admin panel as ${role}.`);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
