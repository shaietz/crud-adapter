// crudRepository — pure data access, no HTTP knowledge (§3.2). A hand-written
// handler that calls this still gets scoping, pagination, projection, and
// error mapping for free.
import { and, eq, isNull, type Column, type SQL } from 'drizzle-orm'
import type { Db, Tx } from '@repo/db'
import {
  AUTH_FILTER,
  type AnyEntity,
  type Create,
  type ListQuery,
  type ListResult,
  type PkType,
  type Read,
  type RequestContext,
  type Update,
} from '@repo/entity'
import { mapDbError, RepoError } from './errors'
import { cursorForRow, keysetOrderBy, keysetPredicate, parseSortParam } from './keyset'
import { projectionFor, projectRow } from './project'
import { filterToWhere } from './where'

export type DbOrTx = Db | Tx

export interface HookArgs<Ctx> {
  ctx: Ctx
  tx?: Tx | undefined
}

export interface RepositoryHooks<E extends AnyEntity, Ctx> {
  /** May transform the input; runs before the INSERT. */
  beforeCreate?: (args: HookArgs<Ctx> & { input: Create<E> }) => Create<E> | Promise<Create<E>>
  /**
   * Runs after the INSERT — inside the transaction if one was passed, outside
   * otherwise. If you emit events here without a tx, they can fire for writes
   * that later roll back.
   */
  afterCreate?: (args: HookArgs<Ctx> & { result: Read<E>; input: Create<E> }) => void | Promise<void>
  beforeUpdate?: (
    args: HookArgs<Ctx> & { id: PkType<E>; patch: Update<E> },
  ) => Update<E> | Promise<Update<E>>
  afterUpdate?: (args: HookArgs<Ctx> & { result: Read<E> }) => void | Promise<void>
  beforeDelete?: (args: HookArgs<Ctx> & { id: PkType<E> }) => void | Promise<void>
  afterDelete?: (args: HookArgs<Ctx> & { id: PkType<E> }) => void | Promise<void>
}

export interface CrudRepositoryOptions<E extends AnyEntity, Ctx> {
  /** Tenant scope, ANDed into every read AND every write, PK writes included (AD-6). */
  scope?: (ctx: Ctx) => SQL | undefined
  softDelete?: { column: string }
  hooks?: RepositoryHooks<E, Ctx>
}

export interface CrudRepository<E extends AnyEntity, Ctx = RequestContext> {
  entity: E
  db: Db
  list(query: ListQuery<E>, ctx: Ctx, tx?: Tx): Promise<ListResult<E>>
  /** Throws NOT_FOUND. */
  byId(id: PkType<E>, ctx: Ctx, tx?: Tx): Promise<Read<E>>
  /** Does not throw — custom handlers frequently need "does this exist". */
  find(id: PkType<E>, ctx: Ctx, tx?: Tx): Promise<Read<E> | null>
  create(input: Create<E>, ctx: Ctx, tx?: Tx): Promise<Read<E>>
  update(id: PkType<E>, patch: Update<E>, ctx: Ctx, tx?: Tx): Promise<Read<E>>
  delete(id: PkType<E>, ctx: Ctx, tx?: Tx): Promise<void>
  // Escape hatches for custom handlers
  scopedWhere(ctx: Ctx): SQL | undefined
  project<T extends Record<string, unknown>>(row: T): Read<E>
}

