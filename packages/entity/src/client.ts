// Typed fetch client for an entity. Client-safe: `fetch` only, no driver, no
// server code. Because the frontend lives in the same repo, the entity IS the
// shared contract — no separate contract package, no codegen step.
//
// IMPORTANT: this module has zero runtime imports, and the entity is supplied
// as a *type parameter*, never as a value. That is deliberate — importing an
// entity value pulls `defineEntity`, `drizzle-orm/zod` and Zod into the bundle
// (~475KB measured). Import it with `import type` and the whole thing erases:
//
//   import { entityClient } from '@repo/entity/client'
//   import type { userEntity } from '@repo/entity/entities/user'
//   const users = entityClient<typeof userEntity>('users', { baseUrl })
//
// Import this module from '@repo/entity/client', not the package barrel — the
// barrel re-exports defineEntity and would drag the schema builder in with it.
import type { z } from 'zod'
import type {
  AnyEntity,
  Create,
  ListQuery,
  ListResult,
  PkType,
  Read,
  Update,
} from './types'

/** Error carrying the server's stable `code` (§5.3). Branch on `code`. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly data: unknown

  constructor(code: string, status: number, message: string, data?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.data = data
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError
}

/** `const [err, data] = await safe(api.list())` — avoids try/catch at call sites. */
export async function safe<T>(promise: Promise<T>): Promise<[ApiError | null, T | undefined]> {
  try {
    return [null, await promise]
  } catch (err) {
    if (isApiError(err)) return [err, undefined]
    throw err
  }
}

/** Per-operation input schema overrides, for routes whose contract differs. */
export interface ClientOverrides {
  create?: z.ZodType
}

type CreateInput<E extends AnyEntity, O extends ClientOverrides> = O extends {
  create: infer S extends z.ZodType
}
  ? z.input<S>
  : Create<E>

export interface EntityClientOptions {
  baseUrl: string
  headers?: () => Record<string, string> | Promise<Record<string, string>>
}

/** Flatten a query object into querystring params (dates → ISO, arrays → CSV). */
function toSearchParams(query: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.map(String).join(','))
    } else if (value instanceof Date) {
      params.set(key, value.toISOString())
    } else {
      params.set(key, String(value))
    }
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export interface EntityClient<E extends AnyEntity, O extends ClientOverrides> {
  list(query?: ListQuery<E>): Promise<ListResult<E>>
  byId(id: PkType<E>): Promise<Read<E>>
  create(input: CreateInput<E, O>): Promise<Read<E>>
  update(id: PkType<E>, patch: Update<E>): Promise<Read<E>>
  delete(id: PkType<E>): Promise<void>
}

/**
 * @param path URL segment for the entity — must match its `meta.path`. Passed
 *   explicitly rather than read off the entity so the entity value never enters
 *   the bundle; an e2e test asserts the two agree.
 */
export function entityClient<E extends AnyEntity, O extends ClientOverrides = ClientOverrides>(
  path: string,
  options: EntityClientOptions,
): EntityClient<E, O> {
  const base = `${options.baseUrl.replace(/\/$/, '')}/${path}`

  const request = async (method: string, url: string, body?: unknown): Promise<unknown> => {
    const headers: Record<string, string> = { ...(await options.headers?.()) }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (res.status === 204) return undefined
    const text = await res.text()
    const payload = text ? (JSON.parse(text) as unknown) : undefined
    if (!res.ok) {
      const e = (payload ?? {}) as { code?: string; message?: string; data?: unknown }
      throw new ApiError(
        e.code ?? 'ERROR',
        res.status,
        e.message ?? `Request failed with ${res.status}`,
        e.data,
      )
    }
    return payload
  }

  return {
    list: async (query) =>
      (await request(
        'GET',
        `${base}${toSearchParams((query ?? {}) as Record<string, unknown>)}`,
      )) as ListResult<E>,
    byId: async (id) => (await request('GET', `${base}/${String(id)}`)) as Read<E>,
    create: async (input) => (await request('POST', base, input)) as Read<E>,
    update: async (id, patch) =>
      (await request('PATCH', `${base}/${String(id)}`, patch)) as Read<E>,
    delete: async (id) => {
      await request('DELETE', `${base}/${String(id)}`)
    },
  }
}
