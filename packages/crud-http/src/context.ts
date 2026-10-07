// Request context type + builder. Authentication for the demo is header-based;
// a real app swaps buildContext for its token verification.
//
// Routes are registered individually on Fastify, so ordinary Fastify hooks and
// decorators work normally — `context` is simply called per request before the
// handler runs. Pick one place for auth and keep it there.
import type { FastifyRequest } from 'fastify'
import type { RequestContext } from '@repo/entity'

export type { RequestContext }

function headerValue(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

export function buildContext(req: FastifyRequest): RequestContext {
  const role = headerValue(req, 'x-role')
  return {
    userId: headerValue(req, 'x-user-id'),
    orgId: headerValue(req, 'x-org-id'),
    role: role === 'admin' || role === 'member' ? role : null,
  }
}
