// Negative compile tests: the core safety property is "you cannot ship a route
// whose implementation disagrees with its shape", and a property that is not
// tested is not a property. `pnpm test:types` fails if any @ts-expect-error
// below stops erroring, or if a positive case stops compiling.
//
// Note what is NOT tested here: "removing a route without supplying its
// implementation." That failure mode no longer exists — declaring a route in
// `custom` is what replaces the generated one, so the declaration and the
// implementation are the same object and cannot drift apart.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { users } from '@repo/db/schema'
import { defineEntity, PUBLIC, type RequestContext } from '@repo/entity'
import { userEntity, signupInput } from '@repo/entity/entities/user'
import { postEntity } from '@repo/entity/entities/post'
import type { CrudRepository } from '@repo/crud-repo'
import { crudRoutes, customRoute } from '../src/routes'
import { buildContext } from '../src/context'

declare const app: FastifyInstance
declare const userRepo: CrudRepository<typeof userEntity, RequestContext>
declare const postRepo: CrudRepository<typeof postEntity, RequestContext>

// ── Positive: a fully generated entity needs no custom or override ─────────
crudRoutes(app, postEntity, postRepo, { prefix: '/api', context: buildContext })

// ── Positive: only() subsets the generated operations ─────────────────────
crudRoutes(app, postEntity, postRepo, {
  context: buildContext,
  only: ['list', 'byId'],
})

// ── Positive: an override keeps the generated shapes and is typed ─────────
crudRoutes(app, postEntity, postRepo, {
  context: buildContext,
  override: {
    list: async ({ input, context, repo }) => repo.list(input, context),
  },
})

// ── Negative: an override returning the wrong shape ────────────────────────
crudRoutes(app, postEntity, postRepo, {
  context: buildContext,
  override: {
    // @ts-expect-error list must return { items, nextCursor }, not a bare array
    list: async ({ input, context, repo }) => (await repo.list(input, context)).items,
  },
})

// ── Positive: a custom route's input is inferred from its schema ───────────
crudRoutes(app, userEntity, userRepo, {
  context: buildContext,
  custom: {
    create: customRoute(
      userEntity,
      signupInput,
      { EMAIL_TAKEN: 409 },
      async ({ input, context, repo, errors }) => {
        // input is typed from signupInput…
        const email: string = input.email
        // …and errors carries the code this route declared.
        if (!email) throw errors.EMAIL_TAKEN({ data: { email } })
        return repo.create({ ...input, orgId: context.orgId ?? '' } as never, context)
      },
    ),
  },
})

// ── Negative: a custom route returning the wrong shape ─────────────────────
crudRoutes(app, userEntity, userRepo, {
  context: buildContext,
  custom: {
    // @ts-expect-error a user create route cannot return a number
    create: customRoute(userEntity, signupInput, undefined, async () => 42),
  },
})

// ── Negative: a custom route's input does not match its schema ─────────────
crudRoutes(app, userEntity, userRepo, {
  context: buildContext,
  custom: {
    create: customRoute(userEntity, signupInput, undefined, async ({ input, context, repo }) => {
      // @ts-expect-error signupInput has no `nickname` field
      input.nickname
      return repo.create({ ...input, orgId: context.orgId ?? '' } as never, context)
    }),
  },
})

// ── Negative: omitting an authorize entry fails to compile (AD-5) ──────────
// @ts-expect-error authorize is required and must cover every operation
defineEntity({
  table: users,
  name: 'user',
  path: 'users',
  pk: 'id',
  filter: { eq: ['status'] },
  sort: ['createdAt'],
  defaultSort: { field: 'createdAt', dir: 'desc' },
})

defineEntity({
  table: users,
  name: 'user',
  path: 'users',
  pk: 'id',
  filter: { eq: ['status'] },
  sort: ['createdAt'],
  defaultSort: { field: 'createdAt', dir: 'desc' },
  // @ts-expect-error every operation needs an entry — delete is missing
  authorize: { list: PUBLIC, byId: PUBLIC, create: PUBLIC, update: PUBLIC },
})

// ── Negative: allowlists reject unknown columns at the type level ──────────
defineEntity({
  table: users,
  name: 'user',
  path: 'users',
  pk: 'id',
  // @ts-expect-error "nope" is not a column of users
  filter: { eq: ['nope'] },
  sort: ['createdAt'],
  defaultSort: { field: 'createdAt', dir: 'desc' },
  authorize: { list: PUBLIC, byId: PUBLIC, create: PUBLIC, update: PUBLIC, delete: PUBLIC },
})

// Keep z referenced so the import is not flagged as unused.
export type _Unused = z.ZodType
