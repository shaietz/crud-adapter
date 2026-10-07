// Keyset (cursor) pagination predicate + ordering (§3.2).
// Uses a Postgres row-value comparison, which is correct under ties and
// index-friendly on a composite (sortCol, pk) index.
import {
  asc,
  desc,
  getColumns,
  gt,
  lt,
  sql,
  type Column,
  type SQL,
  type Table,
} from 'drizzle-orm'
import { decodeCursor, encodeCursor, type CursorPayload } from '@repo/entity'
import { RepoError } from './errors'

export interface SortState {
  field: string
  dir: 'asc' | 'desc'
}

/** `-createdAt` → { field: 'createdAt', dir: 'desc' } */
export function parseSortParam(sort: string): SortState {
  return sort.startsWith('-') ? { field: sort.slice(1), dir: 'desc' } : { field: sort, dir: 'asc' }
}

function column(table: Table, name: string): Column {
  const col = (getColumns(table) as Record<string, Column>)[name]
  if (!col) throw new RepoError('BAD_REQUEST', `Unknown sort column "${name}"`)
  return col
}

/**
 * ORDER BY for keyset pagination. The tiebreak PK is always appended and the
 * direction is identical for both components — the row-value comparison is
 * wrong otherwise, so this is structural, not configurable.
 */
export function keysetOrderBy(table: Table, sort: SortState, pk: string): SQL[] {
  const dir = sort.dir === 'desc' ? desc : asc
  const sortCol = column(table, sort.field)
  if (sort.field === pk) return [dir(sortCol)]
  return [dir(sortCol), dir(column(table, pk))]
}

export function keysetPredicate(
  table: Table,
  sort: SortState,
  pk: string,
  cursor: string,
): SQL {
  let payload: CursorPayload
  try {
    payload = decodeCursor(cursor)
  } catch {
    throw new RepoError('BAD_REQUEST', 'Malformed pagination cursor')
  }
  const sortCol = column(table, sort.field)
  const pkCol = column(table, pk)
  const sortValue = payload.s[0]
  if (sort.field === pk) {
    return sort.dir === 'desc' ? lt(pkCol, payload.pk) : gt(pkCol, payload.pk)
  }
  const cmp = sort.dir === 'desc' ? sql.raw('<') : sql.raw('>')
  return sql`(${sortCol}, ${pkCol}) ${cmp} (${sortValue}, ${payload.pk})`
}

/** Build the nextCursor for the last kept row of a page. */
export function cursorForRow(row: Record<string, unknown>, sort: SortState, pk: string): string {
  const raw = row[sort.field]
  const s = raw instanceof Date ? raw.toISOString() : raw
  const pkRaw = row[pk]
  return encodeCursor({ v: 1, s: [s], pk: pkRaw instanceof Date ? pkRaw.toISOString() : pkRaw })
}
