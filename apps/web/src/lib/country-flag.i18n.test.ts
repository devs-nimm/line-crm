import { describe, expect, it } from 'vitest'
import { en } from './i18n'

// Guards the Japanese country names in FLAG_MAP: account.country can hold any
// of them (not just the COUNTRY_OPTIONS dropdown values), and several call
// sites render it through t(country) (e.g. events/bookings/page.tsx). A name
// missing from `en` would silently render Japanese to English users.

const here = new URL('./country-flag.ts', import.meta.url)
const source = await import('node:fs').then((fs) => fs.readFileSync(here, 'utf8'))

const JP = /[぀-ヿ一-鿿]/

describe('country-flag Japanese name coverage', () => {
  it('translates every Japanese country name in FLAG_MAP', () => {
    const jpBlock = source.split('// Japanese names')[1].split('// English names')[0]
    const names = [...jpBlock.matchAll(/'([^']*)':/g)].map((m) => m[1]).filter((s) => JP.test(s))
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => !(n in en))).toEqual([])
  })
})
