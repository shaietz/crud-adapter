// Cursor codec + list query/result schema builders.
// Cursors are versioned base64url JSON: { v: 1, s: [sortValue], pk: pkValue }.
// Versioned from day one so the encoding can change without breaking clients
// holding old cursors (§3.2).
import { z } from 'zod'

export interface CursorPayload {
  v: 1
  s: readonly unknown[]
  pk: unknown
}

/** Thrown for malformed/incompatible cursors; mapped to BAD_REQUEST upstream. */
export class CursorError extends Error {
  constructor(message = 'Malformed pagination cursor') {
    super(message)
    this.name = 'CursorError'
  }
}

// btoa/atob are available in Node ≥16 and every browser — no Buffer, so this
// module stays client-safe (AD-8).
function base64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64urlDecode(encoded: string): string {
  const b64 = encoded.replaceAll('-', '+').replaceAll('_', '/')
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function encodeCursor(payload: CursorPayload): string {
  return base64urlEncode(JSON.stringify(payload))
}

export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(base64urlDecode(cursor))
  } catch {
    throw new CursorError()
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as CursorPayload).v !== 1 ||
    !Array.isArray((parsed as CursorPayload).s)
  ) {
    throw new CursorError()
  }
  return parsed as CursorPayload
}

export interface ListQuerySchemaOptions {
  filterShape: Record<string, z.ZodType>
  sortFields: readonly string[]
  defaultSort: { field: string; dir: 'asc' | 'desc' }
  maxLimit: number
  defaultLimit: number
  pagination: 'keyset' | 'offset'
}

export function buildListQuerySchema(opts: ListQuerySchemaOptions): z.ZodType {
  const sortValues = opts.sortFields.flatMap((f) => [f, `-${f}`]) as [string, ...string[]]
  const defaultSortParam =
    opts.defaultSort.dir === 'desc' ? `-${opts.defaultSort.field}` : opts.defaultSort.field
  const pageShape: Record<string, z.ZodType> =
    opts.pagination === 'offset'
      ? { offset: z.coerce.number().int().min(0).default(0) }
      : { cursor: z.string().optional() }
  // Strict object: unknown query keys are rejected with a 400 (§4.1).
  return z.strictObject({
    ...opts.filterShape,
    sort: z.enum(sortValues).default(defaultSortParam),
    // limit is clamped to maxLimit, not rejected (§7 adversarial suite).
    limit: z.coerce
      .number()
      .int()
      .positive()
      .transform((n) => Math.min(n, opts.maxLimit))
      .default(opts.defaultLimit),
    ...pageShape,
  })
}

export function buildListResultSchema(readSchema: z.ZodType): z.ZodType {
  return z.object({
    items: z.array(readSchema),
    nextCursor: z.string().nullable(),
  })
}
