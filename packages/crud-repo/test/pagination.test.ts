import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { users } from '@repo/db/schema'
import { ORG_A, ctx, makeUserRepo } from './helpers'

async function seedUsers(
  db: Awaited<ReturnType<typeof makeUserRepo>>['db'],
  count: number,
  opts: { tieEvery?: number } = {},
) {
  const ids: string[] = []
  const base = Date.now() - count * 1000
  const rows = Array.from({ length: count }, (_, i) => {
    const id = randomUUID()
    ids.push(id)
    // With tieEvery, groups of rows share the exact same createdAt — the
    // row-value comparison must still paginate them without dupes or skips.
    const bucket = opts.tieEvery ? Math.floor(i / opts.tieEvery) * opts.tieEvery : i
    return {
      id,
      orgId: ORG_A,
      name: `u${String(i).padStart(4, '0')}`,
      email: `u${i}-${id.slice(0, 8)}@example.com`,
      passwordHash: 'x',
      status: 'active' as const,
      createdAt: new Date(base + bucket * 1000),
    }
  })
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(users).values(rows.slice(i, i + 500))
  }
  return ids
}

async function walkAllPages(
  repo: Awaited<ReturnType<typeof makeUserRepo>>['repo'],
  query: Record<string, unknown>,
  onPage?: (pageNo: number) => Promise<void>,
) {
  const seen: string[] = []
  let cursor: string | undefined
  let pageNo = 0
  do {
    const page = await repo.list(
      { ...query, ...(cursor ? { cursor } : {}) } as never,
      ctx(ORG_A),
    )
    pageNo++
    seen.push(...page.items.map((u) => u.id))
    cursor = page.nextCursor ?? undefined
    if (onPage) await onPage(pageNo)
    if (pageNo > 1000) throw new Error('cursor never terminated')
  } while (cursor)
  return seen
}

describe('keyset pagination', () => {
  it('returns exactly limit items and a cursor when more exist, null when not', async () => {
    const { db, repo } = await makeUserRepo()
    await seedUsers(db, 30)

    const first = await repo.list({ limit: 25 } as never, ctx(ORG_A))
    expect(first.items).toHaveLength(25)
    expect(first.nextCursor).not.toBeNull()

    const second = await repo.list({ limit: 25, cursor: first.nextCursor! } as never, ctx(ORG_A))
    expect(second.items).toHaveLength(5)
    expect(second.nextCursor).toBeNull()
  })

  it('pages through 1000 rows with concurrent inserts: no duplicates, no skips', async () => {
    const { db, repo } = await makeUserRepo()
    const originalIds = await seedUsers(db, 1000)

    const seen = await walkAllPages(repo, { limit: 50 }, async (pageNo) => {
      // Concurrent inserts while paginating (newest-first sort: new rows land
      // "before" the cursor and must not disturb the walk).
      if (pageNo % 5 === 0) {
        await db.insert(users).values({
          id: randomUUID(),
          orgId: ORG_A,
          name: 'concurrent',
          email: `concurrent-${pageNo}-${randomUUID().slice(0, 8)}@example.com`,
          passwordHash: 'x',
          createdAt: new Date(),
        })
      }
    })

    expect(new Set(seen).size).toBe(seen.length) // no duplicates
    const seenSet = new Set(seen)
    for (const id of originalIds) expect(seenSet.has(id)).toBe(true) // no skips
  })

  it('paginates correctly across ties on the sort column', async () => {
    const { db, repo } = await makeUserRepo()
    // 60 rows in groups of 10 sharing identical createdAt values.
    const ids = await seedUsers(db, 60, { tieEvery: 10 })

    const seen = await walkAllPages(repo, { limit: 7 })
    expect(seen).toHaveLength(60)
    expect(new Set(seen).size).toBe(60)
    expect(new Set(seen)).toEqual(new Set(ids))
  })

  it('supports ascending sort with the same tiebreak guarantees', async () => {
    const { db, repo } = await makeUserRepo()
    await seedUsers(db, 25, { tieEvery: 5 })
    const seen = await walkAllPages(repo, { limit: 4, sort: 'createdAt' })
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  it('rejects a malformed cursor as BAD_REQUEST', async () => {
    const { repo } = await makeUserRepo()
    await expect(
      repo.list({ cursor: '!!not-a-cursor!!' } as never, ctx(ORG_A)),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