export function crudRepository<E extends AnyEntity, Ctx extends RequestContext = RequestContext>(
  db: Db,
  entity: E,
  options: CrudRepositoryOptions<E, Ctx> = {},
): CrudRepository<E, Ctx> {
  const table = entity.table
  const meta = entity.meta
  const projection = projectionFor(table, meta.readColumns)
  const pkCol = projection[meta.pk] ?? (projectionFor(table, [meta.pk])[meta.pk] as Column)
  const softCol = options.softDelete
    ? (projectionFor(table, [options.softDelete.column])[options.softDelete.column] as Column)
    : null
  const hooks = options.hooks ?? {}

  const scopedWhere = (ctx: Ctx): SQL | undefined => {
    const authSql = (ctx as Record<symbol, unknown>)[AUTH_FILTER] as SQL | undefined
    return and(options.scope?.(ctx), authSql)
  }

  /** Scope + soft-delete filter — the WHERE every statement starts from. */
  const baseWhere = (ctx: Ctx): SQL | undefined =>
    and(scopedWhere(ctx), softCol ? isNull(softCol) : undefined)

  // The projection and filters are dynamic by design; the query-builder calls
  // go through an untyped runner while the public method surface stays typed.
  const exec = (tx?: Tx): any => tx ?? db

  const notFound = (id?: unknown): never => {
    throw new RepoError('NOT_FOUND', `${meta.name} not found`, {
      entity: meta.name,
      id: id === undefined ? undefined : String(id),
    })
  }

  const selectOne = async (id: PkType<E>, ctx: Ctx, tx?: Tx): Promise<Read<E> | null> => {
    try {
      const rows: unknown[] = await exec(tx)
        .select(projection)
        .from(table)
        .where(and(eq(pkCol, id), baseWhere(ctx)))
        .limit(1)
      return (rows[0] as Read<E> | undefined) ?? null
    } catch (err) {
      mapDbError(err, meta.name)
    }
  }

  const repo: CrudRepository<E, Ctx> = {
    entity,
    db,

    async list(query, ctx, tx) {
      const q = query as Record<string, unknown>
      const limit = Math.min(Number(q.limit ?? meta.defaultLimit), meta.maxLimit)
      const sort = parseSortParam(String(q.sort ?? formatDefaultSort()))
      if (!(meta.sort as readonly string[]).includes(sort.field)) {
        throw new RepoError('BAD_REQUEST', `Unknown sort field "${sort.field}"`)
      }
      const filterWhere = filterToWhere(table, meta.filter, q)
      const orderBy = keysetOrderBy(table, sort, meta.pk)

      try {
        if (meta.pagination === 'offset') {
          const offset = Number(q.offset ?? 0)
          const rows: unknown[] = await exec(tx)
            .select(projection)
            .from(table)
            .where(and(baseWhere(ctx), filterWhere))
            .orderBy(...orderBy)
            .limit(limit + 1)
            .offset(offset)
          const more = rows.length > limit
          const items = (more ? rows.slice(0, limit) : rows) as Read<E>[]
          // Offset mode reuses the cursor envelope: nextCursor is the next offset.
          return { items, nextCursor: more ? String(offset + limit) : null } as unknown as ListResult<E>
        }

        const cursorWhere =
          typeof q.cursor === 'string' && q.cursor.length > 0
            ? keysetPredicate(table, sort, meta.pk, q.cursor)
            : undefined
        // Fetch limit + 1: the extra row tells us whether a next page exists.
        const rows: unknown[] = await exec(tx)
          .select(projection)
          .from(table)
          .where(and(baseWhere(ctx), filterWhere, cursorWhere))
          .orderBy(...orderBy)
          .limit(limit + 1)
        const more = rows.length > limit
        const items = (more ? rows.slice(0, limit) : rows) as Read<E>[]
        const last = items[items.length - 1] as Record<string, unknown> | undefined
        // Never emit a cursor when there is no next page (§3.2).
        const nextCursor = more && last ? cursorForRow(last, sort, meta.pk) : null
        return { items, nextCursor } as unknown as ListResult<E>
      } catch (err) {
        mapDbError(err, meta.name)
      }
    },

    async byId(id, ctx, tx) {
      const row = await selectOne(id, ctx, tx)
      return row ?? notFound(id)
    },

    async find(id, ctx, tx) {
      return selectOne(id, ctx, tx)
    },

    async create(input, ctx, tx) {
      const finalInput = hooks.beforeCreate
        ? await hooks.beforeCreate({ input, ctx, tx })
        : input
      try {
        const rows: unknown[] = await exec(tx)
          .insert(table)
          .values(finalInput)
          .returning(projection)
        const result = rows[0] as Read<E>
        await hooks.afterCreate?.({ result, input: finalInput, ctx, tx })
        return result
      } catch (err) {
        mapDbError(err, meta.name)
      }
    },

    async update(id, patch, ctx, tx) {
      const finalPatch = hooks.beforeUpdate
        ? await hooks.beforeUpdate({ id, patch, ctx, tx })
        : patch
      if (Object.keys(finalPatch as object).length === 0) {
        // A zero-field UPDATE is invalid SQL; resolve to the current row.
        return repo.byId(id, ctx, tx)
      }
      try {
        const rows: unknown[] = await exec(tx)
          .update(table)
          .set(finalPatch)
          .where(and(eq(pkCol, id), baseWhere(ctx)))
          .returning(projection)
        // Zero rows is NOT_FOUND, never a silent no-op — and never a
        // cross-tenant leak (§3.2).
        const result = (rows[0] as Read<E> | undefined) ?? notFound(id)
        await hooks.afterUpdate?.({ result, ctx, tx })
        return result
      } catch (err) {
        mapDbError(err, meta.name)
      }
    },

    async delete(id, ctx, tx) {
      await hooks.beforeDelete?.({ id, ctx, tx })
      try {
        let rows: unknown[]
        if (softCol) {
          rows = await exec(tx)
            .update(table)
            .set({ [options.softDelete!.column]: new Date() })
            .where(and(eq(pkCol, id), baseWhere(ctx)))
            .returning({ pk: pkCol })
        } else {
          rows = await exec(tx)
            .delete(table)
            .where(and(eq(pkCol, id), baseWhere(ctx)))
            .returning({ pk: pkCol })
        }
        if (rows.length === 0) notFound(id)
        await hooks.afterDelete?.({ id, ctx, tx })
      } catch (err) {
        mapDbError(err, meta.name)
      }
    },

    scopedWhere,

    project(row) {
      return projectRow(row, meta.readColumns) as Read<E>
    },
  }

  function formatDefaultSort(): string {
    return meta.defaultSort.dir === 'desc' ? `-${meta.defaultSort.field}` : meta.defaultSort.field
  }

  return repo
}
