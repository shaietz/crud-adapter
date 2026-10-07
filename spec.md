# Typed CRUD Toolkit — Design Spec & Implementation Plan

Fastify 5 · Drizzle ORM v1 · Zod 4 · oRPC · TypeScript monorepo

---

## 0. Purpose and scope

### 0.1 Problem

Repetitive CRUD endpoints are written by hand for each Drizzle entity. Each one repeats
the same five concerns: input validation, tenant scoping, pagination, response shaping,
and error mapping. The client side then repeats the same shapes a third time, by hand,
with no compile-time link back to the server.

### 0.2 Goals

1. One declaration per entity produces validated, paginated, scoped CRUD endpoints.
2. The client gets full autocomplete on paths, inputs, filters, and outputs, with no
   codegen step in the build.
3. Any single operation can be overridden — its handler, its input shape, or its whole
   contract — without abandoning the generator for the other operations.
4. Overriding is enforced by the type system. If you change a contract, TypeScript
   demands a matching implementation. Silent mismatches are impossible.
5. Generated endpoints are secure by default. Forgetting to configure authorization is a
   compile error, not an open endpoint.

### 0.3 Non-goals

These are explicitly out of scope. Each one is a known failure mode of this class of
abstraction.

| Non-goal | Why |
|---|---|
| A general query language (arbitrary field/operator combinations) | Unindexable, unauthorizable, untypeable. This is how PostgREST clones die. |
| Nested writes (`POST /users` creating an org inline) | Transaction and authorization semantics become impossible to reason about. Hand-write these. |
| `?include=posts,comments` relation expansion | Turns into a bad GraphQL. Hand-write nested reads with RQBv2. |
| Auto-mounting every table in the schema | Every generated endpoint is an endpoint nobody reviewed. Entities opt in explicitly. |
| Bulk mutations (`DELETE /users?status=inactive`) | One typo, one wrong `where`, unbounded blast radius. Hand-write with an explicit guard. |
| Replacing Drizzle's query builder | The repository layer wraps common cases and gets out of the way for everything else. |

### 0.4 Success criteria

- Adding a plain CRUD entity is under 20 lines and touches one file.
- Overriding one operation adds under 15 lines and does not require touching the
  generator.
- The client bundle contains zero database driver code.
- A new engineer can read `defineEntity` output types in their editor and understand the
  API surface without reading the generator source.

---

## 1. Architecture decisions

Each decision below states the choice, the reasoning, and what was rejected. These are
the decisions that are expensive to reverse later, so they're recorded explicitly.

### AD-1: Rent the contract and client layer from oRPC; build the entity and repository layers in-house

**Choice.** Use `@orpc/contract`, `@orpc/server`, `@orpc/client`, `@orpc/openapi` for the
transport, contract, and client. Build `defineEntity` and `crudRepository` ourselves.

**Reasoning.** The valuable, domain-specific work is turning a Drizzle table into
validated schemas and scoped data access. The generic work — a contract format, an
end-to-end typed fetch client, OpenAPI generation, typed errors — is weeks of type
gymnastics that produces a worse result than an actively maintained library. oRPC has a
native Fastify adapter (`@orpc/server/fastify`, `@orpc/openapi/fastify`) that uses
Fastify's request/reply objects directly rather than side-loading a Node server, so
Fastify decorators, cookies, and hooks continue to work.

**Rejected: ts-rest.** Fastify 5 support has been sitting in unmerged PRs since September
2025. There is a long-running "Future of ts-rest" issue in which users compare its
trajectory to Zodios, which was abandoned. The entire cross-package type story would sit
on it.

**Rejected: rolling our own contract + client.** Feasible (people have done it in a few
days with LLM assistance), but you inherit maintenance of the inference layer forever, and
you lose OpenAPI generation and TanStack Query bindings for free.

**Rejected: tRPC.** Not REST-shaped. If any consumer is a mobile app, a third party, or
anything that wants an OpenAPI spec, tRPC is the wrong tool. oRPC gives RPC ergonomics
with REST-shaped URLs.

**Rejected: PostgREST / Supabase / Hasura.** Excellent when authorization is fully
expressible in RLS and you want no backend. You have a Fastify app with business logic, so
adopting one means running two authorization systems that will eventually disagree. Worth
stealing query-grammar ideas from, not worth adopting.

**Rejected: existing Drizzle CRUD generators** (`drizzle-crud` from saas-js,
`drizzle-rest`, `hono-crud`). All early-stage, single-maintainer, and opinionated in
exactly the direction that breaks the "override one operation" requirement.

**Exit plan.** The contract layer is confined to `@repo/contract`. If oRPC becomes
untenable, that one package is replaced; `@repo/entity` and `@repo/crud-repo` are
untouched. Estimated cost of that swap: two weeks.

### AD-2: Every layer is a pure function returning a plain value

**Choice.** `defineEntity`, `crudContract`, `crudRepository`, and `implementCrud` all
return plain objects. Nothing registers itself with a global, nothing mutates a router,
nothing holds hidden state.

**Reasoning.** This is the single mechanism that makes overriding possible. Because
`crudContract(entity)` returns an object, `{ ...crudContract(entity), create: myRoute }`
is a valid override with no special API. Because `implementCrud` returns a router value
rather than mounting it, you decide where it lives. Every "I had to fork the library"
story starts with a generator that owns registration.

