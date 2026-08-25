/**
 * Cut a string.
 *
 * Only strings drawn by hand can be cut. A person string is a consequence of
 * two faces carrying the same name, so the way to remove one is to correct the
 * name.
 */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'missing link id' })
    if (id.startsWith('person:')) {
        throw createError({
            statusCode: 409,
            statusMessage: 'person strings are derived from named faces; rename the face instead',
        })
    }
    const env = useCloudflare(event)
    const link = await env.DB.prepare('SELECT board_id AS boardId FROM links WHERE id = ?')
        .bind(id)
        .first<{ boardId: string }>()
    if (!link) throw createError({ statusCode: 404, statusMessage: 'no such link' })
    await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id).run()
    await notifyBoard(env, link.boardId)
    return { ok: true }
})
