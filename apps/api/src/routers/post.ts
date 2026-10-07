// Post routes: fully generated — zero custom handlers.
import type { FastifyInstance } from 'fastify'
import { buildContext, crudRoutes } from '@repo/crud-http'
import { postEntity } from '@repo/entity/entities/post'
import type { Repos } from '../repos'

export function registerPostRoutes(app: FastifyInstance, repos: Repos): void {
  crudRoutes(app, postEntity, repos.postRepo, {
    prefix: '/api',
    context: buildContext,
  })
}
