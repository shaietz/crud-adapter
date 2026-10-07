import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ORG_A, ctx, makePostRepo, makeUserRepo, userInput } from './helpers'

describe('error mapping (AD-9)', () => {
  it('unique violation surfaces as CONFLICT with the constraint name', async () => {
    const { repo } = await makeUserRepo()
    const input = userInput(ORG_A)
    await repo.create(input, ctx(ORG_A))
    await expect(repo.create(input, ctx(ORG_A))).rejects.toMatchObject({
      code: 'CONFLICT',
      data: { constraint: 'users_email_unique' },
    })
  })

  it('FK violation surfaces as BAD_REQUEST', async () => {
    const { repo } = await makePostRepo()
    await expect(
      repo.create(
        { title: 'orphan', orgId: ORG_A, authorId: randomUUID() },
        ctx(ORG_A),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('invalid text representation (bad uuid) surfaces as BAD_REQUEST', async () => {
    const { repo } = await makeUserRepo()
    await expect(repo.byId('not-a-uuid', ctx(ORG_A))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('zero rows on byId / update / delete is NOT_FOUND', async () => {
    const { repo } = await makeUserRepo()
    const missing = randomUUID()
    await expect(repo.byId(missing, ctx(ORG_A))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(repo.update(missing, { name: 'x' }, ctx(ORG_A))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(repo.delete(missing, ctx(ORG_A))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('hooks', () => {
  it('beforeCreate transforms the input', async () => {
    const { repo } = await makeUserRepo({
      hooks: { beforeCreate: ({ input, ctx: c }) => ({ ...input, createdBy: c.userId }) },
    })
    const c = ctx(ORG_A)
    const created = await repo.create(userInput(ORG_A), c)
    expect(created.createdBy).toBe(c.userId)
  })

  it('a hook throwing inside a transaction rolls back the write', async () => {
    const { db, repo } = await makeUserRepo({
      hooks: {
        afterCreate: () => {
          throw new Error('boom')
        },
      },
    })
    const input = userInput(ORG_A)
    await expect(
      db.transaction(async (tx) => {
        await repo.create(input, ctx(ORG_A), tx)
      }),
    ).rejects.toThrow('boom')
    // The INSERT rolled back with the hook's failure.
    const listed = await repo.list({ name__ilike: input.name } as never, ctx(ORG_A))
    expect(listed.items).toHaveLength(0)
  })

  it('empty patch update resolves to the current row (no invalid SQL)', async () => {
    const { repo } = await makeUserRepo()
    const a = await repo.create(userInput(ORG_A), ctx(ORG_A))
    const same = await repo.update(a.id, {}, ctx(ORG_A))
    expect(same.id).toBe(a.id)
  })
})
