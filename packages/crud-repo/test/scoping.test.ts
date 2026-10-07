import { describe, expect, it } from 'vitest'
import { ORG_A, ORG_B, ctx, makeUserRepo, userInput } from './helpers'

describe('tenant scoping (AD-6)', () => {
  it('list only returns the tenant’s rows', async () => {
    const { repo } = await makeUserRepo()
    await repo.create(userInput(ORG_A), ctx(ORG_A))
    await repo.create(userInput(ORG_B), ctx(ORG_B))

    const listA = await repo.list({} as never, ctx(ORG_A))
    expect(listA.items).toHaveLength(1)
    expect(listA.items[0]!.orgId).toBe(ORG_A)
  })

  it('byId with a foreign tenant’s id is NOT_FOUND, not a leak', async () => {
    const { repo } = await makeUserRepo()
    const a = await repo.create(userInput(ORG_A), ctx(ORG_A))
    await expect(repo.byId(a.id, ctx(ORG_B))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await repo.find(a.id, ctx(ORG_B))).toBeNull()
  })

  it('update with a foreign tenant’s id is NOT_FOUND, not success', async () => {
    const { repo } = await makeUserRepo()
    const a = await repo.create(userInput(ORG_A), ctx(ORG_A))
    await expect(
      repo.update(a.id, { name: 'hijacked' }, ctx(ORG_B)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // And the row is untouched.
    const fresh = await repo.byId(a.id, ctx(ORG_A))
    expect(fresh.name).not.toBe('hijacked')
  })

  it('delete with a foreign tenant’s id is NOT_FOUND', async () => {
    const { repo } = await makeUserRepo()
    const a = await repo.create(userInput(ORG_A), ctx(ORG_A))
    await expect(repo.delete(a.id, ctx(ORG_B))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(repo.byId(a.id, ctx(ORG_A))).resolves.toBeTruthy()
  })
})

describe('projection (read policy)', () => {
  it('omitted columns never appear in any result object', async () => {
    const { repo } = await makeUserRepo()
    const created = await repo.create(
      userInput(ORG_A, { internalNotes: 'secret' }),
      ctx(ORG_A),
    )
    const fetched = await repo.byId(created.id, ctx(ORG_A))
    const listed = await repo.list({} as never, ctx(ORG_A))

    for (const row of [created, fetched, listed.items[0]!]) {
      expect(Object.keys(row)).not.toContain('passwordHash')
      expect(Object.keys(row)).not.toContain('internalNotes')
      expect(row).toHaveProperty('email')
    }
  })

  it('project() applies the read policy to hand-fetched rows', async () => {
    const { repo } = await makeUserRepo()
    const projected = repo.project({ id: '1', passwordHash: 'oops', name: 'n' })
    expect(projected).not.toHaveProperty('passwordHash')
    expect(projected).toHaveProperty('name')
  })
})

describe('soft delete', () => {
  it('delete hides the row from every read', async () => {
    const { repo } = await makeUserRepo()
    const a = await repo.create(userInput(ORG_A), ctx(ORG_A))
    await repo.delete(a.id, ctx(ORG_A))
    await expect(repo.byId(a.id, ctx(ORG_A))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const listed = await repo.list({} as never, ctx(ORG_A))
    expect(listed.items).toHaveLength(0)
  })

  it('creating over a soft-deleted unique key surfaces as CONFLICT', async () => {
    const { repo } = await makeUserRepo()
    const input = userInput(ORG_A)
    const a = await repo.create(input, ctx(ORG_A))
    await repo.delete(a.id, ctx(ORG_A))
    await expect(repo.create(input, ctx(ORG_A))).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