**Rejected: decorator or plugin-based registration.** Reads nicer in the happy path,
makes partial overrides require an escape-hatch API that never covers every case.

### AD-3: Filterable and sortable fields are an explicit allowlist

**Choice.** `defineEntity` requires a `filter` spec naming which columns are filterable
under which operators, and a `sort` array.

**Reasoning.** Three benefits. Autocomplete on the client is real and narrow rather than
`Record<string, unknown>`. You cannot accidentally ship a filter on an unindexed column
that table-scans in production. Authorization review has a finite surface to review.

**Rejected: filter on any column.** Produces `?filter={"json":"blob"}` or a
PostgREST-style string grammar. Both lose autocomplete, both are unindexable by
construction, and both make the response schema depend on user input.

### AD-4: Keyset (cursor) pagination is the default; offset is opt-in

**Choice.** List responses return `{ items, nextCursor }`. Offset pagination is available
per entity via `pagination: 'offset'` but is not the default.

**Reasoning.** `OFFSET 50000` degrades linearly and is a latent incident on any table that
grows. Keyset is stable under concurrent inserts. The cost is that you cannot jump to
page 12, which is not a requirement for API consumers, only for admin UIs.

**Rejected: offset by default.** Easier to explain, worse in production, and switching
later is a breaking API change for every consumer.

### AD-5: Authorization is a required field with no default

**Choice.** `defineEntity` requires an `authorize` object with an entry for every enabled
operation. There is no default value and no `authorize: 'public'` shorthand that is easy
to type by accident. Public endpoints use `authorize: { list: PUBLIC }` where `PUBLIC` is
an explicitly imported symbol.

**Reasoning.** Generating five endpoints per entity means generating five endpoints nobody
reviewed. A generator with permissive defaults will eventually produce a data leak; the
question is only when. Making the compiler refuse to build converts that class of incident
into a build failure.

### AD-6: Tenant scoping lives in the repository, not in handlers

**Choice.** `crudRepository` takes a `scope(ctx) => SQL` fragment that is merged into the
`WHERE` of every read *and* every write, including `update` and `delete` by primary key.

**Reasoning.** A handler that forgets scoping is a cross-tenant leak. Put it below the
handler layer so custom handlers inherit it for free. Scoping `update`/`delete` by PK
matters: without it, `PATCH /users/:id` with another tenant's id succeeds.

**Rejected: Postgres RLS.** Genuinely good, and compatible with this design — you can use
both. Not sufficient alone, because connection-pooled Node apps make `SET LOCAL role`
fiddly, and it does not solve the "which fields can this role write" question.

### AD-7: Every repository method accepts an optional transaction handle

**Choice.** Signature is `create(input, ctx, tx?)`, and so on.

**Reasoning.** Custom handlers routinely need to compose several repository calls
atomically. Retrofitting `tx` later means touching every call site in the monorepo. Add it
on day one even though nothing uses it yet.

### AD-8: Table definitions must be importable without the database driver

**Choice.** `@repo/db` has two entrypoints: `@repo/db/schema` (table definitions,
`drizzle-orm/pg-core` only) and `@repo/db` (client, driver, connection). `@repo/entity`
and `@repo/contract` may only import the former.

**Reasoning.** The contract package derives Zod schemas from Drizzle tables, so tables end
up in the client bundle. If a table module transitively imports `postgres` or `pg`, the
driver follows it into the browser. This is the most common way this architecture goes
wrong, and it is invisible until someone looks at a bundle analysis.

**Enforcement.** An ESLint `no-restricted-imports` rule plus a CI bundle-size assertion.
Not a convention, a build failure.

### AD-9: Error mapping happens once, in the repository layer

**Choice.** A single interceptor maps Postgres error codes and empty result sets to typed
contract errors. Handlers never write `if (err.code === '23505')`.

**Reasoning.** Custom handlers inherit correct error mapping for free. oRPC's typed errors
carry the mapping through to the client, so `if (error.code === 'CONFLICT')` is typed on
the consumer side.

### AD-10: Drizzle v1 import paths

**Choice.** Target `drizzle-orm@1.x`. Import validators from `drizzle-orm/zod`, not the
standalone `drizzle-zod` package. Use `getColumns`, not the deprecated
`getTableColumns`. Use `defineRelations()` (RQBv2) for any relational reads.

**Reasoning.** Drizzle v1 consolidated the validator packages into the core package and
removed RQBv1. Writing against the old paths means a migration before you ship.

---

## 2. Package topology

