// CI assertion for AD-8: a browser-targeted bundle of everything the frontend
// imports must contain no database driver code, and must stay under a hard
// ceiling so growth is caught between releases (§8).
//
// The entry mirrors a real frontend import: the typed client plus the entity
// modules it is built from. Those reach the Drizzle tables transitively, which
// is exactly the path a driver would sneak in through.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// Resolve from the frontend workspace, which is where @repo/entity is a real
// dependency — the same resolution a browser build would use.
const resolveDir = path.join(root, 'apps', 'web')

const result = await build({
  stdin: {
    contents: `
      import { entityClient, safe, isApiError } from '@repo/entity/client'
      import type { userEntity, signupInput } from '@repo/entity/entities/user'
      import type { postEntity } from '@repo/entity/entities/post'
      const users = entityClient<typeof userEntity, { create: typeof signupInput }>('users', { baseUrl: '/api' })
      const posts = entityClient<typeof postEntity>('posts', { baseUrl: '/api' })
      console.log(users, posts, safe, isApiError)
    `,
    resolveDir,
    sourcefile: 'frontend-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  minify: true,
  logLevel: 'silent',
})

const code = result.outputFiles[0].text
const sizeKb = Math.round(code.length / 1024)

const FORBIDDEN = [
  '@electric-sql/pglite',
  'PGlite',
  'drizzle-orm/pglite',
  'node-postgres',
  'postgres-js',
  'fastify',
]
const SIZE_CEILING_KB = 30

let failed = false
for (const marker of FORBIDDEN) {
  if (code.includes(marker)) {
    console.error(`FAIL: client bundle contains forbidden marker "${marker}"`)
    failed = true
  }
}
if (sizeKb > SIZE_CEILING_KB) {
  console.error(`FAIL: client bundle is ${sizeKb}KB, ceiling is ${SIZE_CEILING_KB}KB`)
  failed = true
}

if (failed) process.exit(1)
console.log(`OK: client bundle is ${sizeKb}KB, no driver code (checked ${FORBIDDEN.length} markers)`)
