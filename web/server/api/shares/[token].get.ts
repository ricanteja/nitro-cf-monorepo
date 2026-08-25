/**
 * Resolve a share token to the board it opens and the permission it carries.
 *
 * The client calls this once and then behaves accordingly. This is a demo, so
 * the permission is not enforced on every mutation server-side: it decides what
 * the UI offers and what the board's Durable Object accepts over the socket.
 * Real enforcement would mean checking the token on every write, which is a
 * session layer this deliberately does not have.
 */
export default defineEventHandler(async (event) => {
    const token = getRouterParam(event, 'token')
    if (!token) throw createError({ statusCode: 400, statusMessage: 'missing token' })
    const { DB } = useCloudflare(event)
    const share = await DB.prepare(
        `SELECT s.token, s.permission, b.id AS boardId, b.title
           FROM shares s JOIN boards b ON b.id = s.board_id
          WHERE s.token = ?`
    )
        .bind(token)
        .first()
    if (!share) throw createError({ statusCode: 404, statusMessage: 'no such share link' })
    return share
})
