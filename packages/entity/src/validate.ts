// Load-time runtime checks (§3.1). Cheap, and they survive `as any` in a
// hurry, which the type constraints do not.
import { getColumns, type Column } from 'drizzle-orm'
import { CRUD_OPS, PUBLIC, type AnyEntityConfig } from './types'

export function validateEntityConfig(config: AnyEntityConfig): void {
  const label = `defineEntity(${config.name})`
  const columns = getColumns(config.table) as Record<string, Column>
  const known = new Set(Object.keys(columns))

  const assertColumns = (keys: readonly string[] | undefined, where: string) => {
    for (const k of keys ?? []) {
      if (!known.has(k)) {
        throw new Error(`${label}: ${where} references unknown column "${k}"`)
      }
    }
  }

  // 1. Every key in omit, filter.*, and sort exists on the table.
  assertColumns(config.read?.omit, 'read.omit')
  assertColumns(config.create?.omit, 'create.omit')
  assertColumns(config.update?.omit, 'update.omit')
  assertColumns(config.filter.eq, 'filter.eq')
  assertColumns(config.filter.ilike, 'filter.ilike')
  assertColumns(config.filter.range, 'filter.range')
  assertColumns(config.sort, 'sort')

  // 2. defaultSort.field is in sort.
  if (!config.sort.includes(config.defaultSort.field)) {
    throw new Error(
      `${label}: defaultSort.field "${config.defaultSort.field}" is not in sort [${config.sort.join(', ')}]`,
    )
  }

  // 3. Every operation has an authorize entry (AD-5).
  for (const op of CRUD_OPS) {
    const rule = config.authorize?.[op]
    if (rule !== PUBLIC && typeof rule !== 'function') {
      throw new Error(
        `${label}: authorize.${op} is missing — every operation needs an explicit rule (use PUBLIC for public endpoints)`,
      )
    }
  }

  // 4. pk is a single existing column. Composite keys are unsupported in v1;
  //    fail explicitly rather than producing a broken route.
  if (typeof config.pk !== 'string' || !known.has(config.pk)) {
    throw new Error(`${label}: pk "${String(config.pk)}" is not a column of the table`)
  }

  if (config.maxLimit !== undefined && config.maxLimit < 1) {
    throw new Error(`${label}: maxLimit must be >= 1`)
  }
  if (
    config.defaultLimit !== undefined &&
    config.maxLimit !== undefined &&
    config.defaultLimit > config.maxLimit
  ) {
    throw new Error(`${label}: defaultLimit exceeds maxLimit`)
  }
}
