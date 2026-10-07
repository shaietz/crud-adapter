import { pgTable, text, timestamp, uuid, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: text('role', { enum: ['admin', 'member'] })
      .notNull()
      .default('member'),
    status: text('status', { enum: ['active', 'invited', 'suspended'] })
      .notNull()
      .default('invited'),
    passwordHash: text('password_hash').notNull().default(''),
    internalNotes: text('internal_notes'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    index('users_org_created_idx').on(t.orgId, t.createdAt, t.id),
  ],
)
