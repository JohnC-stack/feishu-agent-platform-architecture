import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import postgres from 'postgres';

export async function migrate(connectionString = process.env.DATABASE_URL): Promise<string[]> {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations.');
  }

  const sql = postgres(connectionString, { max: 1 });
  const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const applied: string[] = [];

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const files = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort((left, right) => left.localeCompare(right));

    const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations`;
    const completed = new Set(rows.map(({ name }) => name));

    for (const file of files) {
      if (completed.has(file)) {
        continue;
      }

      const migration = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      await sql.begin(async (transaction) => {
        await transaction.unsafe(migration);
        await transaction`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      applied.push(file);
    }

    return applied;
  } finally {
    await sql.end();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  migrate()
    .then((applied) => {
      console.log(
        applied.length === 0 ? 'Database is up to date.' : `Applied: ${applied.join(', ')}`,
      );
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
