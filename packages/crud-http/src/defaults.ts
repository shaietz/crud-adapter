// The five default handlers — thin delegation to the repository. The behavior
// lives in @repo/crud-repo (§3.2), so custom handlers inherit it by calling repo.
import type { RequestContext } from '@repo/entity'
import type { TypedErrors } from './errors'

export interface DefaultHandlerArgs<Ctx extends RequestContext = RequestContext> {
  input: any
  context: Ctx
  // Untyped here on purpose: these five delegating one-liners are identical for
  // every entity; the per-entity typing lives on crudRoutes' surface.
  repo: any
  errors: TypedErrors
}

type DefaultHandler = (args: DefaultHandlerArgs) => Promise<unknown>

export const defaultHandlers: Record<string, DefaultHandler> = {
  list: ({ input, context, repo }) => repo.list(input, context),
  byId: ({ input, context, repo }) => repo.byId(input.id, context),
  create: ({ input, context, repo }) => repo.create(input, context),
  update: ({ input, context, repo }) => {
    const { id, ...patch } = input
    return repo.update(id, patch, context)
  },
  delete: async ({ input, context, repo }) => {
    await repo.delete(input.id, context)
  },
}