```
packages/
  db/                  @repo/db
    src/schema/        table definitions        ← drizzle-orm/pg-core ONLY
    src/client.ts      drizzle instance, driver ← server only
    package.json       exports: "." (client), "./schema" (tables)

  entity/              @repo/entity
    src/define.ts      defineEntity()
    src/schemas.ts     zod derivation from tables
    src/filter.ts      filter spec → zod schema + types
    src/pagination.ts  cursor encode/decode, page schemas
    deps: zod, drizzle-orm (core only), @repo/db/schema

  contract/            @repo/contract
    src/crud.ts        crudContract()
    src/errors.ts      shared typed error definitions
    src/entities/*.ts  one file per entity's contract
    src/router.ts      the assembled app contract
    deps: @orpc/contract, zod, @repo/entity
    CLIENT-SAFE. No driver, no db client, no server code.

  crud-repo/           @repo/crud-repo
    src/repository.ts  crudRepository()
    src/where.ts       filter → SQL
    src/keyset.ts      cursor predicate builder
    src/errors.ts      pg error code mapping
    deps: drizzle-orm, @repo/entity, @repo/db

  crud-server/         @repo/crud-server
    src/implement.ts   implementCrud()
    src/context.ts     request context type + builder
    src/mount.ts       fastify mounting helper
    deps: @orpc/server, @orpc/openapi, @repo/contract, @repo/crud-repo

  api-client/          @repo/api-client
    src/index.ts       createClient()
    deps: @orpc/client, @repo/contract

apps/
  api/                 fastify app
  web/                 frontend
```

### 2.1 Dependency rules (enforced in CI)

| Package | May import | Must never import |
|---|---|---|
| `@repo/entity` | zod, `drizzle-orm/pg-core`, `@repo/db/schema` | `@repo/db` (client), any driver |
| `@repo/contract` | `@orpc/contract`, zod, `@repo/entity` | anything server-side |
| `@repo/crud-repo` | drizzle-orm, `@repo/db`, `@repo/entity` | `@orpc/*`, fastify |
| `@repo/crud-server` | `@orpc/server`, `@repo/contract`, `@repo/crud-repo` | — |
| `@repo/api-client` | `@orpc/client`, `@repo/contract` | `@repo/crud-repo`, `@repo/db` |

The `crud-repo` rule (no oRPC) is what keeps the repository usable from cron jobs, queue
workers, and tests without dragging HTTP concerns along.

---

## 3. Layer specifications

### 3.1 `@repo/entity` — the entity descriptor

One declaration per entity. Everything downstream derives from it.

```ts
import { users } from '@repo/db/schema'
import { defineEntity, PUBLIC } from '@repo/entity'

export const userEntity = defineEntity({
  table: users,
  name: 'user',            // used in contract keys and error messages
  path: 'users',           // URL segment: /users, /users/:id
  pk: 'id',

  // Field policy. Each produces a Zod schema.
  read:   { omit: ['passwordHash', 'internalNotes'] },
  create: {
    omit: ['id', 'createdAt', 'updatedAt', 'deletedAt'],
    refine: {
      email: (s) => s.email(),
      name:  (s) => s.min(1).max(200),
    },
  },
  update: {
    omit: ['id', 'createdAt', 'updatedAt', 'deletedAt', 'email'],
    // update schema is partial by default; opt out with { partial: false }
  },

  // Explicit allowlists (AD-3)
  filter: {
    eq:    ['status', 'orgId', 'role'],
    ilike: ['name', 'email'],
    range: ['createdAt'],
  },
  sort: ['createdAt', 'name'],
  defaultSort: { field: 'createdAt', dir: 'desc' },
  maxLimit: 100,
  defaultLimit: 25,

  // Required (AD-5)
  authorize: {
    list:   (ctx) => ctx.role === 'admin' || eq(users.orgId, ctx.orgId),
    byId:   (ctx) => eq(users.orgId, ctx.orgId),
    create: (ctx) => ctx.role === 'admin',
    update: (ctx, id) => ctx.role === 'admin' || ctx.userId === id,
    delete: (ctx) => ctx.role === 'admin',
  },
} as const)
```

`as const` is required. It is what preserves the literal types of `filter.eq`, `sort`, and
`omit` arrays through to the client's autocomplete. Enforce it with a type constraint that
rejects widened `string[]`.

#### Output shape

```ts
userEntity.schemas.read      // ZodObject matching the table minus omitted columns
userEntity.schemas.create    // insert schema minus omitted, plus refinements
userEntity.schemas.update    // partial update schema
userEntity.schemas.filter    // flat filter object, see §4.1
userEntity.schemas.listQuery // filter + sort + limit + cursor
userEntity.schemas.listResult// { items: read[], nextCursor: string | null }
userEntity.meta              // { name, path, pk, sort, defaultSort, maxLimit, ... }
```

#### Implementation notes

Derive schemas with `createSchemaFactory` from `drizzle-orm/zod`, called once at module
scope with your Zod instance, then `.omit()`:

```ts
import { createSchemaFactory } from 'drizzle-orm/zod'
import { z } from 'zod'

const { createSelectSchema, createInsertSchema, createUpdateSchema } =
  createSchemaFactory({ zodInstance: z })
```

`.omit()` takes a `Record<key, true>`, so convert the array with a small helper that
preserves literal keys:

```ts
const toOmitMask = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map(k => [k, true])) as { [P in K]: true }
```

Known issue: `createSchemaFactory` with a *wrapped* Zod instance (for example the one from
`@hono/zod-openapi`) has had `refine` callback parameters inferred as `any`, tripping
`noImplicitAny`. Use the plain `zod` instance. If you later need OpenAPI metadata, attach
it with `z.globalRegistry` rather than a wrapped Zod.

#### Validation performed by `defineEntity`

These run at module load and throw loudly. They are cheap and catch the mistakes that
otherwise surface in production.

