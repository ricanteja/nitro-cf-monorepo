/** Draw a string between two cards. Person strings are derived, not stored. */
export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const body = await readBody<{
        fromCardId?: string
        toCardId?: string
        label?: string
        color?: string
    }>(event)
    const from = body?.fromCardId
    const to = body?.toCardId
    if (!from || !to) {
        throw createError({
            statusCode: 400,
            statusMessage: 'fromCardId and toCardId are required',
        })
    }
    if (from === to) {
        throw createError({ statusCode: 400, statusMessage: 'a card cannot be strung to itself' })
    }

    const env = useCloudflare(event)

    // Both ends must be on this board, or a caller could string together cards
    // from boards they cannot otherwise see.
    const { results: ends } = await env.DB.prepare(
        'SELECT id FROM cards WHERE board_id = ? AND id IN (?, ?)'
    )
        .bind(boardId, from, to)
        .all<{ id: string }>()
    if (ends.length !== 2) {
        throw createError({ statusCode: 404, statusMessage: 'both cards must be on this board' })
    }

    // Strings are undirected: a pair already joined either way round is joined.
    const existing = await env.DB.prepare(
        `SELECT id FROM links WHERE board_id = ?
          AND ((from_card_id = ? AND to_card_id = ?) OR (from_card_id = ? AND to_card_id = ?))`
    )
        .bind(boardId, from, to, to, from)
        .first<{ id: string }>()
    if (existing) return { id: existing.id, existed: true }

    const id = crypto.randomUUID()
    await env.DB.prepare(
        `INSERT INTO links (id, board_id, from_card_id, to_card_id, color, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
        .bind(
            id,
            boardId,
            from,
            to,
            body.color?.trim() || 'red',
            body.label?.trim() || null,
            Date.now()
        )
        .run()
    await notifyBoard(env, boardId)
    return { id, fromCardId: from, toCardId: to, color: body.color || 'red', kind: 'manual' }
})
