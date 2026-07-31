/**
 * Feature toggles + business presets — S2-07, design §2.2 and §9.1.
 *
 * This is the mechanism behind "one core, many shapes": vertical behaviour is
 * data, never `if (fnb) … else if (retail)`. A preset seeds defaults; every flag
 * stays overridable per tenant.
 */

export const FULFILLMENT_TYPES = ['STOCKED', 'MADE_TO_ORDER', 'SERVICE'] as const
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number]

export const BUSINESS_PRESETS = ['FNB', 'RETAIL', 'SERVICE', 'MIXED'] as const
export type BusinessPreset = (typeof BUSINESS_PRESETS)[number]

export const FEATURE_KEYS = [
  'tables',
  'kds',
  'recipe',
  'barcode',
  'serviceScheduling',
  'modifiers',
  'serviceCharge',
  'memberLoyalty',
  'purchasing',
  'reservation',
  'qrOrder',
  'onlineOrder',
  'landingPage',
] as const

export type FeatureKey = (typeof FEATURE_KEYS)[number]
export type FeatureFlags = Record<FeatureKey, boolean>

/**
 * Toggle prerequisites — design §9.1.
 *
 * QR ordering hangs off a table, and online ordering needs a public page to
 * order from. Enforced in one place so the rule cannot drift between the
 * onboarding UI and the settings endpoint.
 */
export const FEATURE_DEPENDENCIES: Partial<Record<FeatureKey, readonly FeatureKey[]>> = {
  qrOrder: ['tables'],
  onlineOrder: ['landingPage'],
}

const ALL_OFF: FeatureFlags = {
  tables: false,
  kds: false,
  recipe: false,
  barcode: false,
  serviceScheduling: false,
  modifiers: false,
  serviceCharge: false,
  memberLoyalty: false,
  purchasing: false,
  reservation: false,
  qrOrder: false,
  onlineOrder: false,
  landingPage: false,
}

/** Design §9.1 matrix. ⬜ ("depends on the business") starts off. */
export const PRESET_DEFAULTS: Record<BusinessPreset, FeatureFlags> = {
  FNB: {
    ...ALL_OFF,
    tables: true,
    kds: true,
    recipe: true,
    modifiers: true,
    serviceCharge: true,
    memberLoyalty: true,
    purchasing: true,
  },
  RETAIL: {
    ...ALL_OFF,
    barcode: true,
    memberLoyalty: true,
    purchasing: true,
  },
  SERVICE: {
    ...ALL_OFF,
    serviceScheduling: true,
    memberLoyalty: true,
    reservation: true,
  },
  MIXED: {
    ...ALL_OFF,
    tables: true,
    kds: true,
    recipe: true,
    barcode: true,
    modifiers: true,
    memberLoyalty: true,
    purchasing: true,
  },
}

export const defaultFeaturesFor = (preset: BusinessPreset): FeatureFlags => ({
  ...PRESET_DEFAULTS[preset],
})

export interface FeatureValidationError {
  feature: FeatureKey
  requires: FeatureKey
}

/** Returns every unmet dependency rather than just the first, so the UI can show them all at once. */
export function validateFeatureFlags(flags: FeatureFlags): FeatureValidationError[] {
  const errors: FeatureValidationError[] = []
  for (const [feature, deps] of Object.entries(FEATURE_DEPENDENCIES) as [
    FeatureKey,
    readonly FeatureKey[],
  ][]) {
    if (!flags[feature]) continue
    for (const dep of deps) {
      if (!flags[dep]) errors.push({ feature, requires: dep })
    }
  }
  return errors
}

/** Coerce partial/legacy stored JSON into a complete flag set. Unknown keys are dropped. */
export function normalizeFeatureFlags(input: unknown, preset: BusinessPreset): FeatureFlags {
  const base = defaultFeaturesFor(preset)
  if (input === null || typeof input !== 'object') return base

  const record = input as Record<string, unknown>
  for (const key of FEATURE_KEYS) {
    const value = record[key]
    if (typeof value === 'boolean') base[key] = value
  }
  return base
}