1. Every key in `omit`, `filter.*`, and `sort` exists on the table (checked via
   `getColumns`). Both a type constraint and a runtime check, because the runtime one
   survives `as any` in a hurry.
2. `defaultSort.field` is in `sort`.
3. Every enabled operation has an `authorize` entry.
4. `pk` is a single column. Composite keys are unsupported in v1; fail explicitly rather
   than producing a broken route.
5. Warn (do not fail) if a `filter` field has no index. Requires a build-time check
   against the migration snapshot; ship this in a later milestone.

### 3.2 `@repo/crud-repo` — the repository layer

Pure data access. No HTTP knowledge. This is the layer that makes custom handlers cheap,
because a hand-written handler still gets scoping, pagination, and error mapping for free.

```ts
export const userRepo = crudRepository(db, userEntity, {
  scope: (ctx) => eq(users.orgId, ctx.orgId),
  softDelete: { column: 'deletedAt' },
  hooks: {
    beforeCreate: ({ input, ctx }) => ({ ...input, createdBy: ctx.userId }),
    afterUpdate:  async ({ result, ctx }) => bus.emit('user.updated', result),
  },
})
```

#### Interface

```ts
interface CrudRepository<E extends AnyEntity, Ctx> {
  list(query: ListQuery<E>, ctx: Ctx, tx?: Tx): Promise<ListResult<E>>
  byId(id: PkType<E>, ctx: Ctx, tx?: Tx): Promise<Read<E>>       // throws NotFound
  find(id: PkType<E>, ctx: Ctx, tx?: Tx): Promise<Read<E> | null> // does not throw
  create(input: Create<E>, ctx: Ctx, tx?: Tx): Promise<Read<E>>
  update(id: PkType<E>, patch: Update<E>, ctx: Ctx, tx?: Tx): Promise<Read<E>>
  delete(id: PkType<E>, ctx: Ctx, tx?: Tx): Promise<void>

  // Escape hatches for custom handlers
  scopedWhere(ctx: Ctx): SQL | undefined
  project<T>(row: T): Read<E>   // applies the read field policy
}
```

`find` alongside `byId` matters: custom handlers frequently need "does this exist" without
exception control flow.

#### Behavioral requirements

- **Scoping.** `scopedWhere(ctx)` is `AND`-ed into every statement including `update` and
  `delete` by PK. An update that matches zero rows is `NOT_FOUND`, never a silent no-op.
- **Projection.** Reads select only the columns in the read policy. Do not
  `SELECT *` and strip in JS; omitted columns must not leave the database. This matters
  for `passwordHash`.
- **Soft delete.** When configured, `delete` sets the column and every read adds
  `IS NULL`. `create` on a soft-deleted unique key surfaces as `CONFLICT`, not a
  confusing constraint error.
- **Hooks.** `before*` hooks transform input and may throw. `after*` hooks receive the
  result and run inside the transaction if one was passed, outside otherwise. Document
  this; it is a common source of "my event fired but the transaction rolled back".
- **Error mapping** (AD-9), applied uniformly:

  | Cause | Contract error |
  |---|---|
  | pg `23505` unique violation | `CONFLICT` with `{ constraint, columns }` |
  | pg `23503` FK violation | `BAD_REQUEST` with `{ constraint }` |
  | pg `23514` check violation | `BAD_REQUEST` |
  | pg `22P02` invalid text representation | `BAD_REQUEST` |
  | zero rows on `byId`/`update`/`delete` | `NOT_FOUND` |
  | `authorize` returns false | `FORBIDDEN` |

  Map by error code, never by message string.

#### Keyset pagination

The cursor encodes the sort key values plus the primary key, base64url-encoded JSON with a
version tag: `{ v: 1, s: [sortValue], pk: pkValue }`. Version it from day one so the
encoding can change without breaking clients holding old cursors.

The predicate uses a Postgres row-value comparison, which is both correct with ties and
index-friendly on a composite index `(sortCol, pk)`:

```ts
// sort: createdAt desc, tiebreak id desc
sql`(${table.createdAt}, ${table.id}) < (${cursor.s[0]}, ${cursor.pk})`
```

Fetch `limit + 1` rows; if you get `limit + 1`, drop the extra and emit a `nextCursor`
built from the last kept row. Never emit a cursor when there is no next page — clients
use `nextCursor === null` as the termination condition.

Requirements: the tiebreak PK must always be appended to `ORDER BY`, and the sort direction
must be identical for both components or the row-value comparison is wrong. Assert this in
the builder.

### 3.3 `@repo/contract` — the shared contract

```ts
import { crudContract } from '@repo/contract'
import { userEntity } from '@repo/entity/entities/user'

export const userContract = crudContract(userEntity)
// { list, byId, create, update, delete }
```

Route conventions:

| Operation | Method | Path | Input | Output |
|---|---|---|---|---|
| `list` | GET | `/users` | query params | `{ items, nextCursor }` |
| `byId` | GET | `/users/{id}` | path param | `read` |
| `create` | POST | `/users` | body | `read` (201) |
| `update` | PATCH | `/users/{id}` | path + body | `read` |
| `delete` | DELETE | `/users/{id}` | path param | `void` (204) |

