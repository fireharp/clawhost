import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { neon } from '@neondatabase/serverless'
import pg from 'pg'

import * as schema from '@/db/schema'

let pgPool: pg.Pool | null = null

const useNodePostgres = (): boolean => {
    if (process.env.DATABASE_DRIVER === 'pg') return true
    const raw = process.env.DATABASE_URL
    if (!raw) return false
    if (raw.includes('host=/cloudsql/')) return true
    try {
        const normalized = raw.replace(/^postgres(ql)?:/, 'http:')
        const host = new URL(normalized).hostname
        return host === 'localhost' || host === '127.0.0.1'
    } catch {
        return false
    }
}

const createDb = () => {
    const url = process.env.DATABASE_URL!
    if (useNodePostgres()) {
        if (!pgPool) {
            const sslOpts =
                process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === '0'
                    ? { rejectUnauthorized: false as const }
                    : undefined
            pgPool = new pg.Pool({
                connectionString: url,
                max: 20,
                ...(sslOpts ? { ssl: sslOpts } : {})
            })
        }
        return drizzlePg(pgPool, { schema })
    }
    const sql = neon(url)
    return drizzleNeon(sql, { schema })
}

let instance: NodePgDatabase<typeof schema>

export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
    get(_, prop) {
        if (!instance) instance = createDb() as NodePgDatabase<typeof schema>
        return Reflect.get(instance, prop)
    }
})