// Authorization enforcement wrapper. Runs in front of every handler,
// including custom and overridden ones — an override cannot bypass `authorize`.
import { AUTH_FILTER, PUBLIC, type AuthorizeRule, type RequestContext } from '@repo/entity'

export interface AuthErrors {
  UNAUTHORIZED: (opts?: { message?: string }) => Error
  FORBIDDEN: (opts?: { message?: string }) => Error
}

/**
 * Evaluate an authorize rule. Returns the context to hand the handler:
 * - PUBLIC / `true`  → context unchanged
 * - `false`          → throws FORBIDDEN
 * - no authenticated user (and not PUBLIC) → throws UNAUTHORIZED
 * - a SQL fragment   → a copy of the context carrying it under AUTH_FILTER,
 *   which the repository ANDs into scopedWhere (AD-6) — so custom handlers
 *   that call the repo inherit the restriction too.
 */
export async function enforceAuthorize<Ctx extends RequestContext>(
  rule: AuthorizeRule<Ctx>,
  context: Ctx,
  input: unknown,
  errors: AuthErrors,
): Promise<Ctx> {
  if (rule === PUBLIC) return context
  if (!context.userId) throw errors.UNAUTHORIZED()
  const id =
    typeof input === 'object' && input !== null ? (input as { id?: unknown }).id : undefined
  const result = await rule(context, id)
  if (result === false) throw errors.FORBIDDEN()
  if (result === true) return context
  // Anything else is a Drizzle SQL fragment.
  return { ...context, [AUTH_FILTER]: result }
}
