import type { InferInsertModel, InferSelectModel, SQL, Table } from 'drizzle-orm'
import type { z } from 'zod'
import type { FilterSpec, FilterShape } from './filter'

export const CRUD_OPS = ['list', 'byId', 'create', 'update', 'delete'] as const
export type CrudOp = (typeof CRUD_OPS)[number]

/**
 * Explicit marker for public (unauthenticated) operations — AD-5.
 * There is deliberately no string shorthand; you must import this symbol.
 */
export const PUBLIC = Symbol.for('crud.public')
export type Public = typeof PUBLIC

/**
 * Internal channel for authorization SQL fragments (AD-6 + AD-5 combined).
 * When an `authorize` rule returns a SQL fragment instead of a boolean, the
 * server layer attaches it to the request context under this key and the
 * repository ANDs it into `scopedWhere`, so custom handlers inherit it too.
 */
export const AUTH_FILTER = Symbol.for('crud.authFilter')

export type SelectRow<T extends Table> = InferSelectModel<T>
export type InsertRow<T extends Table> = InferInsertModel<T>
export type ColName<T extends Table> = Extract<keyof SelectRow<T>, string>

/** Minimal authenticated-request context shape shared across layers. */
export interface RequestContext {
  userId: string | null
  orgId: string | null
  role: 'admin' | 'member' | null
  [AUTH_FILTER]?: SQL
}

export type AuthorizeResult = boolean | SQL
export type AuthorizeFn<Ctx = RequestContext> = (
  ctx: Ctx,
  id?: unknown,
) => AuthorizeResult | Promise<AuthorizeResult>
export type AuthorizeRule<Ctx = RequestContext> = Public | AuthorizeFn<Ctx>

export interface FieldPolicy<T extends Table> {
  omit?: readonly ColName<T>[]
  /** Per-column schema refinements, e.g. `{ email: (s) => s.email() }`. */
  refine?: { [K in ColName<T>]?: (schema: any) => z.ZodType }
}

export interface UpdatePolicy<T extends Table> extends FieldPolicy<T> {
  /** Update schemas are partial by default; opt out with `partial: false`. */
  partial?: boolean
}

export interface SortSpec<F extends string = string> {
  field: F
  dir: 'asc' | 'desc'
}

export interface EntityConfig<T extends Table> {
  table: T
  /** Used in contract keys and error messages. */
  name: string
  /** URL segment: `/users`, `/users/{id}`. */
  path: string
  /** Single-column primary key. Composite keys are unsupported in v1. */
  pk: ColName<T>

  read?: FieldPolicy<T>
  create?: FieldPolicy<T>
  update?: UpdatePolicy<T>

  /** Explicit allowlists — AD-3. */
  filter: FilterSpec<T>
  sort: readonly ColName<T>[]
  defaultSort: SortSpec<ColName<T>>
  maxLimit?: number
  defaultLimit?: number

  /** Keyset is the default — AD-4. */
  pagination?: 'keyset' | 'offset'

  /** Required, one entry per operation, no default — AD-5. */
  authorize: {
    list: AuthorizeRule<any>
    byId: AuthorizeRule<any>
    create: AuthorizeRule<any>
    update: AuthorizeRule<any>
    delete: AuthorizeRule<any>
  } & Record<string, AuthorizeRule<any>>
}

// Deliberately loose (`any` table): the runtime code paths handle arbitrary
// tables; the strict typing lives on defineEntity's signature.
export type AnyEntityConfig = EntityConfig<any>

// ---------------------------------------------------------------------------
// Shape derivation from a config type
// ---------------------------------------------------------------------------

type OmitKeys<P> = P extends { omit: readonly (infer K extends string)[] } ? K : never

export type ReadShape<T extends Table, C extends EntityConfig<T>> = Omit<
  SelectRow<T>,
  OmitKeys<C['read']>
>
export type CreateShape<T extends Table, C extends EntityConfig<T>> = Omit<
  InsertRow<T>,
  OmitKeys<C['create']>
>
export type UpdateShape<T extends Table, C extends EntityConfig<T>> = C['update'] extends {
  partial: false
}
  ? Omit<InsertRow<T>, OmitKeys<C['update']>>
  : Partial<Omit<InsertRow<T>, OmitKeys<C['update']>>>

export type SortParam<S extends string> = S | `-${S}`

export type PageParams<C> = C extends { pagination: 'offset' }
  ? { offset?: number }
  : { cursor?: string }

export type ListQueryShape<T extends Table, C extends EntityConfig<T>> = FilterShape<
  T,
  C['filter']
> & {
  sort?: SortParam<C['sort'][number]>
  limit?: number
} & PageParams<C>

export interface ListResultShape<T extends Table, C extends EntityConfig<T>> {
  items: ReadShape<T, C>[]
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// The entity value produced by defineEntity
// ---------------------------------------------------------------------------

/**
 * Schemas carry their *parsed* (output) shape. The wire-side input shape used
 * to be tracked separately because oRPC needed both; with Fastify parsing
 * directly, only the parsed shape matters to callers.
 */
export interface EntitySchemas<T extends Table, C extends EntityConfig<T>> {
  read: z.ZodType<ReadShape<T, C>>
  create: z.ZodType<CreateShape<T, C>>
  update: z.ZodType<UpdateShape<T, C>>
  filter: z.ZodType<FilterShape<T, C['filter']>>
  listQuery: z.ZodType<
    ListQueryShape<T, C> & { sort: SortParam<C['sort'][number]>; limit: number }
  >
  listResult: z.ZodType<ListResultShape<T, C>>
  /** Schema for the primary key value (path parameter). */
  pk: z.ZodType<SelectRow<T>[C['pk']]>
}

export interface EntityMeta<T extends Table, C extends EntityConfig<T>> {
  name: C['name']
  path: C['path']
  pk: C['pk']
  filter: C['filter']
  sort: C['sort']
  defaultSort: C['defaultSort']
  maxLimit: number
  defaultLimit: number
  pagination: 'keyset' | 'offset'
  /** Column (property) names selected by the read policy — used for projection. */
  readColumns: readonly ColName<T>[]
}

export interface Entity<T extends Table = Table, C extends EntityConfig<T> = EntityConfig<T>> {
  table: T
  name: C['name']
  path: C['path']
  pk: C['pk']
  authorize: C['authorize']
  schemas: EntitySchemas<T, C>
  meta: EntityMeta<T, C>
}

export type AnyEntity = Entity<any, any>

export type Read<E> = E extends Entity<infer T, infer C> ? ReadShape<T, C> : never
export type Create<E> = E extends Entity<infer T, infer C> ? CreateShape<T, C> : never
export type Update<E> = E extends Entity<infer T, infer C> ? UpdateShape<T, C> : never
export type ListQuery<E> = E extends Entity<infer T, infer C> ? ListQueryShape<T, C> : never
export type ListResult<E> = E extends Entity<infer T, infer C> ? ListResultShape<T, C> : never
export type PkType<E> = E extends Entity<infer T, infer C>
  ? SelectRow<T>[C['pk'] & keyof SelectRow<T>]
  : never
