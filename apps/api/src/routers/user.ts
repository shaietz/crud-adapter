// User routes. `create` is replaced wholesale: a different input shape
// (signup), an extra typed EMAIL_TAKEN error, and a handler that wraps two
// repository calls in one transaction.
//
// Declaring it in `custom` is what removes the generated POST /users — there
// is no separate "except" list to keep in sync, so a route can never lose its
// implementation.
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '@repo/db'
import { RepoError } from '@repo/crud-repo'
import { buildContext, crudRoutes, customRoute } from '@repo/crud-http'
import { signupInput, userEntity } from '@repo/entity/entities/user'
import type { Repos } from '../repos'

// Demo-grade hashing; a real app uses argon2/bcrypt.
const hashPassword = (pw: string) => createHash('sha256').update(pw).digest('hex')

export function registerUserRoutes(app: FastifyInstance, db: Db, repos: Repos): void {
  crudRoutes(app, userEntity, repos.userRepo, {
    prefix: '/api',
    context: buildContext,
    custom: {
      create: customRoute(
        userEntity,
        signupInput,
        { EMAIL_TAKEN: 409 },
        async ({ input, context, repo, errors }) => {
          try {
            return await db.transaction(async (tx) => {
              const user = await repo.create(
                {
                  name: input.name,
                  email: input.email,
                  passwordHash: hashPassword(input.password),
                  orgId: context.orgId ?? '',
                  status: 'active',
                },
                context,
                tx,
              )
              await repos.postRepo.create(
                {
                  title: `Welcome, ${user.name}!`,
                  content: 'This post was created in the same transaction as the user.',
                  orgId: user.orgId,
                  authorId: user.id,
                  status: 'published',
                },
                context,
                tx,
              )
              return user
            })
          } catch (err) {
            // The route declares EMAIL_TAKEN, so clients can branch on it.
            if (err instanceof RepoError && err.code === 'CONFLICT') {
              throw errors.EMAIL_TAKEN({ data: { email: input.email } })
            }
            throw err
          }
        },
      ),
    },
  })
}
