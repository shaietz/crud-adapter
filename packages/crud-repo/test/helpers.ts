import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createDb, type Db } from '@repo/db'
import { users, posts } from '@repo/db/schema'
import { userEntity } from '@repo/entity/entities/user'
import { postEntity } from '@repo/entity/entities/post'
import type { RequestContext } from '@repo/entity'
import { crudRepository, type CrudRepositoryOptions } from '../src/repository'

export const ORG_A = randomUUID()
export const ORG_B = randomUUID()

export function ctx(orgId: string, role: 'admin' | 'member' = 'admin'): RequestContext {
  return { userId: randomUUID(), orgId, role }
}

export async function makeUserRepo(
  overrides: Partial<CrudRepositoryOptions<typeof userEntity, RequestContext>> = {},
) {
  const db = await createDb()
  const repo = crudRepository(db, userEntity, {
    scope: (c) => eq(users.orgId, c.orgId ?? ''),
    softDelete: { column: 'deletedAt' },
    ...overrides,
  })
  return { db, repo }
}

export async function makePostRepo(db?: Db) {
  const database = db ?? (await createDb())
  const repo = crudRepository(database, postEntity, {
    scope: (c) => (c.orgId ? eq(posts.orgId, c.orgId) : undefined),
  })
  return { db: database, repo }
}

let emailCounter = 0
export function userInput(orgId: string, extra: Partial<typeof users.$inferInsert> = {}) {
  emailCounter += 1
  return {
    orgId,
    name: `User ${emailCounter}`,
    email: `user-${emailCounter}-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash: 'x',
    status: 'active' as const,
    ...extra,
  }
}
