import Fastify, { type FastifyInstance } from 'fastify'
import { createDb, type Db } from '@repo/db'
import { buildRepos, type Repos } from './repos'
import { registerUserRoutes } from './routers/user'
import { registerPostRoutes } from './routers/post'
import { seed, type SeedResult } from './seed'

export interface App {
  fastify: FastifyInstance
  db: Db
  repos: Repos
  seeded: SeedResult
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<App> {
  const db = await createDb()
  const seeded = await seed(db)
  const repos = buildRepos(db)

  const fastify = Fastify({ logger: opts.logger ?? false })

  // Routes are registered explicitly, one entity at a time. Nothing is
  // auto-mounted and the generator never touches the Fastify instance.
  registerUserRoutes(fastify, db, repos)
  registerPostRoutes(fastify, repos)

  return { fastify, db, repos, seeded }
}
