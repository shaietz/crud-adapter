// Dependency rules enforced as lint errors, not conventions.
// The bundle assertion (scripts/check-client-bundle.mjs) is the second line of
// defense for AD-8.
import tseslint from 'typescript-eslint'

const noRestricted = (paths, patterns = []) => ({
  'no-restricted-imports': ['error', { paths, patterns }],
})

const driverBan = [
  { name: '@electric-sql/pglite', message: 'Client-safe package: no database driver (AD-8).' },
  { name: 'postgres', message: 'Client-safe package: no database driver (AD-8).' },
  { name: 'pg', message: 'Client-safe package: no database driver (AD-8).' },
]

export default tseslint.config(
  { ignores: ['node_modules', '**/node_modules', 'dist', '**/dist'] },
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
  },
  {
    // Table definitions must be importable without the driver (AD-8).
    files: ['packages/db/src/schema/**/*.ts'],
    rules: noRestricted(driverBan, [
      {
        group: ['drizzle-orm/pglite*', 'drizzle-orm/node-postgres*', 'drizzle-orm/postgres-js*'],
        message: 'Schema modules import drizzle-orm/pg-core only (AD-8).',
      },
    ]),
  },
  {
    // @repo/entity is THE client-safe package: it holds the shared types, the
    // Zod schemas, and the fetch client that the frontend imports. Nothing
    // server-side may enter it, or the driver follows into the browser.
    files: ['packages/entity/src/**/*.ts'],
    rules: noRestricted([
      { name: '@repo/db', message: '@repo/entity may import @repo/db/schema only (§2.1).' },
      { name: '@repo/crud-repo', message: '@repo/entity is client-safe (§2.1).' },
      { name: '@repo/crud-http', message: '@repo/entity is client-safe (§2.1).' },
      { name: 'fastify', message: '@repo/entity is client-safe (§2.1).' },
      ...driverBan,
    ]),
  },
  {
    // @repo/crud-repo: no HTTP knowledge — usable from cron jobs and workers.
    files: ['packages/crud-repo/src/**/*.ts'],
    rules: noRestricted([
      { name: 'fastify', message: '@repo/crud-repo has no HTTP knowledge (§2.1).' },
      { name: '@repo/crud-http', message: '@repo/crud-repo has no HTTP knowledge (§2.1).' },
    ]),
  },
)
