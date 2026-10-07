// Table definitions only. This module (and everything it imports) must stay
// importable without a database driver — see AD-8. drizzle-orm/pg-core only.
export { users } from './users'
export { posts } from './posts'
