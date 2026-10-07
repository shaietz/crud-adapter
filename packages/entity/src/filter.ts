// Filter spec → type-level shape + runtime Zod schema. Both live in this file
// on purpose (§4.1): keeping them together plus a type-level test is what
// stops them drifting apart.
import { getColumns, type Column, type Table } from 'drizzle-orm'
import { z } from 'zod'
import type { SelectRow } from './types'

export interface FilterSpec<T extends Table> {
  eq?: readonly (keyof SelectRow<T> & string)[]
  ilike?: readonly (keyof SelectRow<T> & string)[]
  range?: readonly (keyof SelectRow<T> & string)[]
}

export type AnyFilterSpec = FilterSpec<Table>

// The wire-facing shape: flat keys with `__operator` suffixes (§4.1, §5.1).
export type FilterShape<T extends Table, F extends FilterSpec<T>> = {
  [K in NonNullable<F['eq']>[number]]?: SelectRow<T>[K]
} & {
  [K in NonNullable<F['eq']>[number] as `${K}__in`]?: Array<SelectRow<T>[K]>
} & {
  [K in NonNullable<F['eq']>[number] as `${K}__ne`]?: SelectRow<T>[K]
} & {
  [K in NonNullable<F['ilike']>[number] as `${K}__ilike`]?: string
} & {
  [K in NonNullable<F['range']>[number] as `${K}__gte`]?: SelectRow<T>[K]
} & {
  [K in NonNullable<F['range']>[number] as `${K}__lte`]?: SelectRow<T>[K]
}

/** The operators the wire format supports, keyed by the `__suffix`. */
export const FILTER_OPERATORS = ['eq', 'ne', 'in', 'ilike', 'gte', 'lte'] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

/** Split a wire key like `createdAt__gte` into column + operator. */
export function parseFilterKey(key: string): { column: string; op: FilterOperator } {
  const idx = key.lastIndexOf('__')
  if (idx === -1) return { column: key, op: 'eq' }
  const op = key.slice(idx + 2)
  if (!(FILTER_OPERATORS as readonly string[]).includes(op)) {
    // A double underscore in a plain column name — treat the whole key as eq.
    return { column: key, op: 'eq' }
  }
  return { column: key.slice(0, idx), op: op as FilterOperator }
}

/**
 * Querystring-friendly schema for a single column: coerces strings into the
 * column's runtime type and narrows enum columns to their values.
 */
export function columnQuerySchema(col: Column): z.ZodType {
  const enumValues = (col as { enumValues?: string[] }).enumValues
  if (enumValues && enumValues.length > 0) return z.enum(enumValues as [string, ...string[]])
  // Drizzle v1 dataType is "<base> <constraint>", e.g. "object date",
  // "string uuid", "number int32".
  const [base = 'string', constraint] = String(col.dataType).split(' ')
  switch (base) {
    case 'number':
      return z.coerce.number()
    case 'bigint':
      return z.coerce.bigint()
    case 'boolean':
      return z.union([z.boolean(), z.stringbool()])
    case 'object':
      if (constraint === 'date') return z.coerce.date()
      return z.string()
    default:
      return z.string()
  }
}

/**
 * Build the flat runtime filter shape for a spec. Returned as a plain shape
 * (not wrapped in z.object) so the list-query builder can extend it.
 */
export function buildFilterShape(
  table: Table,
  spec: AnyFilterSpec,
): Record<string, z.ZodType> {
  const cols = getColumns(table) as Record<string, Column>
  const shape: Record<string, z.ZodType> = {}
  const colSchema = (name: string): z.ZodType => {
    const col = cols[name]
    if (!col) throw new Error(`filter references unknown column "${name}"`)
    return columnQuerySchema(col)
  }
  for (const f of spec.eq ?? []) {
    const s = colSchema(f)
    shape[f] = s.optional()
    shape[`${f}__ne`] = s.optional()
    shape[`${f}__in`] = z.preprocess(
      (v) => (typeof v === 'string' ? v.split(',') : v),
      z.array(s).min(1),
    ).optional()
  }
  for (const f of spec.ilike ?? []) {
    shape[`${f}__ilike`] = z.string().min(1).optional()
  }
  for (const f of spec.range ?? []) {
    const s = colSchema(f)
    shape[`${f}__gte`] = s.optional()
    shape[`${f}__lte`] = s.optional()
  }
  return shape
}

/** Build a standalone strict filter schema (exposed as `schemas.filter`). */
export function buildFilterSchema(table: Table, spec: AnyFilterSpec): z.ZodType {
  // Strict: a typo'd filter key must 400, not silently return unfiltered rows.
  return z.strictObject(buildFilterShape(table, spec))
}