`PATCH` not `PUT`, because the update schema is partial. If an entity needs full
replacement semantics, that is a custom route.

Subsetting and overriding:

```ts
// Only some operations
export const auditLogContract = crudContract(auditLogEntity, {
  only: ['list', 'byId'],
})

// Override one route's contract entirely
export const userContract = {
  ...crudContract(userEntity, { except: ['create'] }),
  create: oc
    .route({ method: 'POST', path: '/users', successStatus: 201 })
    .input(signupInput)                     // completely different shape
    .output(userEntity.schemas.read)
    .errors({ EMAIL_TAKEN: { data: z.object({ email: z.string() }) } }),
}
```

Because `crudContract` returns a plain object, both of these are ordinary JavaScript. No
special API is needed, which is the whole point of AD-2.

#### Shared errors

Define once, spread into every generated route so clients get consistent typed errors:

```ts
export const commonErrors = {
  NOT_FOUND:   { status: 404, data: z.object({ entity: z.string(), id: z.string() }) },
  CONFLICT:    { status: 409, data: z.object({ constraint: z.string().optional() }) },
  FORBIDDEN:   { status: 403 },
  BAD_REQUEST: { status: 400, data: z.object({ constraint: z.string().optional() }) },
} as const
```

### 3.4 `@repo/crud-server` — implementation binding

```ts
export const userRouter = implementCrud(userContract, userRepo, {
  // Override one handler, keep its contract
  create: async ({ input, context, repo }) =>
    db.transaction(async (tx) => {
      const user = await repo.create(input, context, tx)
      await orgRepo.addMember(user.id, context.orgId, tx)
      return user
    }),
})
```

The type that makes this safe:

```ts
type Generated<C> = { [K in keyof C]: C[K] extends CrudProcedure<any> ? K : never }[keyof C]
type Custom<C>    = Exclude<keyof C, Generated<C>>

function implementCrud<C extends AnyContract>(
  contract: C,
  repo: RepoFor<C>,
  impls:
    & { [K in Custom<C>]:  HandlerFor<C[K]> }    // REQUIRED
    & { [K in Generated<C>]?: HandlerFor<C[K]> } // optional override
): Router<C>
```

`crudContract` brands its output procedures so `Generated<C>` can recognize them. The
moment you replace `create` with a hand-written procedure, it loses the brand, moves into
`Custom<C>`, and becomes a required key. You cannot ship a contract without an
implementation, and you cannot ship an implementation whose input or output disagrees with
its contract.

Handler context passed to every implementation:

```ts
interface HandlerArgs<C, Ctx> {
  input:   InferInput<C>
  context: Ctx            // authenticated request context
  repo:    CrudRepository // the entity's repository, fully scoped
  errors:  TypedErrors    // errors.CONFLICT({ data: ... })
}
```

Mounting stays explicit — the generator never touches your Fastify instance:

```ts
import { OpenAPIHandler } from '@orpc/openapi/fastify'
import { CORSHandlerPlugin } from '@orpc/server/plugins'
import { onError } from '@orpc/server'

const handler = new OpenAPIHandler(appRouter, {
  plugins: [new CORSHandlerPlugin()],
  interceptors: [onError((e) => app.log.error(e))],
})

app.all('/api/*', async (req, reply) => {
  const { matched } = await handler.handle(req, reply, {
    prefix: '/api',
    context: buildContext(req),   // { userId, orgId, role }
  })
  return matched ? reply : reply.status(404).send({ message: 'Not found' })
})
```

Note the tradeoff: within `/api/*`, oRPC does the routing, so per-route Fastify hooks do
not apply. Authentication happens either in a Fastify `preHandler` on the catch-all (which
does run) or as oRPC middleware. Pick one and document it; splitting auth across both is
how you get inconsistencies.

### 3.5 `@repo/api-client` — the typed client

```ts
import { createORPCClient } from '@orpc/client'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import type { appContract } from '@repo/contract'

export const api = createORPCClient<typeof appContract>(
  new OpenAPILink(appContract, {
    url: `${BASE_URL}/api`,
    headers: () => ({ authorization: `Bearer ${getToken()}` }),
  })
)

// Fully typed, including filter keys:
const { items, nextCursor } = await api.user.list({
  status: 'active',
  name__ilike: 'ac',
  createdAt__gte: new Date('2026-01-01'),
  sort: '-createdAt',
  limit: 25,
})
```

The client imports the contract type only. `import type` plus the contract package's
client-safety rules (AD-8) keep the bundle clean.

---

## 4. Type-level reference

The two pieces that carry the most weight and are worth getting right before anything else
is built on top of them.

### 4.1 Filter shape

Flat keys with `__operator` suffixes. Flat because it survives querystring round-tripping
without a JSON blob, and because flat keys give better autocomplete than nested objects.

