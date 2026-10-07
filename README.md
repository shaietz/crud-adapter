# Typed CRUD Toolkit

One declaration per Drizzle entity produces validated, paginated, tenant-scoped CRUD
endpoints with a fully typed client and no codegen step.

Fastify 5 · Drizzle ORM v1 (rc) · Zod 4 · PGlite (embedded Postgres, no Docker needed)

> Implements [spec.md](spec.md), with one deliberate divergence: **the oRPC contract layer
> was removed.** See [Divergence from the spec](#divergence-from-the-spec).

## Quick start

```sh
pnpm install
pnpm example        # boots the API on an ephemeral port and runs the full
                    # typed-client flow over real HTTP (apps/web/src/example.ts)
pnpm api            # long-running dev server on :3000

pnpm test           # unit + PGlite integration + HTTP e2e (51 tests)
pnpm test:types     # type-level tests incl. negative compile cases (tsc)
pnpm lint           # dependency rules (no-restricted-imports)
pnpm check:bundle   # AD-8: browser bundle contains no driver code
```

## Packages

| Package | Role |
|---|---|
| `@repo/db` | Tables (`@repo/db/schema`, driver-free) + PGlite client (`@repo/db`) |
| `@repo/entity` | `defineEntity`: field policies → Zod schemas, filter/sort allowlists, cursor codec. Also `@repo/entity/client`, the typed fetch client. |
| `@repo/crud-repo` | `crudRepository`: scoping, projection, keyset pagination, soft delete, hooks, pg error mapping |
| `@repo/crud-http` | `crudRoutes`: registers Fastify routes from entity + repo, with authorization in front of every handler |

Total owned code: **~1,340 lines** (comments/blanks stripped). Third-party dependencies
across the whole toolkit: **`drizzle-orm`, `zod`, `fastify`**.

## Adding an entity

```ts
// 1. packages/entity/src/entities/invoice.ts
export const invoiceEntity = defineEntity({
  table: invoices, name: 'invoice', path: 'invoices', pk: 'id',
  filter: { eq: ['status'] }, sort: ['createdAt'],
  defaultSort: { field: 'createdAt', dir: 'desc' },
  authorize: { list: …, byId: …, create: …, update: …, delete: … },  // required, no default
} as const)

// 2. apps/api/src/routers/invoice.ts
crudRoutes(app, invoiceEntity, invoiceRepo, { prefix: '/api', context: buildContext })

// 3. apps/api/src/app.ts — one line to register it
```

## The three escape hatches

All exercised in the running example.

1. **Hook** — `crudRepository(db, e, { hooks: { beforeCreate } })` stamps `createdBy`/`orgId`
   ([repos.ts](apps/api/src/repos.ts)).
2. **Handler override** — `override: { list: myHandler }` keeps the generated input/output
   shapes and swaps the implementation.
3. **Route replacement** — `custom: { create: customRoute(...) }` replaces the input schema
   *and* the handler, and can declare extra typed errors. The user router's signup takes a
   different shape, wraps two repository calls in one transaction, and returns a typed
   `EMAIL_TAKEN` ([routers/user.ts](apps/api/src/routers/user.ts)).

There is deliberately no separate `except` list: **declaring a route in `custom` is what
replaces the generated one**, so a route can never lose its implementation. Negative compile
tests in [routes.test-d.ts](packages/crud-http/test/routes.test-d.ts) verify the remaining
failure modes (wrong return shape, missing `authorize`, unknown filter column) are all build
errors.

## Client bundle discipline (AD-8)

The client is **1KB**. That is not automatic — it required two rules, both enforced:

- Import the client from `@repo/entity/client`, never the package barrel. The barrel
  re-exports `defineEntity` and drags `drizzle-orm/zod` + Zod in (~440KB measured).
- Import entities with `import type`. Importing an entity *value* pulls the eagerly-built
  Zod schemas (~475KB measured); the client takes the URL path as a string instead, and an
  e2e test asserts it matches `entity.meta.path`.

`pnpm check:bundle` fails the build on either mistake.

## Design notes

- **Keyset pagination** uses a Postgres row-value comparison `(sortCol, pk) < (v, pkV)` with
  the PK always appended to ORDER BY in the same direction — correct under ties and
  concurrent inserts (tested with 1000 rows + mid-walk inserts).
- **Authorization rules** may return `boolean` *or* a Drizzle `SQL` fragment; a fragment is
  attached to the request context and ANDed into `scopedWhere`, so custom handlers inherit
  it by calling the repository.
- **Scoping applies to writes**: `PATCH /users/:id` with another tenant's id is `NOT_FOUND`.
- **Omitted columns never leave the database**: reads select only read-policy columns.
- **Unknown filter keys are a 400**, not silently ignored; `limit` is clamped to `maxLimit`.
- **Error mapping happens once** in the repository (pg codes → `CONFLICT`/`BAD_REQUEST`/…)
  and reaches the client as a stable `code` for branching.

## Divergence from the spec

The spec's AD-1 rents the contract and client layer from oRPC. That was implemented, worked,
and was then removed, because three facts about this codebase changed the calculus:

- **The frontend is in the same repo and shares types**, so a serialized contract format
  buys nothing that `import type` does not.
- **The team has mixed TypeScript depth**, and the `Generated`/`Custom` brand partition
  (§4.2) is hard to debug when inference breaks — which it did during the build, forcing an
  explicit `FullCrudContract<E>` declaration.
- **The client bundle was 502KB.** Removing oRPC and fixing the import discipline took it
  to 1KB.

A prior-art survey was run before rebuilding rather than adopting: Drizzle has **no**
built-in filter/sort/pagination layer ([issue #3712](https://github.com/drizzle-team/drizzle-orm/issues/3712));
[`drizzle-crud`](https://www.saas-js.com/docs/drizzle-crud) covers ~70% but is offset-paginated
and self-described early preview; [`drizzle-cursor`](https://github.com/xantiagoma/drizzle-cursor)
is healthy but would swap our best-tested 74 lines for an untested integration. Keeping
`keyset.ts` was a deliberate call.

If OpenAPI or an external consumer is ever needed, re-adding a contract layer is confined to
one new package — `@repo/entity` and `@repo/crud-repo` have zero HTTP coupling.

## Version pins

`drizzle-orm@1.0.0-rc.4` (v1 API: `drizzle-orm/zod`, `getColumns`), `zod@^4`, `fastify@^5`.
Pinned exactly per §8 — upgrades are scheduled work.
