/** The share links that exist for a board. */
export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })
    const { DB } = useCloudflare(event)
    const { results } = await DB.prepare(
        'SELECT token, permission, created_at FROM shares WHERE board_id = ? ORDER BY permission'
    )
        .bind(boardId)
        .all()
    return { shares: results }
})
