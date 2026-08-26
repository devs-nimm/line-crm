import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from './i18n'

// Repo-wide English coverage guard.
//
// The per-page *.i18n.test.ts files each cover one source file, so a page with
// no guard of its own (15 of the 41 admin pages when this was added) could ship
// a t('日本語') literal with no `en` entry and silently render Japanese to
// English users. This walks every source file under apps/web/src instead, so
// new pages are covered the moment they are created.

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..')

const JP = /[぀-ヿ一-鿿]/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

// Mirrors the extraction used by the per-page guards: only literal t(...)
// arguments are checkable, since t(someVariable) resolves at runtime.
function tKeys(src: string): string[] {
  const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/\\(.)/g, '$1')
  const single = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]))
  const double = [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => unescape(m[1]))
  const backtick = [...src.matchAll(/\bt\(\s*`([^`$]*)`/g)].map((m) => m[1])
  return [...single, ...double, ...backtick]
}

describe('admin dashboard English coverage', () => {
  it('translates every literal t(...) key in apps/web/src', () => {
    const missing: string[] = []
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith(join('lib', 'i18n.tsx'))) continue
      for (const key of tKeys(readFileSync(file, 'utf8'))) {
        if (JP.test(key) && !(key in en)) {
          missing.push(`${relative(SRC, file)}: ${JSON.stringify(key)}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
