import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../lib/i18n'

// Guards English coverage found missing during an i18n audit: this file's
// t(...) literals (including CC-prompt title/prompt bodies and helper
// functions that take t as a parameter) must all resolve to a defined
// English string, otherwise English users silently fall back to Japanese.

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'flex-preview.tsx'), 'utf8')

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

describe('flex-preview English coverage', () => {
  it('translates every t(...) literal in the source', () => {
    const keys = tKeys(source).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThanOrEqual(1)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })
})
