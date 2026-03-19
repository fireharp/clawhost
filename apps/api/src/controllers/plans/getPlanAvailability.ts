import type { Context } from 'hono'
import type { ProviderType } from '@/ts/Types'

import { getProvider } from '@/services/provider'
import planFallbackPrices from '@/lib/planFallbackPrices'
import { ok, fail } from '@/lib/response'
import { t } from '@openclaw/i18n'

const getPlanAvailability = async (c: Context) => {
    try {
        const providerName = (c.req.query('provider') ||
            'hetzner') as ProviderType
        const provider = getProvider(providerName)
        const customPrices = planFallbackPrices[providerName]

        if (!customPrices) {
            return fail(c, t('api.invalidProvider'), 400)
        }

        const [serverTypes, datacenters] = await Promise.all([
            provider.getRawServerTypes(),
            provider.getDatacenters()
        ])

        const nameToId = new Map<string, number>()
        for (const st of serverTypes) {
            nameToId.set(st.name, st.id)
        }

        const locationsByType = new Map<number, Set<string>>()
        for (const dc of datacenters) {
            for (const typeId of dc.availableServerTypeIds) {
                let locs = locationsByType.get(typeId)
                if (!locs) {
                    locs = new Set()
                    locationsByType.set(typeId, locs)
                }
                locs.add(dc.locationName)
            }
        }

        const availability: Record<string, string[]> = {}

        for (const planName of Object.keys(customPrices)) {
            const serverTypeId = nameToId.get(planName)
            if (!serverTypeId) continue
            availability[planName] = Array.from(
                locationsByType.get(serverTypeId) || []
            )
        }

        return ok(c, availability, t('api.planAvailabilityFetched'))
    } catch (err) {
        console.error('Failed to fetch plan availability:', err)
        return fail(c, t('api.failedToFetchPlanAvailability'), 500)
    }
}

export default getPlanAvailability