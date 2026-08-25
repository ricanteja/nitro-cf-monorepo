/**
 * Mint a share link.
 *
 * The token IS the credential — whoever holds it gets the permission it
 * carries. That is what a share link is, and it is why the token is a uuid
 * rather than anything derived from the board id.
 *
 * A board can have several: one view link to circulate and one edit link for
 * collaborators is the ordinary case.
 */
export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const body = await readBody<{ permission?: 'view' | 'edit' }>(event)
    const permission = body?.permission === 'edit' ? 'edit' : 'view'

    const env = useCloudflare(event)
    const board = await env.DB.prepare('SELECT id FROM boards WHERE id = ?').bind(boardId).first()
    if (!board) throw createError({ statusCode: 404, statusMessage: 'no such board' })

    // Reuse an existing link of the same permission rather than minting a
    // second one — otherwise every click of the share button invalidates
    // nothing and leaks another live credential.
    const existing = await env.DB.prepare(
        'SELECT token FROM shares WHERE board_id = ? AND permission = ?'
    )
        .bind(boardId, permission)
        .first<{ token: string }>()
    if (existing) return { token: existing.token, permission, existed: true }

    const token = crypto.randomUUID()
    await env.DB.prepare(
        'INSERT INTO shares (token, board_id, permission, created_at) VALUES (?, ?, ?, ?)'
    )
        .bind(token, boardId, permission, Date.now())
        .run()
    return { token, permission }
})
