/** Every board, newest first, with a count of what is on it. */
export default defineEventHandler(async (event) => {
    const { DB } = useCloudflare(event)
    const { results } = await DB.prepare(
        `SELECT b.id, b.title, b.created_at,
                (SELECT COUNT(*) FROM cards c WHERE c.board_id = b.id) AS card_count
           FROM boards b ORDER BY b.created_at DESC`
    ).all()
    return { boards: results }
})
