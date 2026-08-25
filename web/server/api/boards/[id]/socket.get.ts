/**
 * Where the browser should open its WebSocket for this board.
 *
 * One shape in every environment: this app's own origin, this same path. The
 * upgrade is answered above Nitro by server/upgrade.ts and handed to the
 * Durable Object over the `BOARD` binding, so there is no second hostname to
 * compose and nothing environment-specific for the client to know.
 *
 * Development is the one exception, and it is not one the client sees. Nitro
 * serves HTTP from Node there, and Node cannot return a workerd socket, so the
 * upgrade is answered by Miniflare instead — a different port on the same
 * machine. The preset publishes that address; this substitutes it.
 */

/** Long enough for "Whimsical Wolverine 4821"; short enough not to be a payload. */
const MAX_NAME_LENGTH = 40

export default defineEventHandler((event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const query = getQuery(event)
    const role = query.role === 'edit' ? 'edit' : 'view'
    const name = String(query.name ?? '').slice(0, MAX_NAME_LENGTH) || 'anonymous'
    const params = `role=${role}&name=${encodeURIComponent(name)}`

    // Set by the preset once Miniflare is listening; absent everywhere else,
    // including under `wrangler dev` against the built output, where the
    // deployed entry answers the upgrade on this origin like production does.
    const devOrigin = (globalThis as Record<string, unknown>).__miniflareOrigin__ as
        string | undefined

    const origin = devOrigin ?? getRequestURL(event).origin
    return {
        url: `${origin.replace(/^http/, 'ws')}/api/boards/${encodeURIComponent(boardId)}/socket?${params}`,
        mode: devOrigin ? 'dev' : 'deployed',
    }
})
