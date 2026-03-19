import 'dotenv/config'

import { defineConfig } from 'drizzle-kit'

const parseUrlToPgCredentials = (
    raw: string,
    ssl: { rejectUnauthorized: boolean }
) => {
    const normalized = raw.replace(/^postgres(ql)?:/, 'http:')
    const u = new URL(normalized)
    const database = u.pathname.replace(/^\//, '').split('?')[0]
    return {
        host: u.hostname,
        port: Number(u.port || 5432),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database,
        ssl
    }
}

const dbCredentials = (() => {
    const url = process.env.DATABASE_URL
    if (!url) {
        throw new Error('DATABASE_URL is not set')
    }
    if (url.includes('host=/cloudsql/')) {
        return { url }
    }
    if (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === '0') {
        return parseUrlToPgCredentials(url, { rejectUnauthorized: false })
    }
    return { url }
})()

export default defineConfig({
    schema: './src/db/schema.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials
})