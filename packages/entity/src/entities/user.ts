import { eq } from 'drizzle-orm'
import { users } from '@repo/db/schema'
import { defineEntity } from '../define'
import type { RequestContext } from '../types'
import { z } from 'zod'

export const userEntity = defineEntity({
  table: users,
  name: 'user',
  path: 'users',
  pk: 'id',

  read: { omit: ['passwordHash', 'internalNotes'] },
  create: {
    omit: ['id', 'createdAt', 'updatedAt', 'deletedAt', 'createdBy'],
    refine: {
      email: () => z.email(),
      name: (s: z.ZodString) => s.min(1).max(200),
    },
  },
  update: {
    omit: ['id', 'createdAt', 'updatedAt', 'deletedAt', 'createdBy', 'email', 'passwordHash'],
  },

  filter: {
    eq: ['status', 'orgId', 'role'],
    ilike: ['name', 'email'],
    range: ['createdAt'],
  },
  sort: ['createdAt', 'name'],
  defaultSort: { field: 'createdAt', dir: 'desc' },
  maxLimit: 100,
  defaultLimit: 25,

  authorize: {
    list: (ctx: RequestContext) => ctx.role === 'admin' || eq(users.orgId, ctx.orgId ?? ''),
    byId: (ctx: RequestContext) => eq(users.orgId, ctx.orgId ?? ''),
    create: (ctx: RequestContext) => ctx.role === 'admin',
    update: (ctx: RequestContext, id) => ctx.role === 'admin' || ctx.userId === id,
    delete: (ctx: RequestContext) => ctx.role === 'admin',
  },
} as const)

export type UserEntity = typeof userEntity

/**
 * Signup takes a different shape from the generated `create` (a plaintext
 * password, no orgId). It lives here, beside the entity, because the entity
 * module is the shared contract: the server validates with it and the client
 * imports its type. Client-safe — it is only a Zod schema.
 */
export const signupInput = z.object({
  email: z.email(),
  name: z.string().min(1).max(200),
  password: z.string().min(8),
})
export type SignupInput = z.infer<typeof signupInput>
