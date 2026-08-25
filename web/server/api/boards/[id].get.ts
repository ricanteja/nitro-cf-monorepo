/**
 * A board and everything on it, in one request.
 *
 * The board cannot render usefully without all of it — cards with no faces
 * drawn on them, or strings pointing at cards that have not arrived yet, is a
 * worse first paint than waiting.
 */
export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const env = useCloudflare(event)
    const { DB } = env
    const board = await DB.prepare('SELECT id, title, created_at FROM boards WHERE id = ?')
        .bind(boardId)
        .first<{ id: string; title: string; created_at: number }>()
    if (!board) throw createError({ statusCode: 404, statusMessage: 'no such board' })

    const batch = await DB.batch([
        DB.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE board_id = ? ORDER BY z`).bind(boardId),

        DB.prepare(
            'SELECT id, title, x, y, width, height, columns, rows FROM grids WHERE board_id = ?'
        ).bind(boardId),

        DB.prepare('SELECT id, name FROM people WHERE board_id = ? ORDER BY name').bind(boardId),

        DB.prepare(
            `SELECT f.id, f.card_id AS cardId, f.person_id AS personId, f.x, f.y, f.w, f.h
               FROM faces f JOIN cards c ON c.id = f.card_id WHERE c.board_id = ?`
        ).bind(boardId),

        DB.prepare(
            `SELECT id, from_card_id AS fromCardId, to_card_id AS toCardId, label, color
               FROM links WHERE board_id = ?`
        ).bind(boardId),

        // Person strings are DERIVED, not stored: two cards are connected
        // because the same named person is in both, so naming a face makes its
        // strings appear everywhere at once and clearing it makes them vanish,
        // with nothing to recompute and nothing to go stale.
        //
        // `b.card_id > a.card_id` both de-duplicates each pair and rules out a
        // card being strung to itself.
        DB.prepare(
            `SELECT DISTINCT a.card_id AS fromCardId, b.card_id AS toCardId,
                             pe.id AS personId, pe.name AS label
               FROM faces a
               JOIN faces b ON b.person_id = a.person_id AND b.card_id > a.card_id
               JOIN people pe ON pe.id = a.person_id
               JOIN cards c ON c.id = a.card_id
              WHERE c.board_id = ? AND a.person_id IS NOT NULL`
        ).bind(boardId),
    ])

    // D1 types every element of a batch result as possibly absent.
    const rows = (i: number) => (batch[i]?.results ?? []) as Record<string, unknown>[]

    // Layout comes from the Durable Object when a session is open. See
    // `liveLayout` — without this the board is read from a table that is up to
    // one flush interval behind what the user can see.
    const live = await liveLayout(env, boardId)

    return {
        board,
        cards: rows(0).map((card) => ({ ...card, ...(live.get(String(card.id)) ?? {}) })),
        grids: rows(1).map((g) => ({
            ...g,
            columns: JSON.parse(String(g.columns)),
            rows: JSON.parse(String(g.rows)),
        })),
        people: rows(2),
        faces: rows(3),
        links: [
            ...rows(4).map((l) => ({ ...l, kind: 'manual' })),
            ...rows(5).map((l) => ({
                ...l,
                id: `person:${l.personId}:${l.fromCardId}:${l.toCardId}`,
                kind: 'person',
                color: 'red',
            })),
        ],
    }
})
