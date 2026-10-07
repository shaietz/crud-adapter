import { eq } from 'drizzle-orm'
import type { Db } from '@repo/db'
import { posts, users } from '@repo/db/schema'
import { userEntity } from '@repo/entity/entities/user'
import { postEntity } from '@repo/entity/entities/post'
import { crudRepository } from '@repo/crud-repo'
import type { RequestContext } from '@repo/entity'

export function buildRepos(db: Db) {
  const userRepo = crudRepository(db, userEntity, {
    // Tenant scoping lives here, below the handlers (AD-6): custom handlers
    // inherit it for free, and PK updates/deletes cannot cross tenants.
    scope: (ctx: RequestContext) =>
      ctx.role === 'admin' && !ctx.orgId ? undefined : eq(users.orgId, ctx.orgId ?? ''),
    softDelete: { column: 'deletedAt' },
    hooks: {
      // Escape hatch #1: a hook that stamps tenant + audit columns.
      beforeCreate: ({ input, ctx }) => ({
        ...input,
        orgId: ctx.orgId ?? input.orgId,
        createdBy: ctx.userId,
      }),
      beforeUpdate: ({ patch }) => ({ ...patch, updatedAt: new Date() }),
    },
  })

  const postRepo = crudRepository(db, postEntity, {
    // Posts are readable publicly; scope only when a tenant is present.
    scope: (ctx: RequestContext) => (ctx.orgId ? eq(posts.orgId, ctx.orgId) : undefined),
    hooks: {
      beforeCreate: ({ input, ctx }) => ({
        ...input,
        // Tenant is always stamped from the caller; author defaults to the
        // caller but an explicit authorId (e.g. from a custom handler) wins.
        orgId: ctx.orgId ?? input.orgId,
        authorId: input.authorId ?? ctx.userId,
      }),
      beforeUpdate: ({ patch }) => ({ ...patch, updatedAt: new Date() }),
    },
  })

  return { userRepo, postRepo }
}

export type Repos = ReturnType<typeof buildRepos>
