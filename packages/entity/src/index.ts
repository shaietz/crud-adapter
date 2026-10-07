export { defineEntity } from './define'
export {
  PUBLIC,
  AUTH_FILTER,
  CRUD_OPS,
  type CrudOp,
  type Public,
  type RequestContext,
  type AuthorizeRule,
  type AuthorizeFn,
  type AuthorizeResult,
  type Entity,
  type AnyEntity,
  type EntityConfig,
  type AnyEntityConfig,
  type EntitySchemas,
  type EntityMeta,
  type Read,
  type Create,
  type Update,
  type ListQuery,
  type ListResult,
  type PkType,
  type ReadShape,
  type CreateShape,
  type UpdateShape,
  type ListQueryShape,
  type ListResultShape,
  type SelectRow,
  type InsertRow,
  type ColName,
  type SortParam,
} from './types'
export {
  parseFilterKey,
  buildFilterSchema,
  buildFilterShape,
  columnQuerySchema,
  FILTER_OPERATORS,
  type FilterOperator,
  type FilterSpec,
  type AnyFilterSpec,
  type FilterShape,
} from './filter'
export {
  encodeCursor,
  decodeCursor,
  CursorError,
  type CursorPayload,
} from './pagination'
export { toOmitMask, createSelectSchema, createInsertSchema, createUpdateSchema } from './schemas'

// NOTE: the fetch client is deliberately NOT re-exported here. This barrel
// pulls in defineEntity and drizzle-orm/zod (~440KB); the client is meant to be
// imported from '@repo/entity/client', which has zero runtime imports.
