/** Rename a board. The only thing about a board itself that is editable. */
export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const body = await readBody<{ title?: string }>(event)
    const title = (body?.title ?? '').trim()
    if (!title) throw createError({ statusCode: 400, statusMessage: 'a board needs a title' })
    if (title.length > 120)
        throw createError({ statusCode: 400, statusMessage: 'title is too long' })

    const { DB } = useCloudflare(event)
    const result = await DB.prepare('UPDATE boards SET title = ? WHERE id = ?')
        .bind(title, boardId)
        .run()
    if (!result.meta.changes) throw createError({ statusCode: 404, statusMessage: 'no such board' })
    return { id: boardId, title }
})
