// Parsed filter object → Drizzle SQL. Unknown keys are rejected (§4.1):
// a client typo that silently returns unfiltered rows is worse than a 400.
import {
  and,
  eq,
  ne,
  gte,
  lte,
  ilike,
  inArray,
  getColumns,
  type Column,
  type SQL,
  type Table,
} from 'drizzle-orm'
import { parseFilterKey, type AnyFilterSpec } from '@repo/entity'
import { RepoError } from './errors'

const RESERVED_KEYS = new Set(['sort', 'limit', 'cursor', 'offset'])

/** Every wire key the spec allows, e.g. status, status__ne, status__in, ... */
export function allowedFilterKeys(spec: AnyFilterSpec): Set<string> {
  const keys = new Set<string>()
  for (const f of spec.eq ?? []) {
    keys.add(f)
    keys.add(`${f}__ne`)
    keys.add(`${f}__in`)
  }
  for (const f of spec.ilike ?? []) keys.add(`${f}__ilike`)
  for (const f of spec.range ?? []) {
    keys.add(`${f}__gte`)
    keys.add(`${f}__lte`)
  }
  return keys
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

export function filterToWhere(
  table: Table,
  spec: AnyFilterSpec,
  query: Record<string, unknown>,
): SQL | undefined {
  const columns = getColumns(table) as Record<string, Column>
  const allowed = allowedFilterKeys(spec)
  const clauses: SQL[] = []

  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_KEYS.has(key) || value === undefined) continue
    if (!allowed.has(key)) {
      throw new RepoError('BAD_REQUEST', `Unknown filter key "${key}"`)
    }
    const { column, op } = parseFilterKey(key)
    const col = columns[column]
    if (!col) throw new RepoError('BAD_REQUEST', `Unknown filter column "${column}"`)
    switch (op) {
      case 'eq':
        clauses.push(eq(col, value))
        break
      case 'ne':
        clauses.push(ne(col, value))
        break
      case 'in':
        clauses.push(inArray(col, value as unknown[]))
        break
      case 'ilike':
        // Wrapped in % server-side (§5.1); user input is escaped first.
        clauses.push(ilike(col, `%${escapeLike(String(value))}%`))
        break
      case 'gte':
        clauses.push(gte(col, value))
        break
      case 'lte':
        clauses.push(lte(col, value))
        break
    }
  }
  return clauses.length > 0 ? and(...clauses) : undefined
}
