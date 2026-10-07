// Server-only entrypoint: this is the module that pulls in the database driver.
// Client-safe code imports '@repo/db/schema' instead (AD-8).
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'

export type Db = PgliteDatabase
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const DDL = `
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  email text not null,
  role text not null default 'member',
  status text not null default 'invited',
  password_hash text not null default '',
  internal_notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists users_email_unique on users (email);
create index if not exists users_org_created_idx on users (org_id, created_at, id);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  author_id uuid not null references users(id),
  title text not null,
  content text not null default '',
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists posts_org_created_idx on posts (org_id, created_at, id);
`

/**
 * Create a Drizzle instance backed by PGlite (embedded Postgres).
 * `dataDir` omitted → in-memory database, ideal for tests and the demo app.
 */
export async function createDb(dataDir?: string): Promise<Db> {
  const pglite = new PGlite(dataDir)
  await pglite.exec(DDL)
  return drizzle({ client: pglite })
}

export * as tables from './schema/index'
