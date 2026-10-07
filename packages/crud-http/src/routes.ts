// crudRoutes — registers Fastify routes from an entity + repository.
//
// Three orthogonal, independently optional knobs:
//   only      restrict which operations exist at all
//   custom    replace an operation's input schema AND handler
//   override  replace an operation's handler, keeping its generated input
//
// There is deliberately no separate "except" list. Declaring a route in
// `custom` *is* the exception, so it is structurally impossible to remove a
// generated route without supplying its replacement — the safety property the
// contract-brand machinery used to enforce with ~350 lines of type gymnastics.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  CRUD_OPS,
  type AnyEntity,
  type Create,
  type CrudOp,
  type ListQuery,
  type ListResult,
  type PkType,
  type Read,
  type RequestContext,
  type Update,
} from '@repo/entity'
import type { CrudRepository } from '@repo/crud-repo'
import { enforceAuthorize } from './authorize'
import { defaultHandlers } from './defaults'
import { HttpError, makeErrors, toHttpError, type TypedErrors } from './errors'

// ---------------------------------------------------------------------------
// Per-operation input/output types
// ---------------------------------------------------------------------------

export type OpInput<E extends AnyEntity, Op extends CrudOp> = Op extends 'list'
  ? ListQuery<E>
  : Op extends 'byId' | 'delete'
    ? { id: PkType<E> }
    : Op extends 'create'
      ? Create<E>
      : Op extends 'update'
        ? Update<E> & { id: PkType<E> }
        : never

export type OpOutput<E extends AnyEntity, Op extends CrudOp> = Op extends 'list'
  ? ListResult<E>
  : Op extends 'delete'
    ? void
    : Read<E>

export interface HandlerArgs<
  Input,
  E extends AnyEntity,
  Ctx extends RequestContext,
  Ex extends Record<string, number> = Record<never, number>,
> {
  input: Input
  /** Authenticated context, possibly narrowed by an authorize SQL rule. */
  context: Ctx
  /** The entity's repository, fully scoped. */
  repo: CrudRepository<E, Ctx>
  /** Typed error constructors: `throw errors.CONFLICT({ data })`. */
  errors: TypedErrors<Ex>
  /** Escape hatch for headers, cookies, logging. */
  request: FastifyRequest
}

/** Replaces a generated handler; input and output stay the generated shapes. */
export type OverrideHandler<
  E extends AnyEntity,
  Op extends CrudOp,
  Ctx extends RequestContext,
> = (args: HandlerArgs<OpInput<E, Op>, E, Ctx>) => OpOutput<E, Op> | Promise<OpOutput<E, Op>>

/**
 * Replaces a generated route's input schema and handler. Method/path stay.
 * The handler's *arguments* are loose here — they get their real types at the
 * `customRoute()` definition site — but its *return type* is pinned to the
 * operation it replaces, so returning the wrong shape is a compile error.
 */
export interface CustomRoute<E extends AnyEntity, Op extends CrudOp, Ctx extends RequestContext> {
  input: z.ZodType
  errors?: Record<string, number>
  handler: (args: HandlerArgs<any, any, any>) => OpOutput<E, Op> | Promise<OpOutput<E, Op>>
}

/**
 * Build a custom route with everything inferred: `input` from the schema,
 * `repo`/`context` from the entity, and `errors` from the codes declared here.
 *
 * `entity` is passed for type inference only — it is not read at runtime. The
 * handler's return type is then checked against the operation it replaces when
 * you assign the result into `custom`, so a wrong shape is a compile error.
 */
export function customRoute<
  E extends AnyEntity,
  S extends z.ZodType,
  Ex extends Record<string, number>,
  Out,
  Ctx extends RequestContext = RequestContext,
>(
  entity: E,
  input: S,
  errors: Ex | undefined,
  handler: (args: HandlerArgs<z.output<S>, E, Ctx, Ex>) => Out | Promise<Out>,
): { input: S; errors?: Record<string, number>; handler: (args: any) => Out | Promise<Out> } {
  return errors === undefined
    ? { input, handler: handler as (args: any) => Out | Promise<Out> }
    : { input, errors, handler: handler as (args: any) => Out | Promise<Out> }
}

