// Zod derivation from Drizzle tables (AD-10: drizzle-orm/zod, not drizzle-zod).
// createSchemaFactory is called once at module scope with the plain zod
// instance — a wrapped instance breaks refine-callback inference (§3.1).
import { createSchemaFactory } from 'drizzle-orm/zod'
import { getColumns, type Column, type Table } from 'drizzle-orm'
import { z } from 'zod'
import type { AnyEntityConfig } from './types'

export const { createSelectSchema, createInsertSchema, createUpdateSchema } = createSchemaFactory({
  zodInstance: z,
})

/** `.omit()` takes a `Record<key, true>`; preserve literal keys (§3.1). */
export const toOmitMask = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, true])) as { [P in K]: true }

type AnyZodObject = z.ZodObject<Record<string, z.ZodType>>

function applyOmit(schema: AnyZodObject, omit: readonly string[] | undefined): AnyZodObject {
  if (!omit || omit.length === 0) return schema
  return schema.omit(toOmitMask(omit) as never) as AnyZodObject
}

export interface RuntimeSchemas {
  read: AnyZodObject
  create: AnyZodObject
  update: AnyZodObject
  pk: z.ZodType
  readColumns: string[]
}

export function buildRuntimeSchemas(config: AnyEntityConfig): RuntimeSchemas {
  const table = config.table
  const fullSelect = createSelectSchema(table) as unknown as AnyZodObject
  const read = applyOmit(fullSelect, config.read?.omit)

  const createBase = createInsertSchema(
    table,
    (config.create?.refine ?? undefined) as never,
  ) as unknown as AnyZodObject
  const create = applyOmit(createBase, config.create?.omit)

  const updateBase =
    config.update?.partial === false
      ? (createInsertSchema(table, (config.update?.refine ?? undefined) as never) as unknown as AnyZodObject)
      : (createUpdateSchema(table, (config.update?.refine ?? undefined) as never) as unknown as AnyZodObject)
  const update = applyOmit(updateBase, config.update?.omit)

  const pkSchema = fullSelect.shape[config.pk]
  if (!pkSchema) throw new Error(`pk column "${config.pk}" has no derived schema`)

  const allColumns = Object.keys(getColumns(table) as Record<string, Column>)
  const omitted = new Set(config.read?.omit ?? [])
  const readColumns = allColumns.filter((c) => !omitted.has(c))

  return { read, create, update, pk: pkSchema, readColumns }
}