```ts
type FilterSpec<T extends Table> = {
  eq?:    readonly (keyof T['$inferSelect'] & string)[]
  ilike?: readonly (keyof T['$inferSelect'] & string)[]
  range?: readonly (keyof T['$inferSelect'] & string)[]
}

type FilterShape<T extends Table, F extends FilterSpec<T>> =
  & { [K in NonNullable<F['eq']>[number]]?: T['$inferSelect'][K] }
  & { [K in NonNullable<F['eq']>[number] as `${K}__in`]?: Array<T['$inferSelect'][K]> }
  & { [K in NonNullable<F['eq']>[number] as `${K}__ne`]?: T['$inferSelect'][K] }
  & { [K in NonNullable<F['ilike']>[number] as `${K}__ilike`]?: string }
  & { [K in NonNullable<F['range']>[number] as `${K}__gte`]?: T['$inferSelect'][K] }
  & { [K in NonNullable<F['range']>[number] as `${K}__lte`]?: T['$inferSelect'][K] }
```

Runtime counterpart builds the matching `ZodObject` by iterating the same spec, reading
each column's type from `getColumns(table)` and reusing the per-column schema that
`createSelectSchema` already produced (so an enum column produces `z.enum`, not
`z.string`). Values arriving as querystrings need coercion; use `z.coerce` for numbers,
dates, and booleans, and comma-splitting for `__in`.

The `where` builder walks the parsed filter object, splits each key on `__`, and dispatches
to the Drizzle operator. Reject unknown keys rather than ignoring them — a client typo
that silently returns unfiltered rows is worse than a 400.

Write the type and the runtime builder in the same file and add a type-level test
asserting they agree. They will drift otherwise.

### 4.2 The generated/custom split

```ts
declare const CRUD_BRAND: unique symbol

interface CrudProcedure<Op extends CrudOp> {
  readonly [CRUD_BRAND]: Op
}
```

`crudContract` attaches the brand. `implementCrud` uses it to partition contract keys into
optional (generated, have a default implementation) and required (custom, must be
supplied). Use a `unique symbol` rather than a string literal property so nothing
accidentally satisfies it.

Add type-level tests for the three cases: all generated (impls fully optional), one
replaced (that key required), one added (that key required and typed from its own
contract).

---

## 5. Wire format

### 5.1 List query parameters

```
GET /users
  ?status=active                    # eq
  &status__in=active,invited        # in
  &name__ilike=ac                   # ilike, wrapped in % server-side
  &createdAt__gte=2026-01-01
  &sort=-createdAt                  # leading '-' = desc
  &limit=25
  &cursor=eyJ2IjoxLCJzIjpb...
```

Sort is a single field. Multi-field sort requires a composite index to be non-terrible; if
an entity needs it, declare the allowed combinations explicitly rather than accepting
arbitrary sort lists.

### 5.2 Response envelopes

```jsonc
// list
{ "items": [ /* ... */ ], "nextCursor": "eyJ2..." | null }

// single: the object, unwrapped
{ "id": "...", "name": "..." }
```

Lists get an envelope because they need pagination metadata. Single resources do not,
because wrapping them adds a `.data` to every client call site for no benefit. Be
consistent about the asymmetry rather than eliminating it.

### 5.3 Error body

```jsonc
{
  "code": "CONFLICT",
  "message": "A user with this email already exists",
  "data": { "constraint": "users_email_unique" }
}
```

`code` is the stable, machine-readable contract. `message` is for humans and may change.
Clients branch on `code`.

---

## 6. Implementation plan

Nine milestones. Each has concrete steps and an acceptance criterion. Do not start a
milestone before its predecessor's criterion passes — the ordering exists because each
milestone's design decisions are informed by the previous one's real usage.

### M0 — Foundations (½ day)

1. Create the six packages with `package.json`, `tsconfig.json`, and build config matching
   your existing monorepo conventions.
2. Split `@repo/db` into two exports: `.` (client) and `./schema` (tables). Move any
   driver import out of the schema modules.
3. Pin versions: `drizzle-orm@^1`, `zod@^4`, `fastify@^5`, `@orpc/*` at one consistent
   minor.
4. Add the ESLint `no-restricted-imports` rules from §2.1.
5. Set up type-level testing (`expect-type` or `tsd`) and a `test:types` script.
6. Set up integration testing against PGlite or Testcontainers. PGlite is faster for unit
   scope; Testcontainers is more faithful. Use PGlite for repository tests and one
   Testcontainers suite for the end-to-end path.

**Acceptance:** `import { users } from '@repo/db/schema'` in a browser-targeted build
produces a bundle containing no driver code. Verify with a bundle analyzer, then encode it
as a CI size assertion.

### M1 — Hand-write two endpoints first (½ day)

Before building any generator, hand-write list and create for two entities that differ
meaningfully — one simple, one with a quirk (soft delete, a computed field, an unusual
authorization rule).

**Reasoning.** Building the generator first means guessing at the shape of the thing you
are generalizing, and the guess is always wrong in the direction of too much magic. These
hand-written endpoints become the reference the generated output must match, and the first
integration tests.

**Acceptance:** both endpoints work end to end with real authorization and pagination.
Keep the code; it is the specification for M3 and M4.

### M2 — `@repo/entity` (2 days)

1. `toOmitMask` helper and the `createSchemaFactory` setup.
2. `defineEntity` signature and the `as const` enforcement constraint.
3. Derive `read`, `create`, `update` schemas from the field policy.
4. Filter types and the runtime filter schema builder (§4.1).
5. Pagination schemas: cursor codec, `listQuery`, `listResult`.
6. Runtime validations from §3.1.
7. Type-level tests: `z.infer<schemas.read>` matches `$inferSelect` minus omissions;
   omitted keys are absent from the type, not just optional; filter keys are exactly the
   spec's keys.

