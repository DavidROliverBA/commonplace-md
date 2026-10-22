// Give an account a new random password and sign it out everywhere: for a server with no email,
// such as the laptop kit (laptop/README.md, `./commonplace.sh reset-password <email>`).
//
//   DATABASE_URL=postgres://… bun scripts/reset-password.ts you@example.com

import { randomBytes } from "node:crypto";
import { sql } from "../src/db";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("usage: bun scripts/reset-password.ts <email>");
  process.exit(2);
}

const password = randomBytes(12).toString("base64url");
const hash = await Bun.password.hash(password);
const [user] = await sql`update users set password_hash = ${hash} where lower(email) = ${email} returning id`;
if (!user) {
  console.error(`No account with the email ${email}.`);
  process.exit(1);
}
await sql`delete from sessions where user_id = ${user.id}`;
console.log(`New password for ${email}: ${password}\nSign in with it, then change it in Settings → Account.`);
process.exit(0);
