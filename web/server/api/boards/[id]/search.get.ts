/**
 * Full-text search across everything on a board — typed notes and text read out
 * of images alike, because from the board's point of view they are the same
 * thing: words that appear on a piece of material.
 */
export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const query = String(getQuery(event).q ?? '').trim()
    if (!query) return { query: '', results: [] }

    // FTS5's MATCH takes a query LANGUAGE, not a string — bare user input
    // containing a quote, a hyphen or the word `AND` is either a syntax error or
    // means something the user did not intend. Quoting each term makes it a
    // literal; the trailing `*` makes it a prefix match so the box behaves like
    // a search box while you type.
    const terms = query
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 12)
        .map((term) => `"${term.replaceAll('"', '""')}"*`)
    if (terms.length === 0) return { query, results: [] }

    const { DB } = useCloudflare(event)
    const { results } = await DB.prepare(
        `SELECT s.card_id AS id, c.kind, c.x, c.y, c.r2_key AS r2Key,
                snippet(card_search, 1, '«', '»', '…', 14) AS excerpt
           FROM card_search s
           JOIN cards c ON c.id = s.card_id
          WHERE c.board_id = ? AND card_search MATCH ?
          ORDER BY rank LIMIT 30`
    )
        .bind(boardId, terms.join(' AND '))
        .all()

    return { query, results }
})
