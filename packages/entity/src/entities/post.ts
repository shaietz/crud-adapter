import { eq } from 'drizzle-orm'
import { posts } from '@repo/db/schema'
import { defineEntity } from '../define'
import { PUBLIC } from '../types'
import type { RequestContext } from '../types'
import { z } from 'zod'

export const postEntity = defineEntity({
  table: posts,
  name: 'post',
  path: 'posts',
  pk: 'id',

  create: {
    omit: ['id', 'createdAt', 'updatedAt'],
    refine: {
      title: (s: z.ZodString) => s.min(1).max(300),
    },
  },
  update: {
    omit: ['id', 'createdAt', 'updatedAt', 'authorId', 'orgId'],
  },

  filter: {
    eq: ['status', 'authorId'],
    ilike: ['title'],
    range: ['createdAt'],
  },
  sort: ['createdAt'],
  defaultSort: { field: 'createdAt', dir: 'desc' },
  maxLimit: 50,
  defaultLimit: 10,

  authorize: {
    // Anyone may read published posts; scoping still applies via the repo.
    list: PUBLIC,
    byId: PUBLIC,
    create: (ctx: RequestContext) => ctx.userId !== null,
    update: (ctx: RequestContext) => ctx.role === 'admin' || eq(posts.authorId, ctx.userId ?? ''),
    delete: (ctx: RequestContext) => ctx.role === 'admin' || eq(posts.authorId, ctx.userId ?? ''),
  },
} as const)

export type PostEntity = typeof postEntity
