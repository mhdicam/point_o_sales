/**
 * Feature service — S2-07.
 *
 * Reads BusinessProfile.features JSON and checks whether a toggle is enabled.
 * The JSON is validated against FeatureFlags from @brewsync/shared on read and
 * write (design §2.2).
 */

import type { BrewsyncClient } from '@brewsync/db'
import { getTenantContext } from '@brewsync/db'
import type { FeatureKey, FeatureFlags } from '@brewsync/shared'

export class FeatureService {
  constructor(private readonly db: BrewsyncClient) {}

  async getFeatures(): Promise<FeatureFlags | null> {
    const context = getTenantContext()
    if (!context?.tenantId) return null

    // BusinessProfile.tenantId is the PK (1-to-1 with Tenant), but the
    // extension already narrows to the context tenant, so findFirst is safer
    // than writing `where: { tenantId }` manually (standard #1).
    const profile = await this.db.businessProfile.findFirst()

    if (!profile) return null

    return profile.features as FeatureFlags
  }

  async isEnabled(feature: FeatureKey): Promise<boolean> {
    const features = await this.getFeatures()
    return features?.[feature] ?? false
  }

  /** Returns the subset of `required` that are disabled. Empty means all enabled. */
  async getDisabled(required: FeatureKey[]): Promise<FeatureKey[]> {
    const features = await this.getFeatures()
    if (!features) return required

    return required.filter((key) => !features[key])
  }
}