**Acceptance:** `defineEntity` on the two M1 entities produces schemas that accept and
reject the same payloads as the hand-written validation, verified by shared test cases.

### M3 — `@repo/crud-repo` (3 days)

1. `crudRepository` skeleton with the full method surface, `tx` parameter on every method
   from the start (AD-7).
2. Column projection from the read policy.
3. `scopedWhere` and its merging into all six methods, including PK writes.
4. Filter-to-SQL builder with unknown-key rejection.
5. Keyset pagination: row-value predicate, `limit + 1` fetch, cursor emission.
6. Offset pagination as the opt-in alternative.
7. Soft delete.
8. Hooks with documented transaction semantics.
9. Postgres error code mapping (§3.2).

Integration tests (PGlite) that must pass:

- List returns exactly `limit` items and a cursor when more exist, and `null` when not.
- Paging through 1000 rows with concurrent inserts yields no duplicates and no skips.
- Ties on the sort column paginate correctly (this is what the row-value comparison is
  for; test it explicitly with many identical timestamps).
- `update` with a foreign tenant's id returns `NOT_FOUND`, not success and not a leak.
- `delete` with a foreign tenant's id returns `NOT_FOUND`.
- Omitted columns never appear in a result object and never appear in the generated SQL.
- Unique violation surfaces as `CONFLICT` with the constraint name.
- A hook throwing inside a transaction rolls back the write.

**Acceptance:** the M1 hand-written endpoints are rewritten to call the repository and all
their tests still pass, with less code.

### M4 — `@repo/contract` (2 days)

1. `commonErrors`.
2. `crudContract` producing the five branded procedures per §3.3.
3. `only` / `except` options.
4. `CrudProcedure` brand and `Generated`/`Custom` types (§4.2).
5. Assemble the app contract from per-entity contracts.
6. Type-level tests for the three override cases.

**Acceptance:** overriding a route by object spread type-checks, and the branded/unbranded
partition behaves as specified in the type tests.

### M5 — `@repo/crud-server` (2 days)

1. `implementCrud` with the required/optional impls type.
2. Default implementations for the five operations, delegating to the repository.
3. Authorization enforcement wired in front of every handler, including overridden ones.
   Do not let an override bypass `authorize`.
4. Context builder and the Fastify mount helper.
5. oRPC error interceptor mapping repository errors to typed contract errors.

**Acceptance:** the two M1 entities are fully generated, their hand-written route files are
deleted, and the original end-to-end tests pass unchanged. This is the milestone that
proves the whole design.

### M6 — Composability proof (1 day)

Do not skip this. It is the acceptance test for goal 3.

Take a real entity and exercise all three escape hatches:

1. A hook that stamps `createdBy`.
2. A handler override where `create` wraps two repository calls in one transaction.
3. A contract override where `create` takes a completely different input shape
   (`signupInput`) and returns a typed `EMAIL_TAKEN` error.

Then verify the negative cases actually fail to compile:

- Removing the implementation for the overridden `create` → compile error.
- Returning the wrong shape from an override → compile error.
- Omitting an `authorize` entry → compile error.

**Acceptance:** all three overrides work; all three negative cases fail the build. If any
override required editing generator source, the design has failed and you fix it here, not
after twenty entities depend on it.

### M7 — Migrate the existing endpoints (2–4 days, parallelizable)

1. Order entities easiest-first to build confidence and surface gaps early.
2. One PR per entity. Each PR deletes at least as much as it adds.
3. Keep a running list of every entity that needed an escape hatch and which one. If more
   than a third need handler overrides, the default operations are wrong and you should
   revisit §3.2 before continuing.
4. Contract-diff test: for each migrated entity, assert the generated OpenAPI paths match
   the previous hand-written routes, so consumers see no breaking change.

**Acceptance:** all migrated endpoints pass their pre-existing tests with no client-side
changes.

### M8 — Client and DX (1 day)

1. `@repo/api-client` with `createORPCClient` and the OpenAPI link.
2. TanStack Query bindings via `@orpc/tanstack-query` if the frontend uses it.
3. Generate and serve the OpenAPI document from the contract; wire up a docs UI.
4. Bundle-size CI assertion (AD-8).

**Acceptance:** a frontend developer gets autocomplete on filter keys for a new entity
within seconds of it being added, with no build step run manually.

### M9 — Hardening (ongoing)

1. Build-time index check: warn when a `filter` or `sort` field has no supporting index,
   by reading the drizzle-kit migration snapshot.
2. Per-entity rate limits on `list`.
3. Structured logging of the generated SQL for slow list queries.
4. A `PUBLIC` audit script that lists every operation whose `authorize` is `PUBLIC`, run in
   CI and diffed so newly-public endpoints require an explicit approval.
5. Composite primary key support, if it turns out to be needed.

---

## 7. Testing strategy

