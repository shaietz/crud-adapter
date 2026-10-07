import { describe, expect, it } from 'vitest'
import { userEntity } from '../src/entities/user'
import { decodeCursor, encodeCursor, CursorError } from '../src/pagination'

const listQuery = userEntity.schemas.listQuery

const parse = (q: Record<string, unknown>) => listQuery.safeParse(q)

describe('list query schema (filter + sort + limit)', () => {
  it('accepts allowlisted eq filters with enum narrowing', () => {
    const r = parse({ status: 'active' })
    expect(r.success).toBe(true)
  })

  it('rejects values outside the enum', () => {
    expect(parse({ status: 'bogus' }).success).toBe(false)
  })

  it('rejects unknown filter keys instead of ignoring them', () => {
    expect(parse({ nope: '1' }).success).toBe(false)
    // A field not in the allowlist is unknown too, even if it is a column.
    expect(parse({ passwordHash: 'x' }).success).toBe(false)
  })

  it('coerces __in from a comma-separated querystring', () => {
    const r = parse({ status__in: 'active,invited' })
    expect(r.success).toBe(true)
    expect((r as { data: Record<string, unknown> }).data.status__in).toEqual(['active', 'invited'])
  })

  it('coerces range filters on date columns to Date', () => {
    const r = parse({ createdAt__gte: '2026-01-01' })
    expect(r.success).toBe(true)
    expect((r as { data: Record<string, unknown> }).data.createdAt__gte).toBeInstanceOf(Date)
  })

  it('accepts ilike only on ilike-allowlisted fields', () => {
    expect(parse({ name__ilike: 'ac' }).success).toBe(true)
    expect(parse({ status__ilike: 'ac' }).success).toBe(false)
  })

  it('clamps limit to maxLimit rather than rejecting', () => {
    const r = parse({ limit: '100000' })
    expect(r.success).toBe(true)
    expect((r as { data: Record<string, unknown> }).data.limit).toBe(100)
  })

  it('defaults limit and sort', () => {
    const r = parse({})
    expect(r.success).toBe(true)
    const data = (r as { data: Record<string, unknown> }).data
    expect(data.limit).toBe(25)
    expect(data.sort).toBe('-createdAt')
  })

  it('accepts only allowlisted sort fields, with leading - for desc', () => {
    expect(parse({ sort: '-createdAt' }).success).toBe(true)
    expect(parse({ sort: 'name' }).success).toBe(true)
    expect(parse({ sort: 'email' }).success).toBe(false)
  })
})

describe('cursor codec', () => {
  it('round-trips a payload', () => {
    const cursor = encodeCursor({ v: 1, s: ['2026-01-01T00:00:00.000Z'], pk: 'abc' })
    expect(decodeCursor(cursor)).toEqual({ v: 1, s: ['2026-01-01T00:00:00.000Z'], pk: 'abc' })
  })

  it('rejects malformed and wrong-version cursors', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow(CursorError)
    expect(() => decodeCursor(encodeCursor({ v: 2 as never, s: [], pk: 1 }))).toThrow(CursorError)
  })
})
