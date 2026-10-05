import { pool, withTransaction } from "./pool";
import { hashPassword } from "../auth/password";
import { logger } from "../logger";
import { seedScenarios } from "./scenarioSeed";

/**
 * Development seed data. Creates demo adult users and an active match so the
 * match -> invite -> consent flow can be exercised end to end.
 * NEVER seed real user data. Passwords here are obviously-demo values.
 */

async function seed(): Promise<void> {
  const pw = await hashPassword("Passw0rd!demo");

  await withTransaction(async (client) => {
    // Two demo users, both comfortably over 18.
    const demoUsers = [
      { email: "ava.demo@example.com", name: "Ava", dob: "1996-04-12" },
      { email: "noah.demo@example.com", name: "Noah", dob: "1994-09-30" },
    ];

    const ids: string[] = [];
    for (const u of demoUsers) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, date_of_birth, age_confirmed_at, email_verified_at)
         VALUES ($1, $2, $3, now(), now())
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [u.email, pw, u.dob],
      );
      let id = rows[0]?.id;
      if (!id) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE lower(email) = lower($1)`,
          [u.email],
        );
        id = existing.rows[0].id;
      } else {
        await client.query(
          `INSERT INTO profiles (user_id, display_name, bio, discoverable)
           VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING`,
          [id, u.name, `Hi, I'm ${u.name}. Here for playful, consensual fun.`],
        );
      }
      ids.push(id);
    }

    // Canonical ordering for the match pair.
    const [a, b] = [...ids].sort();
    await client.query(
      `INSERT INTO matches (user_a, user_b, state)
       VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (user_a, user_b) DO UPDATE SET state = 'ACTIVE'`,
      [a, b],
    );
  });

  // Seed the published scenario library (idempotent).
  await seedScenarios();

  logger.info("seed complete");
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, "seed failed");
      process.exitCode = 1;
      return pool.end();
    });
}

export { seed };
