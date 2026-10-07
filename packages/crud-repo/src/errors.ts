// Error mapping happens once, here (AD-9). Handlers never look at pg codes.
// Map by error code, never by message string (§3.2).

export type RepoErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN'

export class RepoError extends Error {
  readonly code: RepoErrorCode
  readonly data: Record<string, unknown> | undefined

  constructor(code: RepoErrorCode, message: string, data?: Record<string, unknown>) {
    super(message)
    this.name = 'RepoError'
    this.code = code
    this.data = data
  }
}

interface PgErrorLike {
  code?: unknown
  constraint?: unknown
  constraint_name?: unknown
  table?: unknown
  cause?: unknown
}

/** Walk the error's `cause` chain for a 5-char SQLSTATE code. */
function findPgError(err: unknown, depth = 0): PgErrorLike | null {
  if (depth > 5 || typeof err !== 'object' || err === null) return null
  const e = err as PgErrorLike
  if (typeof e.code === 'string' && e.code.length === 5) return e
  return findPgError(e.cause, depth + 1)
}

function constraintOf(e: PgErrorLike): string | undefined {
  if (typeof e.constraint_name === 'string') return e.constraint_name
  if (typeof e.constraint === 'string') return e.constraint
  return undefined
}

/**
 * Translate a thrown database error into a RepoError, or rethrow untouched
 * when it is not a recognized Postgres error.
 */
export function mapDbError(err: unknown, entityName: string): never {
  if (err instanceof RepoError) throw err
  const pg = findPgError(err)
  if (pg) {
    const constraint = constraintOf(pg)
    switch (pg.code) {
      case '23505':
        throw new RepoError('CONFLICT', `${entityName} already exists`, { constraint })
      case '23503':
        throw new RepoError('BAD_REQUEST', `${entityName}: related record missing or in use`, {
          constraint,
        })
      case '23514':
        throw new RepoError('BAD_REQUEST', `${entityName}: check constraint violated`, {
          constraint,
        })
      case '22P02':
        throw new RepoError('BAD_REQUEST', `${entityName}: invalid value representation`)
    }
  }
  throw err
}
