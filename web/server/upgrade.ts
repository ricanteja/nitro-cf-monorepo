/**
 * WebSocket upgrades for this app.
 *
 * Invoked by the monorepo preset ABOVE Nitro — from the worker entry when
 * deployed, from Miniflare's main worker in development — because Nitro rebuilds
 * every handler's return value into a fresh `Response` and `new Response(null,
 * { status: 101 })` throws. Nothing here can live in a route.
 *
 * It is the reason `board` needs no hostname. The browser opens its socket to
 * this app, on this app's origin, and it is handed to the Durable Object over
 * the same `BOARD` binding every server-side call already uses.
 *
 * Returning nothing lets the request fall through to Nitro, which is what the
 * ordinary `GET` on this path does — it answers with the URL to open.
 */
import type { DurableObjectNamespace } from '@cloudflare/workers-types'

const SOCKET = /^\/api\/boards\/([^/]+)\/socket\/?$/

export default function upgrade(
    request: Request,
    env: { BOARD?: DurableObjectNamespace }
): unknown {
    const match = SOCKET.exec(new URL(request.url).pathname)
    if (!match || !env.BOARD) return undefined

    // `idFromName`, exactly as every other caller addresses a board, so the
    // object can still recover its own id from `ctx.id.name` and hydrate itself.
    const stub = env.BOARD.get(env.BOARD.idFromName(match[1]!))
    return stub.fetch(request as unknown as Parameters<typeof stub.fetch>[0])
}
