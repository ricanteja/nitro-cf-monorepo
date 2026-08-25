/**
 * Serve an object out of R2.
 *
 * Keys are constrained to the one prefix this app writes. Without that, the
 * route would hand out any object in the bucket to anyone who can guess a key.
 * Everything lives under `boards/<board id>/`, which is what lets deleting a
 * board take its images with it — see the board delete handler.
 */
const ALLOWED_PREFIXES = ['boards/']

export default defineEventHandler(async (event) => {
    const key = getRouterParam(event, 'key')
    if (!key || !ALLOWED_PREFIXES.some((p) => key.startsWith(p)) || key.includes('..')) {
        throw createError({ statusCode: 400, statusMessage: 'bad key' })
    }

    const { R2 } = useCloudflare(event)
    const object = await R2.get(key)
    if (!object) throw createError({ statusCode: 404, statusMessage: 'not found' })

    setResponseHeaders(event, {
        'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
        etag: object.httpEtag,
    })
    return object.body
})
