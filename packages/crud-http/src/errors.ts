// Typed errors and the single place repository errors become HTTP responses.
// Wire format is stable (§5.3): `code` is the machine-readable contract,
// `message` is for humans and may change. Clients branch on `code`.
import { RepoError } from '@repo/crud-repo'
import { CursorError } from '@repo/entity'

export const COMMON_ERROR_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
} as const

export type CommonErrorCode = keyof typeof COMMON_ERROR_STATUS

export class HttpError extends Error {
  readonly code: string
  readonly status: number
  readonly data: unknown

  constructor(code: string, status: number, message: string, data?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.status = status
    this.data = data
  }

  toBody(): { code: string; message: string; data?: unknown } {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data }
  }
}

export interface ErrorOptions {
  message?: string
  data?: unknown
}

/**
 * Constructors handed to every handler: `throw errors.CONFLICT({ data })`.
 * An intersection, not a union of key sets — the common codes are always
 * present regardless of what a route adds.
 */
export type TypedErrors<Extra extends Record<string, number> = Record<never, number>> = {
  [K in CommonErrorCode]: (opts?: ErrorOptions) => HttpError
} & {
  [K in keyof Extra]: (opts?: ErrorOptions) => HttpError
}

const DEFAULT_MESSAGES: Record<string, string> = {
  BAD_REQUEST: 'Invalid request',
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'Not allowed',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
}

/** Build the error constructors for a route, merging any route-specific codes. */
export function makeErrors<Extra extends Record<string, number>>(
  extra?: Extra,
): TypedErrors<Extra> {
  const statuses: Record<string, number> = { ...COMMON_ERROR_STATUS, ...(extra ?? {}) }
  const out: Record<string, (opts?: ErrorOptions) => HttpError> = {}
  for (const [code, status] of Object.entries(statuses)) {
    out[code] = (opts) =>
      new HttpError(code, status, opts?.message ?? DEFAULT_MESSAGES[code] ?? code, opts?.data)
  }
  return out as TypedErrors<Extra>
}

/**
 * Repository and cursor errors → HTTP errors (AD-9 carried to the wire).
 * Anything unrecognized is rethrown so it surfaces as a real 500.
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err
  if (err instanceof RepoError) {
    const status = COMMON_ERROR_STATUS[err.code as CommonErrorCode] ?? 500
    return new HttpError(err.code, status, err.message, err.data)
  }
  if (err instanceof CursorError) {
    return new HttpError('BAD_REQUEST', 400, err.message)
  }
  throw err
}
