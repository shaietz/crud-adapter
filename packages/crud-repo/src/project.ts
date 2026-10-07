// Column projection from the read policy (§3.2): omitted columns must not
// leave the database — SELECT only the allowed columns, never strip in JS.
import { getColumns, type Column, type Table } from 'drizzle-orm'

export function projectionFor(
  table: Table,
  readColumns: readonly string[],
): Record<string, Column> {
  const columns = getColumns(table) as Record<string, Column>
  const projection: Record<string, Column> = {}
  for (const name of readColumns) {
    const col = columns[name]
    if (col) projection[name] = col
  }
  return projection
}

/** Apply the read policy to an already-fetched row (escape hatch). */
export function projectRow<T extends Record<string, unknown>>(
  row: T,
  readColumns: readonly string[],
): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const name of readColumns) {
    if (name in row) out[name] = row[name]
  }
  return out as Partial<T>
}
