import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../../lib/i18n'

// Guards English coverage found missing during an i18n audit: the
// setError() literals on this page were never routed through t(), so
// English users silently saw raw Japanese even though a translation
// already existed in the dictionary. Every t(...) literal here must
// resolve to a defined English string.

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'page.tsx'), 'utf8')

const JP = /[぀-ヿ一-鿿]/

function tKeys(src: string): string[] {
  const single = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) =>
    m[1].replace(/\\(.)/g, '$1'),
  )
  const double = [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\(.)/g, '$1'),
  )
  const backtick = [...src.matchAll(/\bt\(\s*`([^`]*)`/g)].map((m) => m[1])
  return [...single, ...double, ...backtick]
}

describe('/inflow-links/detail English coverage', () => {
  it('translates every t(...) literal in the source', () => {
    const keys = tKeys(source).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThanOrEqual(5)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })
})