| Layer | Type | Tool | What it proves |
|---|---|---|---|
| `@repo/entity` | Type-level | `expect-type` | Schemas match table types; omissions are absent, not optional |
| `@repo/entity` | Unit | vitest | Filter schema accepts/rejects the right querystrings |
| `@repo/crud-repo` | Integration | PGlite | Pagination correctness, scoping, projection, error mapping |
| `@repo/contract` | Type-level | `expect-type` | Brand partition; override cases |
| `@repo/crud-server` | Type-level | `tsd` negative tests | Missing/mismatched impls fail to compile |
| `@repo/crud-server` | E2E | Testcontainers + inject | Full HTTP round trip per operation |
| Client | Type-level | `expect-type` | Filter key autocomplete; response types |
| Cross-cutting | CI assertion | bundle analyzer | No driver in the client bundle |

The negative compile tests deserve emphasis. The design's core safety property is "you
cannot ship a mismatched contract", and a property that is not tested is not a property.

Additionally, one adversarial test suite that a security-minded reviewer would write:

- Every generated endpoint, called with a valid token from tenant B against a tenant A
  resource, returns 404 or 403 and never a body.
- Every generated endpoint, called with no token, returns 401 unless explicitly `PUBLIC`.
- `list` with `limit=100000` is clamped to `maxLimit`.
- Omitted columns do not appear in any response, including error payloads.

---

## 8. Risks and tripwires

| Risk | Signal | Mitigation |
|---|---|---|
| Generator accretes options until it is a framework | The options object exceeds ~15 keys | Every new option needs two real entities that need it. Otherwise it is a handler override. |
| Escape hatches used everywhere | More than a third of entities override a handler | The defaults are wrong. Stop and redesign §3.2 defaults. |
| Client bundle grows quietly | Bundle size creeps between releases | CI size assertion with a hard ceiling |
| oRPC breaking changes | Major version bump | Contract layer is one package (AD-1 exit plan). Pin exact versions; upgrade deliberately. |
| Drizzle v1 API drift | RC-era APIs change | Pin exact `drizzle-orm` version; treat upgrades as scheduled work |
| Type inference gets slow | Editor lag, `tsc` time climbing | Measure with `tsc --extendedDiagnostics` at M4 and M7. Cap generic recursion depth; prefer interfaces over deeply nested conditional types. |
| Someone auto-mounts every table | A PR that iterates the schema object | Explicitly a non-goal (§0.3). Add it to the PR template's review checklist. |

The inference-cost risk is real and under-appreciated. Filter shapes built from mapped
types with template literal keys multiply quickly across many entities. Take a baseline
`tsc` timing at M4 and re-measure at M7; if it has more than doubled, simplify the filter
types before migrating more entities.

---

## 9. Estimated effort

| Milestone | Effort |
|---|---|
| M0 Foundations | 0.5 day |
| M1 Hand-written reference | 0.5 day |
| M2 `@repo/entity` | 2 days |
| M3 `@repo/crud-repo` | 3 days |
| M4 `@repo/contract` | 2 days |
| M5 `@repo/crud-server` | 2 days |
| M6 Composability proof | 1 day |
| M7 Migration | 2–4 days |
| M8 Client and DX | 1 day |
| **Total to production** | **~14–16 days** |

M9 is ongoing and not on the critical path.

---

## Appendix A: file tree

```
packages/
  db/
    src/schema/index.ts        re-exports all tables
    src/schema/users.ts
    src/client.ts
    package.json               exports: { ".": client, "./schema": tables }

  entity/
    src/define.ts              defineEntity
    src/schemas.ts             read/create/update derivation
    src/filter.ts              FilterShape type + zod builder + where spec
    src/pagination.ts          cursor codec, listQuery, listResult
    src/validate.ts            load-time runtime checks
    src/types.ts               AnyEntity, Read<E>, Create<E>, PkType<E>
    src/entities/user.ts       userEntity
    test/types.test-d.ts

  contract/
    src/crud.ts                crudContract, CrudProcedure brand
    src/errors.ts              commonErrors
    src/split.ts               Generated<C> / Custom<C>
    src/entities/user.ts       userContract
    src/router.ts              appContract
    test/split.test-d.ts

  crud-repo/
    src/repository.ts          crudRepository
    src/where.ts               filter → SQL
    src/keyset.ts              cursor predicate + emission
    src/project.ts             column projection
    src/errors.ts              pg code mapping
    test/pagination.test.ts
    test/scoping.test.ts

  crud-server/
    src/implement.ts           implementCrud
    src/defaults.ts            the five default handlers
    src/authorize.ts           enforcement wrapper
    src/context.ts
    src/mount.ts
    test/implement.test-d.ts   negative compile tests

  api-client/
    src/index.ts
```

## Appendix B: adding a new entity, after the toolkit exists

```ts
// 1. packages/entity/src/entities/invoice.ts
export const invoiceEntity = defineEntity({ table: invoices, /* ... */ } as const)

// 2. packages/contract/src/entities/invoice.ts
export const invoiceContract = crudContract(invoiceEntity)

// 3. packages/contract/src/router.ts — add one line
export const appContract = { user: userContract, invoice: invoiceContract }

// 4. apps/api/src/routers/invoice.ts
export const invoiceRouter = implementCrud(invoiceContract, invoiceRepo, {})

// 5. apps/api/src/router.ts — add one line
```

Five small edits, four of them one-liners. If adding an entity ever requires more than
this, that is the signal to revisit the design.