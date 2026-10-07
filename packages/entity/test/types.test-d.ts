// Type-level tests (§7): checked by `pnpm test:types` (tsc --noEmit).
// A stray @ts-expect-error with no error underneath fails the build too.
import { expectTypeOf } from 'vitest'
import type { InferSelectModel } from 'drizzle-orm'
import { users } from '@repo/db/schema'
import { userEntity } from '../src/entities/user'
import type { Read, ListQuery, PkType } from '../src/types'
import type { z } from 'zod'

type UserRead = Read<typeof userEntity>
type UserRow = InferSelectModel<typeof users>

// schemas.read matches the table type minus omissions…
expectTypeOf<UserRead>().toEqualTypeOf<Omit<UserRow, 'passwordHash' | 'internalNotes'>>()
// …and z.infer of the runtime schema agrees with the declared type.
expectTypeOf<z.infer<typeof userEntity.schemas.read>>().toEqualTypeOf<UserRead>()

// Omitted keys are ABSENT from the type, not just optional.
declare const read: UserRead
// @ts-expect-error passwordHash is omitted from the read policy
read.passwordHash
// @ts-expect-error internalNotes is omitted from the read policy
read.internalNotes
expectTypeOf<'passwordHash' extends keyof UserRead ? true : false>().toEqualTypeOf<false>()

// Filter keys are exactly the spec's keys with their operator suffixes.
type Q = ListQuery<typeof userEntity>
declare const q: Q
expectTypeOf(q.status).toEqualTypeOf<'active' | 'invited' | 'suspended' | undefined>()
expectTypeOf(q.status__in).toEqualTypeOf<Array<'active' | 'invited' | 'suspended'> | undefined>()
expectTypeOf(q.name__ilike).toEqualTypeOf<string | undefined>()
expectTypeOf(q.createdAt__gte).toEqualTypeOf<Date | undefined>()
expectTypeOf(q.sort).toEqualTypeOf<'createdAt' | '-createdAt' | 'name' | '-name' | undefined>()
// @ts-expect-error email is not eq-filterable (only ilike)
q.email
// @ts-expect-error range operators only exist for range-allowlisted fields
q.name__gte

// The pk type flows through.
expectTypeOf<PkType<typeof userEntity>>().toEqualTypeOf<string>()

export {}
