import type { Table } from 'drizzle-orm'
import { buildFilterShape, buildFilterSchema } from './filter'
import { buildListQuerySchema, buildListResultSchema } from './pagination'
import { buildRuntimeSchemas } from './schemas'
import { validateEntityConfig } from './validate'
import type { AnyEntityConfig, Entity, EntityConfig, EntitySchemas } from './types'

const DEFAULT_MAX_LIMIT = 100
const DEFAULT_LIMIT = 25

/**
 * One declaration per entity; everything downstream derives from it (§3.1).
 *
 * The `const C` type parameter preserves the literal types of `filter.eq`,
 * `sort`, and `omit` arrays through to client autocomplete, whether or not the
 * caller writes `as const` — a widened `string[]` cannot occur.
 */
export function defineEntity<T extends Table, const C extends EntityConfig<T>>(
  config: C & { table: T },
): Entity<T, C> {
  const cfg = config as unknown as AnyEntityConfig
  validateEntityConfig(cfg)
  const runtime = buildRuntimeSchemas(cfg)
  const maxLimit = cfg.maxLimit ?? DEFAULT_MAX_LIMIT
  const defaultLimit = cfg.defaultLimit ?? DEFAULT_LIMIT
  const pagination = cfg.pagination ?? 'keyset'

  const filterShape = buildFilterShape(cfg.table, cfg.filter)
  const filter = buildFilterSchema(cfg.table, cfg.filter)
  const listQuery = buildListQuerySchema({
    filterShape,
    sortFields: cfg.sort,
    defaultSort: cfg.defaultSort,
    maxLimit,
    defaultLimit,
    pagination,
  })
  const listResult = buildListResultSchema(runtime.read)

  return {
    table: config.table,
    name: config.name,
    path: config.path,
    pk: config.pk,
    authorize: config.authorize,
    schemas: {
      read: runtime.read,
      create: runtime.create,
      update: runtime.update,
      filter,
      listQuery,
      listResult,
      pk: runtime.pk,
    } as unknown as EntitySchemas<T, C>,
    meta: {
      name: config.name,
      path: config.path,
      pk: config.pk,
      filter: config.filter,
      sort: config.sort,
      defaultSort: config.defaultSort,
      maxLimit,
      defaultLimit,
      pagination,
      readColumns: runtime.readColumns,
    },
  } as unknown as Entity<T, C>
}
