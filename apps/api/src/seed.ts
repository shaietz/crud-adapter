import { randomUUID } from 'node:crypto'
import type { Db } from '@repo/db'
import { users } from '@repo/db/schema'

export interface SeedResult {
  orgA: string
  orgB: string
  adminA: string
  memberA: string
  adminB: string
}

/** Two tenants with an admin each, plus a member in tenant A. */
export async function seed(db: Db): Promise<SeedResult> {
  const orgA = randomUUID()
  const orgB = randomUUID()
  const adminA = randomUUID()
  const memberA = randomUUID()
  const adminB = randomUUID()

  await db.insert(users).values([
    {
      id: adminA,
      orgId: orgA,
      name: 'Ada Admin',
      email: `ada-${orgA.slice(0, 8)}@example.com`,
      role: 'admin',
      status: 'active',
      passwordHash: 'seeded',
      internalNotes: 'do not leak this',
    },
    {
      id: memberA,
      orgId: orgA,
      name: 'Mel Member',
      email: `mel-${orgA.slice(0, 8)}@example.com`,
      role: 'member',
      status: 'active',
      passwordHash: 'seeded',
    },
    {
      id: adminB,
      orgId: orgB,
      name: 'Bea Boss',
      email: `bea-${orgB.slice(0, 8)}@example.com`,
      role: 'admin',
      status: 'active',
      passwordHash: 'seeded',
    },
  ])

  return { orgA, orgB, adminA, memberA, adminB }
}
