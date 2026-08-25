/**
 * Facts about the board that both halves of the app need.
 *
 * Nuxt auto-imports `shared/utils` into the browser AND the server, which is
 * exactly right for these: the canvas clamps a drag to the extent, and the API
 * clamps a requested drop point to the same extent. Two copies of the number
 * would eventually disagree, and the failure would be a card the server accepts
 * and the canvas refuses to show.
 *
 * The board is BOUNDED rather than infinite. A board you can lose things in is a
 * board you stop trusting, and a finite extent makes "fit everything on screen"
 * always answerable.
 */
export const BOARD_WIDTH = 6000
export const BOARD_HEIGHT = 4000

/** Round and clamp a requested drop point, dropping anything unusable. */
export function boardPoint(x: unknown, y: unknown): { x?: number; y?: number } {
    return { x: axis(x, BOARD_WIDTH), y: axis(y, BOARD_HEIGHT) }
}

function axis(value: unknown, extent: number): number | undefined {
    const n = typeof value === 'string' ? Number(value) : value
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
    return Math.min(extent, Math.max(0, Math.round(n)))
}
