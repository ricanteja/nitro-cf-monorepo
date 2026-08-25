import { MATCH_THRESHOLD, similarity, unpackEmbedding, type StoredBlob } from '../../utils/faces'

/**
 * Name the person in a detected face, or clear the name.
 *
 * Detection finds faces; people identify them. Naming is an upsert against the
 * board's cast, so typing a name that already exists links to that person
 * rather than creating a second one — which is what makes two photographs of
 * the same person string together.
 */
export default defineEventHandler(async (event) => {
    const faceId = getRouterParam(event, 'id')
    if (!faceId) throw createError({ statusCode: 400, statusMessage: 'missing face id' })

    const body = await readBody<{ name?: string | null }>(event)
    const name = typeof body?.name === 'string' ? body.name.trim() : null
    if (name && name.length > 80) {
        throw createError({ statusCode: 400, statusMessage: 'name is too long' })
    }

    const env = useCloudflare(event)
    const owner = await env.DB.prepare(
        'SELECT c.board_id AS boardId FROM faces f JOIN cards c ON c.id = f.card_id WHERE f.id = ?'
    )
        .bind(faceId)
        .first<{ boardId: string }>()
    if (!owner) throw createError({ statusCode: 404, statusMessage: 'no such face' })

    if (!name) {
        await env.DB.prepare('UPDATE faces SET person_id = NULL WHERE id = ?').bind(faceId).run()
        await notifyBoard(env, owner.boardId)
        return { ok: true, person: null }
    }

    // Case-insensitive, so "M. Reyes" and "m. reyes" are one person rather than
    // two who never connect to each other.
    const findPerson = () =>
        env.DB.prepare('SELECT id, name FROM people WHERE board_id = ? AND name = ? COLLATE NOCASE')
            .bind(owner.boardId, name)
            .first<{ id: string; name: string }>()

    // Read, insert, READ AGAIN — rather than read then insert and assume.
    //
    // Two requests naming the same person at the same moment both find nothing
    // and both insert, and the second hits the unique index on (board, name).
    // That is not hypothetical: it happens whenever the name box is committed
    // with Enter and then blurs. `OR IGNORE` makes the insert a no-op for the
    // loser, and re-reading gives it the row the winner created, so both callers
    // come back with the same person instead of one of them failing.
    let person = await findPerson()
    if (!person) {
        await env.DB.prepare(
            'INSERT OR IGNORE INTO people (id, board_id, name, created_at) VALUES (?, ?, ?, ?)'
        )
            .bind(crypto.randomUUID(), owner.boardId, name, Date.now())
            .run()
        person = await findPerson()
    }
    if (!person) throw createError({ statusCode: 500, statusMessage: 'could not record that name' })

    await env.DB.prepare('UPDATE faces SET person_id = ? WHERE id = ?')
        .bind(person.id, faceId)
        .run()

    // Naming one face names the rest of them.
    //
    // This is the whole point of storing an embedding. Without it, identifying
    // somebody in six photographs means doing it six times, and the strings that
    // are supposed to reveal a connection only appear once you have already
    // found it by hand. With it, the first name you type finds everywhere else
    // that person appears on this board.
    //
    // Only UNNAMED faces are touched. Somebody else's judgement about who a face
    // is outranks a similarity score, and silently overwriting it would make the
    // feature something to be undone rather than used.
    const spread = await spreadName(env, owner.boardId, faceId, person.id)

    await notifyBoard(env, owner.boardId)
    return { ok: true, person, alsoNamed: spread }
})

async function spreadName(
    env: ReturnType<typeof useCloudflare>,
    boardId: string,
    sourceFaceId: string,
    personId: string
): Promise<number> {
    const source = await env.DB.prepare('SELECT embedding FROM faces WHERE id = ?')
        .bind(sourceFaceId)
        .first<{ embedding: StoredBlob }>()
    const embedding = unpackEmbedding(source?.embedding ?? null)
    if (!embedding) return 0

    const { results: unnamed } = await env.DB.prepare(
        `SELECT f.id, f.person_id, f.embedding
           FROM faces f
           JOIN cards c ON c.id = f.card_id
          WHERE c.board_id = ? AND f.person_id IS NULL AND f.embedding IS NOT NULL`
    )
        .bind(boardId)
        .all<{ id: string; person_id: string | null; embedding: StoredBlob }>()

    const alike = unnamed.filter((face) => {
        const other = unpackEmbedding(face.embedding)
        return other ? similarity(embedding, other) >= MATCH_THRESHOLD : false
    })
    if (alike.length === 0) return 0

    const update = env.DB.prepare('UPDATE faces SET person_id = ? WHERE id = ?')
    await env.DB.batch(alike.map((face) => update.bind(personId, face.id)))
    return alike.length
}
