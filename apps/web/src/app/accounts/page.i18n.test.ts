import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../lib/i18n'
import { COUNTRY_OPTIONS } from '../../lib/country-flag'

// Guards the English support added for /accounts (MIN-279): every Japanese
// literal the page, its account child components, and the shared CC-prompt
// surfaces hand to t() must resolve to a defined English string — otherwise
// English users silently fall back to Japanese. Covers the backtick t(`...`)
// prompt bodies and the dynamic country options fed through t(c) too.

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(here, rel), 'utf8')

const sources: Record<string, string> = {
  'page.tsx': read('page.tsx'),
  'account-form-fields.tsx': read('../../components/accounts/account-form-fields.tsx'),
  'account-edit-modal.tsx': read('../../components/accounts/account-edit-modal.tsx'),
  'account-settings-section.tsx': read('../../components/accounts/account-settings-section.tsx'),
  'account-setup-urls.tsx': read('../../components/accounts/account-setup-urls.tsx'),
  'link-base-url-setting.tsx': read('../../components/accounts/link-base-url-setting.tsx'),
  'openai-connection-setting.tsx': read('../../components/accounts/openai-connection-setting.tsx'),
  'reorder-mode.tsx': read('../../components/accounts/reorder-mode.tsx'),
  'test-recipients-setting.tsx': read('../../components/accounts/test-recipients-setting.tsx'),
  'cc-prompt-button.tsx': read('../../components/cc-prompt-button.tsx'),
  'prompt-modal.tsx': read('../../components/prompt-modal.tsx'),
}

const JP = /[぀-ヿ一-鿿]/

// t('...') / t("...") / t(`...`) — quote/double/backtick literals passed to t().
function tKeys(source: string): string[] {
  const single = [...source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) =>
    m[1].replace(/\\'/g, "'"),
  )
  const double = [...source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\"/g, '"'),
  )
  const backtick = [...source.matchAll(/\bt\(\s*`([^`]*)`/g)].map((m) => m[1])
  return [...single, ...double, ...backtick]
}

describe('/accounts English coverage', () => {
  for (const [name, source] of Object.entries(sources)) {
    it(`translates every t(...) literal in ${name}`, () => {
      const keys = tKeys(source).filter((k) => JP.test(k))
      expect(keys.filter((k) => !(k in en))).toEqual([])
    })
  }

  it('wraps at least the known account strings (sanity: strings actually wrapped)', () => {
    const all = Object.values(sources).flatMap(tKeys).filter((k) => JP.test(k))
    expect(all.length).toBeGreaterThan(20)
  })

  it('translates every country option rendered via t(c)', () => {
    const jp = COUNTRY_OPTIONS.filter((c) => JP.test(c))
    expect(jp.length).toBeGreaterThan(0)
    expect(jp.filter((c) => !(c in en))).toEqual([])
  })
})
