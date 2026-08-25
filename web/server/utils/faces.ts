import type { SkeinEnv } from './cloudflare'

/**
 * How alike two faces have to be to be called the same person.
 *
 * 0.363 is the threshold SFace's authors publish for cosine similarity, and it
 * is not a number to invent locally — it comes from measuring the model against
 * a labelled set, which is exactly the work a demo has no business redoing.
 *
 * Measured on the seed photographs in `scripts/seed.ts`: two portraits of the
 * same person score 0.42 to 0.69, and every pair of different people scores
 * 0.27 or below. The gap is wide, which is why a single fixed threshold is
 * enough here rather than something adaptive.
 */
export const MATCH_THRESHOLD = 0.363

/** 128 float32s. Fixed by the model, and worth asserting on the way in. */
export const EMBEDDING_LENGTH = 128

/**
 * What D1 hands back for a BLOB column.
 *
 * Not one thing. Depending on the driver and the runtime it can be an
 * ArrayBuffer, a typed-array view over one, or a plain array of byte values —
 * and the last of those has no `byteLength`, so code that assumed ArrayBuffer
 * silently treated every stored embedding as absent. Nothing errored; matching
 * just never found anybody.
 */
export type StoredBlob = ArrayBuffer | ArrayBufferView | number[] | null

export interface FaceRow {
    id: string
    person_id: string | null
    embedding: StoredBlob
}

/**
 * Pack an embedding for storage.
 *
 * Float32 rather than the float64 JSON gives us: the model produces float32 and
 * the extra precision describes nothing. 512 bytes a face either way is small
 * enough that the column costs less than the row around it.
 */
export function packEmbedding(values: number[] | undefined | null): ArrayBuffer | null {
    if (!values || values.length !== EMBEDDING_LENGTH) return null
    return Float32Array.from(values).buffer as ArrayBuffer
}

export function unpackEmbedding(blob: StoredBlob): Float32Array | null {
    if (!blob) return null
    const bytes = Array.isArray(blob)
        ? new Uint8Array(blob)
        : ArrayBuffer.isView(blob)
          ? new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength)
          : new Uint8Array(blob)
    if (bytes.byteLength !== EMBEDDING_LENGTH * 4) return null
    // Copied rather than viewed: a view over a Uint8Array that is itself a view
    // into a larger buffer would need an aligned offset, and there is nothing
    // guaranteeing one.
    return new Float32Array(bytes.slice().buffer)
}

/**
 * Cosine similarity: the cosine of the angle between two embeddings.
 *
 * Angle rather than distance because SFace's output is not normalised — the
 * same face photographed under different light produces vectors of different
 * LENGTH pointing in nearly the same direction, and only the direction carries
 * the identity.
 */
export function similarity(a: Float32Array, b: Float32Array): number {
    let dot = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!
        normA += a[i]! * a[i]!
        normB += b[i]! * b[i]!
    }
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB)
    return magnitude === 0 ? 0 : dot / magnitude
}

/** Every face on a board that has already been given a name. */
export async function namedFaces(env: SkeinEnv, boardId: string): Promise<FaceRow[]> {
    const { results } = await env.DB.prepare(
        `SELECT f.id, f.person_id, f.embedding
           FROM faces f
           JOIN cards c ON c.id = f.card_id
          WHERE c.board_id = ? AND f.person_id IS NOT NULL AND f.embedding IS NOT NULL`
    )
        .bind(boardId)
        .all<FaceRow>()
    return results
}

/**
 * Which person, if any, this embedding belongs to.
 *
 * A LINEAR SCAN, on purpose. Every named face on the board is compared, the
 * best match wins, and it has to clear the threshold. On a board with a hundred
 * named faces that is a hundred dot products over 128 floats — tens of
 * microseconds — against the alternative of a network round trip to a vector
 * index. The scan stops being the right answer somewhere around tens of
 * thousands of faces, which is not a board any person is looking at.
 *
 * Best-match rather than first-over-threshold matters when two people on a board
 * genuinely resemble each other: picking whichever happened to be queried first
 * would make the result depend on insertion order.
 */
export function matchFace(
    embedding: Float32Array,
    candidates: FaceRow[]
): { personId: string; score: number } | null {
    let best: { personId: string; score: number } | null = null
    for (const candidate of candidates) {
        const other = unpackEmbedding(candidate.embedding)
        if (!other || !candidate.person_id) continue
        const score = similarity(embedding, other)
        if (score >= MATCH_THRESHOLD && (!best || score > best.score)) {
            best = { personId: candidate.person_id, score }
        }
    }
    return best
}