export interface CrudRoutesOptions<E extends AnyEntity, Ctx extends RequestContext> {
  /** URL prefix, e.g. '/api'. Default ''. */
  prefix?: string
  /** Builds the authenticated context for each request. */
  context: (req: FastifyRequest) => Ctx | Promise<Ctx>
  /** Restrict which operations are generated at all. Default: all five. */
  only?: readonly CrudOp[]
  custom?: { [K in CrudOp]?: CustomRoute<E, K, Ctx> }
  override?: { [K in CrudOp]?: OverrideHandler<E, K, Ctx> }
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

interface RouteDef {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  onItem: boolean
  status: number
}

const ROUTES: Record<CrudOp, RouteDef> = {
  list: { method: 'GET', onItem: false, status: 200 },
  byId: { method: 'GET', onItem: true, status: 200 },
  create: { method: 'POST', onItem: false, status: 201 },
  // PATCH not PUT: the update schema is partial.
  update: { method: 'PATCH', onItem: true, status: 200 },
  delete: { method: 'DELETE', onItem: true, status: 204 },
}

/** The generated input schema for an operation. */
function generatedSchema(entity: AnyEntity, op: CrudOp): z.ZodType {
  const s = entity.schemas
  switch (op) {
    case 'list':
      return s.listQuery as z.ZodType
    case 'create':
      return s.create as z.ZodType
    case 'update':
      return z.object({
        ...(s.update as unknown as z.ZodObject<Record<string, z.ZodType>>).shape,
        id: s.pk as z.ZodType,
      })
    default:
      return z.object({ id: s.pk as z.ZodType })
  }
}

/** Assemble the raw input for an operation from the request. */
function collectInput(op: CrudOp, req: FastifyRequest): unknown {
  const params = (req.params ?? {}) as { id?: unknown }
  switch (op) {
    case 'list':
      return req.query ?? {}
    case 'create':
      return req.body ?? {}
    case 'update':
      return { ...((req.body ?? {}) as object), id: params.id }
    default:
      return { id: params.id }
  }
}

export function crudRoutes<E extends AnyEntity, Ctx extends RequestContext>(
  app: FastifyInstance,
  entity: E,
  repo: CrudRepository<E, Ctx>,
  options: CrudRoutesOptions<E, Ctx>,
): void {
  const prefix = options.prefix ?? ''
  const basePath = `${prefix}/${entity.meta.path}`
  const itemPath = `${basePath}/:id`
  const ops = (options.only ?? CRUD_OPS).filter((op): op is CrudOp =>
    (CRUD_OPS as readonly string[]).includes(op),
  )

  for (const op of ops) {
    const route = ROUTES[op]
    const custom = options.custom?.[op]
    const override = options.override?.[op]

    // A custom route brings its own schema; otherwise use the generated one.
    const schema = custom ? custom.input : generatedSchema(entity, op)
    const handler = custom
      ? custom.handler
      : (override as ((args: HandlerArgs<unknown, E, Ctx>) => unknown) | undefined) ??
        defaultHandlers[op]!
    const errors = makeErrors(custom?.errors)

    const rule = entity.authorize[op]
    if (rule === undefined) {
      // defineEntity validates this, but a hand-built entity could skip it.
      throw new Error(
        `crudRoutes(${entity.meta.name}): no authorize entry for "${op}" — every operation needs an explicit rule`,
      )
    }

    app.route({
      method: route.method,
      url: route.onItem ? itemPath : basePath,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const parsed = schema.safeParse(collectInput(op, req))
          if (!parsed.success) {
            throw new HttpError('BAD_REQUEST', 400, 'Invalid request', {
              issues: parsed.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            })
          }
          const input = parsed.data
          const baseContext = await options.context(req)
          // Authorization runs in front of every handler — generated, custom,
          // and overridden alike. An override cannot bypass it.
          const context = await enforceAuthorize(rule, baseContext, input, errors)
          const result = await handler({ input, context, repo, errors, request: req })

          if (route.status === 204) return reply.status(204).send()
          return reply.status(route.status).send(result)
        } catch (err) {
          const httpErr = toHttpError(err)
          return reply.status(httpErr.status).send(httpErr.toBody())
        }
      },
    })
  }
}
