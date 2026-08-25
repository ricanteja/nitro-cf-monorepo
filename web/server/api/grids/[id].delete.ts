/** Remove a table. Cards sitting in it are released rather than deleted. */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'missing grid id' })
    const env = useCloudflare(event)
    const grid = await env.DB.prepare('SELECT board_id AS boardId FROM grids WHERE id = ?')
        .bind(id)
        .first<{ boardId: string }>()
    if (!grid) throw createError({ statusCode: 404, statusMessage: 'no such grid' })

    // ON DELETE SET NULL on cards.grid_id does the releasing; this clears the
    // cell references too, which have no foreign key to do it for them.
    await env.DB.batch([
        env.DB.prepare(
            'UPDATE cards SET grid_column = NULL, grid_row = NULL WHERE grid_id = ?'
        ).bind(id),
        env.DB.prepare('DELETE FROM grids WHERE id = ?').bind(id),
    ])
    await notifyBoard(env, grid.boardId)
    return { ok: true }
})
