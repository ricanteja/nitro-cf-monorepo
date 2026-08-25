import type {
    D1Database,
    R2Bucket,
    Fetcher,
    DurableObjectNamespace,
} from '@cloudflare/workers-types'
import type { H3Event } from 'h3'

export interface SkeinEnv {
    DB: D1Database
    R2: R2Bucket
    IMGMAN: Fetcher
    BOARD: DurableObjectNamespace
}

/**
 * Where the bindings actually are.
 *
 * `event.context.cloudflare.env` is the documented location, and in `nuxt dev`
 * it is populated — by our own preset, which sets it on every event so that the
 * auxiliary workers loaded into Miniflare are reachable the same way they would
 * be in production.
 *
 * In a DEPLOYED worker it is empty, and that is worth spelling out because the
 * symptom is alarming and the cause is not in this repository. nitropack's
 * cloudflare-module handler passes the platform context to `localFetch` under
 * `_platform`, and h3 only copies it onto `event.context` when it finds it at
 * `event.node.req.__unenv__`. On nitropack 2.13.4 that property is not set on
 * this path, so the copy never happens and every binding reads as absent — all
 * four at once, which is the tell: a real misconfiguration loses one.
 *
 * The bindings are not gone. The same handler assigns them to a global before
 * it dispatches, so that is the fallback. It is a global rather than
 * per-request state, but `env` is identical for every request a given worker
 * deployment serves, so there is nothing to race. The documented location is
 * still preferred, which means this keeps working unchanged if a later nitropack
 * restores the copy.
 */
export function cloudflareBindings(event: H3Event): Partial<SkeinEnv> | undefined {
    const fromContext = event.context.cloudflare?.env as Partial<SkeinEnv> | undefined
    if (fromContext) {
        return fromContext
    }
    return (globalThis as { __env__?: Partial<SkeinEnv> }).__env__
}

/**
 * The Cloudflare bindings for this request.
 *
 * Every binding this function claims to return is checked, not just the two
 * that are easiest to reach for: handing back a half-populated object typed as
 * complete moves the failure to whichever handler dereferences the missing one,
 * where it reads as a bug in that handler.
 */
export function useCloudflare(event: H3Event): SkeinEnv {
    const env = cloudflareBindings(event)
    const missing = (['DB', 'R2', 'IMGMAN', 'BOARD'] as const).filter((key) => !env?.[key])
    if (missing.length > 0) {
        throw createError({
            statusCode: 503,
            statusMessage: `Cloudflare bindings unavailable: ${missing.join(', ')}`,
        })
    }
    return env as SkeinEnv
}

export interface CardRow {
    id: string
    board_id: string
    kind: 'note' | 'image' | 'sticker'
    x: number
    y: number
    rotation: number
    scale: number
    z: number
    width: number | null
    height: number | null
    text: string | null
    font_size: number | null
    color: string | null
    r2_key: string | null
    grid_id: string | null
    grid_column: string | null
    grid_row: string | null
    attached_to: string | null
}
