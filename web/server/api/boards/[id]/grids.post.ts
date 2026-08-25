/**
 * Add a table to a board.
 *
 * Columns and rows are the caller's to define, which is what lets the same
 * component be a tier list (rows are tiers, one column) or a kanban board
 * (columns are stages, one row).
 */
export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const body = await readBody<{
        title?: string
        preset?: 'tier' | 'kanban' | 'plain'
        columns?: { id: string; label: string; color?: string }[]
        rows?: { id: string; label: string }[]
        x?: number
        y?: number
    }>(event)

    const presets = {
        tier: {
            columns: [{ id: 'c1', label: '' }],
            rows: [
                { id: 'S', label: 'S' },
                { id: 'A', label: 'A' },
                { id: 'B', label: 'B' },
                { id: 'C', label: 'C' },
            ],
        },
        kanban: {
            columns: [
                { id: 'todo', label: 'To do' },
                { id: 'doing', label: 'Doing' },
                { id: 'done', label: 'Done' },
            ],
            rows: [{ id: 'r1', label: '' }],
        },
        plain: {
            columns: [
                { id: 'c1', label: 'Column 1' },
                { id: 'c2', label: 'Column 2' },
            ],
            rows: [
                { id: 'r1', label: 'Row 1' },
                { id: 'r2', label: 'Row 2' },
            ],
        },
    }
    const base = presets[body?.preset ?? 'plain']
    const columns = body?.columns ?? base.columns
    const rows = body?.rows ?? base.rows

    const env = useCloudflare(event)
    const id = crypto.randomUUID()
    const at = boardPoint(body?.x, body?.y)
    const grid = {
        id,
        title: body?.title ?? null,
        x: at.x ?? 80,
        y: at.y ?? 80,
        width: Math.max(320, columns.length * 220),
        height: Math.max(160, rows.length * 130),
        columns,
        rows,
    }
    await env.DB.prepare(
        `INSERT INTO grids (id, board_id, title, x, y, width, height, columns, rows, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
        .bind(
            grid.id,
            boardId,
            grid.title,
            grid.x,
            grid.y,
            grid.width,
            grid.height,
            JSON.stringify(columns),
            JSON.stringify(rows),
            Date.now()
        )
        .run()
    await notifyBoard(env, boardId)
    return { grid }
})
