/** Recolour or relabel a string. */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'missing link id' })
    if (id.startsWith('person:')) {
        throw createError({
            statusCode: 409,
            statusMessage: 'person strings are derived from named faces and cannot be edited',
        })
    }
    const body = await readBody<{ color?: string; label?: string }>(event)
    const env = useCloudflare(event)
    const link = await env.DB.prepare('SELECT board_id AS boardId FROM links WHERE id = ?')
        .bind(id)
        .first<{ boardId: string }>()
    if (!link) throw createError({ statusCode: 404, statusMessage: 'no such link' })

    await env.DB.prepare(
        'UPDATE links SET color = COALESCE(?, color), label = COALESCE(?, label) WHERE id = ?'
    )
        .bind(body?.color?.trim() || null, body?.label?.trim() || null, id)
        .run()
    await notifyBoard(env, link.boardId)
    return { ok: true }
})
