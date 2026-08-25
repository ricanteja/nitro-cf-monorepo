/**
 * A gesture in progress, described as a FUNCTION OF THE POINTER.
 *
 * This is the whole trick behind live collaboration here. A drag used to be
 * broadcast as a stream of positions, which meant two streams saying almost the
 * same thing — a cursor at 25 updates a second and a card at 16 — and the card
 * visibly lagged its own cursor because it was the slower of the two.
 *
 * Instead, a gesture is announced ONCE with the few constants needed to
 * reconstruct it, and from then on the pointer position everyone is already
 * receiving is enough to place the card. The card cannot drift from the cursor
 * dragging it, because it is derived from it.
 *
 * The constants are chosen so a receiver needs nothing of its own: a rotation
 * needs a pivot, and the pivot travels in the message rather than being measured
 * locally, so nobody has to have laid the card out to mirror what is happening
 * to it.
 */
export interface Point {
    x: number
    y: number
}

export type Gesture =
    | {
          mode: 'move'
          id: string
          /** Where in the card the pointer took hold, so it stays under the same spot. */
          dx: number
          dy: number
          /** Stickers stuck to this card, and where they sit relative to it. */
          followers: { id: string; ox: number; oy: number }[]
      }
    | {
          mode: 'resize'
          id: string
          cx: number
          cy: number
          /** Pointer distance from the centre when the drag began. */
          reach: number
          base: number
      }
    | {
          mode: 'rotate'
          id: string
          cx: number
          cy: number
          /** Pointer angle from the centre when the drag began, in degrees. */
          start: number
          base: number
      }

export const MIN_SCALE = 0.3
export const MAX_SCALE = 3
/** Rotation snaps to this many degrees while Shift is held. */
export const ROTATION_SNAP_DEG = 15

export const angleOf = (from: Point, to: Point) =>
    (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI

/**
 * What this gesture makes of the card, for a pointer at `at`.
 *
 * The same function runs on the machine doing the dragging and on every machine
 * watching it. That is deliberate: two implementations of "how far does a
 * rotation go" would eventually disagree, and the disagreement would only show
 * up as somebody else's card sitting at a slightly different angle to yours.
 */
export function gestureLayout(
    gesture: Gesture,
    at: Point,
    options: { snap?: boolean } = {}
): { x?: number; y?: number; scale?: number; rotation?: number } {
    if (gesture.mode === 'move') {
        return { x: Math.round(at.x - gesture.dx), y: Math.round(at.y - gesture.dy) }
    }
    const centre = { x: gesture.cx, y: gesture.cy }
    if (gesture.mode === 'resize') {
        const reach = Math.hypot(at.x - centre.x, at.y - centre.y)
        const scale = (gesture.base * reach) / Math.max(1, gesture.reach)
        return { scale: Number(Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)).toFixed(2)) }
    }
    const swept = gesture.base + (angleOf(centre, at) - gesture.start)
    return {
        rotation: options.snap
            ? Math.round(swept / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG
            : Math.round(swept),
    }
}
