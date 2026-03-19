import type { Context } from 'hono'

const parseExtraOrigins = (): string[] =>
    process.env.CORS_ORIGINS?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? []

const baseDevOrigins = (): string[] => [
    'https://clawhost.cloud',
    'https://www.clawhost.cloud',
    'http://localhost:1111',
    'http://localhost:3333',
    ...parseExtraOrigins()
]

const baseProdOrigins = (): string[] => [
    'https://clawhost.cloud',
    'https://www.clawhost.cloud',
    ...parseExtraOrigins()
]

const isCloudRunHost = (host: string): boolean =>
    host === 'run.app' || host.endsWith('.run.app')

const getCorsOrigins = (): string | string[] | ((origin: string, c: Context) => string | undefined | null) => {
    const isDev = process.env.NODE_ENV !== 'production'
    if (isDev) {
        return baseDevOrigins()
    }
    if (process.env.CORS_ALLOW_CLOUD_RUN === '1') {
        const staticOrigins = baseProdOrigins()
        return (origin, _c) => {
            if (!origin) return origin
            if (staticOrigins.includes(origin)) return origin
            try {
                const host = new URL(origin).hostname
                if (isCloudRunHost(host)) return origin
            } catch {
                return null
            }
            return null
        }
    }
    return baseProdOrigins()
}

export default getCorsOrigins