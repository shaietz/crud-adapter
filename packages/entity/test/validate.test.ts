import { describe, expect, it } from 'vitest'
import { users } from '@repo/db/schema'
import { defineEntity } from '../src/define'
import { PUBLIC } from '../src/types'

const base = {
  table: users,
  name: 'user',
  path: 'users',
  pk: 'id',
  filter: { eq: ['status'] },
  sort: ['createdAt'],
  defaultSort: { field: 'createdAt', dir: 'desc' },
  authorize: {
    list: PUBLIC,
    byId: PUBLIC,
    create: PUBLIC,
    update: PUBLIC,
    delete: PUBLIC,
  },
} as const

describe('defineEntity load-time validation', () => {
  it('accepts a valid config', () => {
    expect(() => defineEntity(base)).not.toThrow()
  })

  it('rejects unknown columns in omit / filter / sort (even through as any)', () => {
    expect(() =>
      defineEntity({ ...base, read: { omit: ['nope'] } } as never),
    ).toThrow(/read\.omit references unknown column "nope"/)
    expect(() =>
      defineEntity({ ...base, filter: { eq: ['nope'] } } as never),
    ).toThrow(/filter\.eq references unknown column "nope"/)
    expect(() => defineEntity({ ...base, sort: ['nope'] } as never)).toThrow(
      /sort references unknown column "nope"/,
    )
  })

  it('rejects defaultSort outside sort', () => {
    expect(() =>
      defineEntity({ ...base, defaultSort: { field: 'name', dir: 'asc' } } as never),
    ).toThrow(/defaultSort\.field "name" is not in sort/)
  })

  it('rejects a missing authorize entry', () => {
    const { delete: _omitted, ...partial } = base.authorize
    expect(() => defineEntity({ ...base, authorize: partial } as never)).toThrow(
      /authorize\.delete is missing/,
    )
  })

  it('rejects a pk that is not a column', () => {
    expect(() => defineEntity({ ...base, pk: 'nope' } as never)).toThrow(
      /pk "nope" is not a column/,
    )
  })
})
