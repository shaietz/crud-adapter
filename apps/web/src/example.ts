// Fully working end-to-end example: boots the API over real HTTP, then
// exercises every generated operation, filters, keyset pagination, the
// replaced signup route, typed errors, and tenant isolation — all through the
// typed client. The client's only import is @repo/entity, which is the shared
// contract; there is no codegen step and no database code in its graph.
import { buildApp } from '@app/api'
// The client has zero runtime imports, and the entities come in as TYPES only
// — `import type` erases completely, so none of Zod, drizzle, or the schema
// builder reaches the browser bundle (AD-8).
import { entityClient, isApiError, safe } from '@repo/entity/client'
import type { signupInput, userEntity } from '@repo/entity/entities/user'
import type { postEntity } from '@repo/entity/entities/post'

const { fastify, seeded } = await buildApp()
await fastify.listen({ port: 0, host: '127.0.0.1' })
const address = fastify.server.address()
const port = typeof address === 'object' && address ? address.port : 0
const baseUrl = `http://127.0.0.1:${port}/api`
console.log(`API listening at ${baseUrl}\n`)

/** One typed client bundle per caller identity. */
function api(headers: Record<string, string> = {}) {
  const opts = { baseUrl, headers: () => headers }
  return {
    // The second type argument says this route's contract differs from the
    // generated one, so `user.create` takes the signup shape.
    user: entityClient<typeof userEntity, { create: typeof signupInput }>('users', opts),
    post: entityClient<typeof postEntity>('posts', opts),
  }
}

const asAdminA = api({
  'x-user-id': seeded.adminA,
  'x-org-id': seeded.orgA,
  'x-role': 'admin',
})
const asAdminB = api({
  'x-user-id': seeded.adminB,
  'x-org-id': seeded.orgB,
  'x-role': 'admin',
})
const asAnonymous = api()

// ── 1. Signup: the REPLACED create route (different input shape) ───────────
const nora = await asAdminA.user.create({
  email: 'nora@example.com',
  name: 'Nora Newcomer',
  password: 'hunter2hunter2',
})
console.log('1. signed up:', nora.name, nora.email, '(id', nora.id.slice(0, 8) + '…)')
// The read policy means passwordHash/internalNotes never leave the database:
console.log('   passwordHash in response?', 'passwordHash' in nora)

// ── 2. Typed EMAIL_TAKEN error declared by that route ──────────────────────
const [error] = await safe(
  asAdminA.user.create({ email: 'nora@example.com', name: 'Dupe', password: 'hunter2hunter2' }),
)
if (error && isApiError(error) && error.code === 'EMAIL_TAKEN') {
  console.log('2. duplicate signup → typed error:', error.code, error.data)
}

// ── 3. The signup handler created a welcome post in the same transaction ───
const welcome = await asAdminA.post.list({ authorId: nora.id })
console.log('3. transactional welcome post:', welcome.items[0]?.title)

// ── 4. Generated create + filters on the fully-generated post entity ───────
for (let i = 1; i <= 7; i++) {
  await asAdminA.post.create({
    title: `Changelog #${i}`,
    content: `Entry number ${i}`,
    status: i % 2 ? 'published' : 'draft',
    orgId: seeded.orgA,
    authorId: seeded.adminA,
  })
}
const drafts = await asAdminA.post.list({ status: 'draft', title__ilike: 'changelog' })
console.log('4. filtered list (draft changelogs):', drafts.items.map((p) => p.title).join(', '))

// ── 5. Keyset pagination: walk all pages with nextCursor ───────────────────
let cursor: string | undefined
const seen: string[] = []
let pages = 0
do {
  const page = await asAdminA.post.list({ limit: 3, ...(cursor ? { cursor } : {}) })
  pages++
  seen.push(...page.items.map((p) => p.title))
  cursor = page.nextCursor ?? undefined
} while (cursor)
console.log(`5. paginated ${seen.length} posts across ${pages} pages of 3`)

// ── 6. byId / update / delete on the generated routes ──────────────────────
const first = drafts.items[0]!
const renamed = await asAdminA.post.update(first.id, { title: 'Renamed via PATCH' })
console.log('6. update:', first.title, '→', renamed.title)
await asAdminA.post.delete(first.id)
const [gone] = await safe(asAdminA.post.byId(first.id))
console.log('   after delete, byId →', gone && isApiError(gone) ? gone.code : '??')

// ── 7. Tenant isolation: org B cannot see or touch org A's users ───────────
const orgBView = await asAdminB.user.list({})
console.log('7. org B sees', orgBView.items.length, 'user(s) — its own only')
const [crossTenant] = await safe(asAdminB.user.update(nora.id, { name: 'Hijacked' }))
console.log(
  '   org B updating org A user →',
  crossTenant && isApiError(crossTenant) ? crossTenant.code : '??',
)

// ── 8. Soft delete: user vanishes from reads, email stays reserved ─────────
await asAdminA.user.delete(nora.id)
const [afterDelete] = await safe(asAdminA.user.byId(nora.id))
console.log(
  '8. soft-deleted user byId →',
  afterDelete && isApiError(afterDelete) ? afterDelete.code : '??',
)
const [reuse] = await safe(
  asAdminA.user.create({ email: 'nora@example.com', name: 'Nora II', password: 'hunter2hunter2' }),
)
console.log('   reusing soft-deleted email →', reuse && isApiError(reuse) ? reuse.code : '??')

// ── 9. Auth: anonymous is 401 unless PUBLIC ────────────────────────────────
const [anonUsers] = await safe(asAnonymous.user.list({}))
console.log('9. anonymous /users →', anonUsers && isApiError(anonUsers) ? anonUsers.code : '??')
const publicPosts = await asAnonymous.post.list({ status: 'published', limit: 2 })
console.log('   anonymous /posts (PUBLIC) → first page of', publicPosts.items.length)

await fastify.close()
console.log('\nDone — every call above went over real HTTP through the typed client.')
