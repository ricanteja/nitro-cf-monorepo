/**
 * Delete a board and everything that belonged to it.
 *
 * Three stores hold pieces of a board and each has to be told separately.
 *
 * D1 cascades from `boards`, so one statement takes the cards, grids, people,
 * faces, links and share tokens with it.
 *
 * R2 knows nothing about D1, so its objects are swept BY PREFIX rather than by
 * reading keys off the cards. That distinction matters: a card deleted an hour
 * ago left its image behind on purpose — deleting a card is undoable, and undo
 * cannot restore bytes — so there is no row left pointing at those objects. A
 * prefix finds them anyway. Everything an upload writes lives under
 * `boards/<id>/`, which is the whole reason it is keyed that way.
 *
 * And the Durable Object holds this board's live layout in its own SQLite,
 * which would otherwise sit there being billed for a board nobody can open.
 */
const R2_DELETE_BATCH = 1000

export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const env = useCloudflare(event)
    const board = await env.DB.prepare('SELECT id, title FROM boards WHERE id = ?')
        .bind(boardId)
        .first<{ id: string; title: string }>()
    if (!board) throw createError({ statusCode: 404, statusMessage: 'no such board' })

    await env.DB.prepare('DELETE FROM boards WHERE id = ?').bind(boardId).run()

    // Ask the room to let go: close whoever is still connected and drop the
    // layout it was holding for them.
    try {
        const stub = env.BOARD.get(env.BOARD.idFromName(boardId))
        await stub.fetch('http://board/destroy', { method: 'POST' })
    } catch (error) {
        console.warn(`[boards] could not tear down the room for ${boardId}:`, error)
    }

    // Paged, because a board with a few hundred photographs has more objects
    // than one list call returns and more keys than one delete call accepts.
    let removed = 0
    try {
        let cursor: string | undefined
        do {
            const page = await env.R2.list({ prefix: `boards/${boardId}/`, cursor, limit: 500 })
            const keys = page.objects.map((o) => o.key)
            for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
                await env.R2.delete(keys.slice(i, i + R2_DELETE_BATCH))
            }
            removed += keys.length
            cursor = page.truncated ? page.cursor : undefined
        } while (cursor)
    } catch (error) {
        // The rows are already gone, so the board is deleted either way; what is
        // left is storage nobody can reach, which a lifecycle rule can sweep.
        console.warn(`[boards] could not clear R2 for ${boardId}:`, error)
    }

    return { ok: true, title: board.title, removed }
})
