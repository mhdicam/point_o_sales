import { describe, it, expect } from 'vitest'
import {
  defaultFeaturesFor,
  validateFeatureFlags,
  normalizeFeatureFlags,
  FEATURE_KEYS,
  PRESET_DEFAULTS,
} from './features.js'

describe('preset defaults — design §9.1 matrix', () => {
  it('turns on tables, kds, and recipe for F&B', () => {
    const f = defaultFeaturesFor('FNB')
    expect(f.tables).toBe(true)
    expect(f.kds).toBe(true)
    expect(f.recipe).toBe(true)
    expect(f.serviceScheduling).toBe(false)
  })

  it('keeps retail free of tables, kds, and recipe', () => {
    const f = defaultFeaturesFor('RETAIL')
    expect(f.tables).toBe(false)
    expect(f.kds).toBe(false)
    expect(f.recipe).toBe(false)
    expect(f.barcode).toBe(true)
  })

  it('gives service scheduling and reservation to the SERVICE preset', () => {
    const f = defaultFeaturesFor('SERVICE')
    expect(f.serviceScheduling).toBe(true)
    expect(f.reservation).toBe(true)
    expect(f.tables).toBe(false)
  })

  it('defines every flag for every preset', () => {
    for (const preset of Object.keys(PRESET_DEFAULTS) as (keyof typeof PRESET_DEFAULTS)[]) {
      for (const key of FEATURE_KEYS) {
        expect(typeof PRESET_DEFAULTS[preset][key]).toBe('boolean')
      }
    }
  })

  it('returns a fresh object so callers cannot mutate the preset', () => {
    const a = defaultFeaturesFor('FNB')
    a.tables = false
    expect(defaultFeaturesFor('FNB').tables).toBe(true)
  })

  it('leaves every preset internally consistent', () => {
    for (const preset of Object.keys(PRESET_DEFAULTS) as (keyof typeof PRESET_DEFAULTS)[]) {
      expect(validateFeatureFlags(defaultFeaturesFor(preset))).toEqual([])
    }
  })
})

describe('feature dependencies — design §9.1', () => {
  it('rejects qrOrder without tables', () => {
    const flags = { ...defaultFeaturesFor('RETAIL'), qrOrder: true }
    expect(validateFeatureFlags(flags)).toEqual([{ feature: 'qrOrder', requires: 'tables' }])
  })

  it('rejects onlineOrder without landingPage', () => {
    const flags = { ...defaultFeaturesFor('RETAIL'), onlineOrder: true }
    expect(validateFeatureFlags(flags)).toEqual([
      { feature: 'onlineOrder', requires: 'landingPage' },
    ])
  })

  it('accepts qrOrder once tables is on', () => {
    const flags = { ...defaultFeaturesFor('FNB'), qrOrder: true }
    expect(validateFeatureFlags(flags)).toEqual([])
  })

  it('reports every unmet dependency at once', () => {
    const flags = { ...defaultFeaturesFor('RETAIL'), qrOrder: true, onlineOrder: true }
    expect(validateFeatureFlags(flags)).toHaveLength(2)
  })
})

describe('normalizeFeatureFlags', () => {
  it('falls back to preset defaults for null or malformed input', () => {
    expect(normalizeFeatureFlags(null, 'FNB')).toEqual(defaultFeaturesFor('FNB'))
    expect(normalizeFeatureFlags('nonsense', 'FNB')).toEqual(defaultFeaturesFor('FNB'))
  })

  it('applies stored overrides over the preset', () => {
    const result = normalizeFeatureFlags({ tables: false }, 'FNB')
    expect(result.tables).toBe(false)
    expect(result.kds).toBe(true)
  })

  it('drops unknown keys and ignores non-boolean values', () => {
    const result = normalizeFeatureFlags({ bogus: true, tables: 'yes' }, 'FNB')
    expect('bogus' in result).toBe(false)
    expect(result.tables).toBe(true)
  })

  it('fills in flags missing from older stored records', () => {
    const result = normalizeFeatureFlags({ tables: true }, 'FNB')
    for (const key of FEATURE_KEYS) {
      expect(typeof result[key]).toBe('boolean')
    }
  })
})
