// Full HTTP round trip per operation, plus the adversarial suite a
// security-minded reviewer would write (§7). Real sockets, real client.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { entityClient, isApiError, safe } from '@repo/entity/client'
import { userEntity, type signupInput } from '@repo/entity/entities/user'
import { postEntity } from '@repo/entity/entities/post'
import { buildApp, type App } from '../src/app'

// Paths are passed to the client as strings so the entity value stays out of
// browser bundles; `client paths match entity meta` below guards the drift.
const USERS_PATH = 'users'
const POSTS_PATH = 'posts'

function makeApi(baseUrl: string, headers: Record<string, string> = {}) {
  const opts = { baseUrl, headers: () => headers }
  return {
    user: entityClient<typeof userEntity, { create: typeof signupInput }>(USERS_PATH, opts),
    post: entityClient<typeof postEntity>(POSTS_PATH, opts),
  }
}
type Api = ReturnType<typeof makeApi>

let app: App
let baseUrl = ''
let asAdminA: Api
let asAdminB: Api
let asMemberA: Api
let asAnonymous: Api

beforeAll(async () => {
  app = await buildApp()
  await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const address = app.fastify.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`

  asAdminA = makeApi(`${baseUrl}/api`, adminAHeaders())
  asAdminB = makeApi(`${baseUrl}/api`, {
    'x-user-id': app.seeded.adminB,
    'x-org-id': app.seeded.orgB,
    'x-role': 'admin',
  })
  asMemberA = makeApi(`${baseUrl}/api`, {
    'x-user-id': app.seeded.memberA,
    'x-org-id': app.seeded.orgA,
    'x-role': 'member',
  })
  asAnonymous = makeApi(`${baseUrl}/api`)
})

afterAll(async () => {
  await app.fastify.close()
})

function adminAHeaders(): Record<string, string> {
  return {
    'x-user-id': app.seeded.adminA,
    'x-org-id': app.seeded.orgA,
    'x-role': 'admin',
  }
}

describe('generated CRUD over HTTP', () => {
  it('create returns 201 and the read shape', async () => {
    const res = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminAHeaders() },
      body: JSON.stringify({
        title: 'wire check',
        orgId: app.seeded.orgA,
        authorId: app.seeded.adminA,
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.title).toBe('wire check')
    expect(body.id).toBeTruthy()
  })

  it('list / byId / update / delete round-trip through the typed client', async () => {
    const created = await asAdminA.post.create({
      title: 'lifecycle',
      orgId: app.seeded.orgA,
      authorId: app.seeded.adminA,
      status: 'published',
    })
    const fetched = await asAdminA.post.byId(created.id)
    expect(fetched.title).toBe('lifecycle')

    const updated = await asAdminA.post.update(created.id, { title: 'lifecycle 2' })
    expect(updated.title).toBe('lifecycle 2')

    await asAdminA.post.delete(created.id)
    const [err] = await safe(asAdminA.post.byId(created.id))
    expect(err && isApiError(err) && err.code).toBe('NOT_FOUND')
  })

  it('delete returns 204 with no body', async () => {
    const created = await asAdminA.post.create({
      title: 'to delete',
      orgId: app.seeded.orgA,
      authorId: app.seeded.adminA,
    })
    const res = await fetch(`${baseUrl}/api/posts/${created.id}`, {
      method: 'DELETE',
      headers: adminAHeaders(),
    })
    expect(res.status).toBe(204)
  })

  it('filters and keyset pagination work end to end', async () => {
    for (let i = 0; i < 5; i++) {
      await asAdminA.post.create({
        title: `page-me ${i}`,
        orgId: app.seeded.orgA,
        authorId: app.seeded.adminA,
        status: 'archived',
      })
    }
    const page1 = await asAdminA.post.list({ status: 'archived', limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await asAdminA.post.list({
      status: 'archived',
      limit: 2,
      cursor: page1.nextCursor!,
    })
    const ids = new Set([...page1.items, ...page2.items].map((p) => p.id))
    expect(ids.size).toBe(4)
  })

  it('error body carries stable code + message + data (§5.3)', async () => {
    const res = await fetch(`${baseUrl}/api/users/00000000-0000-0000-0000-000000000000`, {
      headers: adminAHeaders(),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
    expect(body.code).toBe('NOT_FOUND')
    expect(typeof body.message).toBe('string')
    expect(body.data.entity).toBe('user')
  })
})

describe('replaced create route (signup)', () => {
  it('accepts the signup shape and runs the transactional handler', async () => {
    const user = await asAdminA.user.create({
      email: 'sign-up-e2e@example.com',
      name: 'Signup E2E',
      password: 'longenough1',
    })
    expect(user.email).toBe('sign-up-e2e@example.com')
    const welcome = await asAdminA.post.list({ authorId: user.id })
    expect(welcome.items[0]?.title).toContain('Welcome')
  })

  it('returns the typed EMAIL_TAKEN error on duplicates', async () => {
    const [err] = await safe(
      asAdminA.user.create({
        email: 'sign-up-e2e@example.com',
        name: 'Dupe',
        password: 'longenough1',
      }),
    )
    expect(err && isApiError(err) && err.code).toBe('EMAIL_TAKEN')
  })

  it('rejects the old generated create shape (route really replaced)', async () => {
    const res = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminAHeaders() },
      body: JSON.stringify({ name: 'No password', email: 'nopass@example.com' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('adversarial suite (§7)', () => {
  it('tenant B gets 404 for tenant A resources, never a body', async () => {
    const [byId] = await safe(asAdminB.user.byId(app.seeded.adminA))
    expect(byId && isApiError(byId) && byId.code).toBe('NOT_FOUND')
    const [update] = await safe(asAdminB.user.update(app.seeded.adminA, { name: 'pwn' }))
    expect(update && isApiError(update) && update.code).toBe('NOT_FOUND')
    const [del] = await safe(asAdminB.user.delete(app.seeded.adminA))
    expect(del && isApiError(del) && del.code).toBe('NOT_FOUND')
    const listB = await asAdminB.user.list({})
    expect(listB.items.every((u) => u.orgId === app.seeded.orgB)).toBe(true)
  })

  it('no token → 401 unless explicitly PUBLIC', async () => {
    const [listErr] = await safe(asAnonymous.user.list({}))
    expect(listErr && isApiError(listErr) && listErr.code).toBe('UNAUTHORIZED')
    const [createErr] = await safe(
      asAnonymous.post.create({
        title: 'x',
        orgId: app.seeded.orgA,
        authorId: app.seeded.adminA,
      }),
    )
    expect(createErr && isApiError(createErr) && createErr.code).toBe('UNAUTHORIZED')
    // post list/byId are PUBLIC and must work anonymously.
    const posts = await asAnonymous.post.list({ limit: 1 })
    expect(Array.isArray(posts.items)).toBe(true)
  })

  it('authorize function false → 403 FORBIDDEN', async () => {
    // user delete requires admin; member gets FORBIDDEN.
    const [err] = await safe(asMemberA.user.delete(app.seeded.adminA))
    expect(err && isApiError(err) && err.code).toBe('FORBIDDEN')
  })

  it('limit=100000 is clamped to maxLimit, not honored and not rejected', async () => {
    const res = await fetch(`${baseUrl}/api/posts?limit=100000`, { headers: adminAHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.items.length).toBeLessThanOrEqual(50)
  })

  it('unknown filter keys are rejected with 400, not silently ignored', async () => {
    const res = await fetch(`${baseUrl}/api/users?isAdmin=true`, { headers: adminAHeaders() })
    expect(res.status).toBe(400)
  })

  it('client paths match entity meta (guards the string/entity drift)', () => {
    expect(USERS_PATH).toBe(userEntity.meta.path)
    expect(POSTS_PATH).toBe(postEntity.meta.path)
  })

  it('omitted columns appear in no response, list or single', async () => {
    const list = await asAdminA.user.list({})
    for (const u of list.items) {
      expect(u).not.toHaveProperty('passwordHash')
      expect(u).not.toHaveProperty('internalNotes')
    }
    const one = await asAdminA.user.byId(app.seeded.adminA)
    expect(one).not.toHaveProperty('passwordHash')
  })
})
