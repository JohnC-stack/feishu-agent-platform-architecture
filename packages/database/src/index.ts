import postgres from 'postgres';

export * from './task-repository.js';
export * from './governance-repository.js';

export type DatabaseClient = ReturnType<typeof postgres>;

export function createDatabaseClient(connectionString = process.env.DATABASE_URL): DatabaseClient {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env for local development.');
  }

  return postgres(connectionString, {
    connect_timeout: 10,
    idle_timeout: 30,
    max: 10,
    prepare: true,
  });
}
