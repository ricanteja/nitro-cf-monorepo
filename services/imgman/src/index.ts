// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

import { Container, getContainer } from '@cloudflare/containers'

export interface Env {
    IMAGES: DurableObjectNamespace<ImageContainer>
    R2: R2Bucket
}

interface DetectedFace {
    x: number
    y: number
    w: number
    h: number
    /** How sure the detector is, 0 to 1. */
    score?: number
    /** 128 numbers describing the face, or null when it could not be aligned. */
    embedding?: number[] | null
}

interface ContainerResult {
    format: string
    width: number
    height: number
    thumb_width: number
    thumb_height: number
    /** Text read out of the image by OCR; empty when there was none worth keeping. */
    text: string
    /** Faces found, in the FULL-RESOLUTION image's coordinate space. */
    faces: DetectedFace[]
    thumbnail_b64: string
    original_b64?: string
    error?: string
}

/**
 * The container instance itself.
 *
 * A Durable Object is how a container is addressed on Workers, so this class
 * is mostly configuration: which port the image listens on, and how long an
 * idle instance is kept before it is torn down. Instances bill while they
 * exist, so `sleepAfter` is short.
 */
export class ImageContainer extends Container<Env> {
    defaultPort = CONTAINER_PORT
    sleepAfter = '2m'
}

/** Where the container's HTTP server listens. Shared with the readiness wait below. */
const CONTAINER_PORT = 8080

/** Bytes are moved as base64 — see the note in container/server.mjs. */
function decode(b64: string): Uint8Array {
    const binary = atob(b64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
}

/**
 * Only a board id shaped like a uuid may become part of a key.
 *
 * The prefix below is built from a caller-supplied value, and a caller-supplied
 * value in a path is how one board reads or overwrites another board's objects.
 */
const BOARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Store what the container produced and report back where it went.
 *
 * The Worker does the R2 writes rather than the container, because bindings
 * belong to the Worker — a container has no binding of its own and would need
 * S3 credentials handed to it to do this itself.
 *
 * Keys are NAMESPACED BY BOARD, and that is the whole reason deleting a board
 * can promise to take its images with it. Flat keys could only be reclaimed by
 * reading them off the cards that referenced them — so an image whose card was
 * deleted earlier had nothing left pointing at it and would have stayed in the
 * bucket forever. A prefix is a list operation; a missing row is a leak.
 */
async function store(
    env: Env,
    boardId: string,
    id: string,
    result: ContainerResult,
    original?: Uint8Array
): Promise<Record<string, unknown>> {
    const originalKey = `boards/${boardId}/originals/${id}`
    const thumbKey = `boards/${boardId}/derivatives/${id}/thumb.jpg`

    const writes: Promise<unknown>[] = [
        env.R2.put(thumbKey, decode(result.thumbnail_b64), {
            httpMetadata: { contentType: 'image/jpeg' },
        }),
    ]
    if (original) {
        writes.push(env.R2.put(originalKey, original))
    }
    await Promise.all(writes)

    return {
        id,
        format: result.format,
        width: result.width,
        height: result.height,
        thumbWidth: result.thumb_width,
        thumbHeight: result.thumb_height,
        text: result.text ?? '',
        faces: result.faces ?? [],
        originalKey: original ? originalKey : undefined,
        thumbnailKey: thumbKey,
    }
}

/**
 * How long to wait for the container to be genuinely ready.
 *
 * A cold start pulls a 890 MB image into a fresh instance, so "ready" is not
 * instant. Sending a request into that window is how you get a plain-text
 * failure back from the runtime instead of the JSON this service promises.
 */
const START_TIMEOUT_MS = 60_000
const PORT_TIMEOUT_MS = 30_000

/**
 * Reach the container, waiting for it to actually be listening first.
 *
 * `fetch` alone does start a stopped instance, but it does not wait for the
 * process inside to bind its port — so the first request after an idle period
 * could arrive before anything was there to answer it, and came back as a
 * runtime error string rather than a response. `startAndWaitForPorts` closes
 * that window; everything after it is a normal HTTP call.
 */
async function reach(env: Env, request: Request): Promise<Response> {
    const container = getContainer(env.IMAGES)
    await container.startAndWaitForPorts({
        ports: CONTAINER_PORT,
        cancellationOptions: {
            instanceGetTimeoutMS: START_TIMEOUT_MS,
            portReadyTimeoutMS: PORT_TIMEOUT_MS,
        },
    })
    return container.fetch(request)
}

/**
 * Read the container's reply, or say plainly that it could not be read.
 *
 * The container answers in JSON. Anything else came from the layer underneath
 * it — an instance that would not start, a process that died — and parsing it
 * blindly turned a diagnosable problem into `Unexpected token 'F'`, a message
 * that names neither the container nor the reason.
 */
async function readResult(
    response: Response
): Promise<{ ok: true; result: ContainerResult } | { ok: false; response: Response }> {
    const body = await response.text()
    let result: ContainerResult
    try {
        result = JSON.parse(body) as ContainerResult
    } catch {
        return {
            ok: false,
            response: Response.json(
                {
                    error: `the image container did not answer with JSON: ${body.slice(0, 200)}`,
                },
                { status: 502 }
            ),
        }
    }
    if (!response.ok)
        return { ok: false, response: Response.json(result, { status: response.status }) }
    return { ok: true, result }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url)

        if (url.pathname === '/health') {
            try {
                return await reach(env, new Request('http://container/health'))
            } catch (error) {
                return Response.json(
                    { ok: false, error: `container unavailable: ${(error as Error).message}` },
                    { status: 503 }
                )
            }
        }

        // Which board's namespace the result belongs in. Required, because
        // there is no sensible default: an object with no owner is an object
        // nothing will ever clean up.
        const boardId = url.searchParams.get('board') ?? ''
        if (
            request.method === 'POST' &&
            (url.pathname === '/process' || url.pathname === '/import') &&
            !BOARD_ID.test(boardId)
        ) {
            return Response.json({ error: 'a valid ?board= is required' }, { status: 400 })
        }

        const isProcess = request.method === 'POST' && url.pathname === '/process'
        const isImport = request.method === 'POST' && url.pathname === '/import'
        if (!isProcess && !isImport) return new Response('not found', { status: 404 })

        // Upload path: the caller already holds the bytes.
        // Import path: the CONTAINER does the fetching, because validating a
        // caller-supplied URL means checking the resolved address and a Worker
        // cannot see it. See container/server.mjs.
        const bytes = isProcess ? new Uint8Array(await request.arrayBuffer()) : undefined
        const outbound = isProcess
            ? new Request('http://container/process', { method: 'POST', body: bytes })
            : new Request('http://container/import', {
                  method: 'POST',
                  body: await request.text(),
                  headers: { 'content-type': 'application/json' },
              })

        let response: Response
        try {
            response = await reach(env, outbound)
        } catch (error) {
            return Response.json(
                { error: `the image container could not be started: ${(error as Error).message}` },
                { status: 503 }
            )
        }

        const read = await readResult(response)
        if (!read.ok) return read.response

        const id = crypto.randomUUID()
        const original = isProcess
            ? bytes
            : read.result.original_b64
              ? decode(read.result.original_b64)
              : undefined
        return Response.json(await store(env, boardId, id, read.result, original))
    },
} satisfies ExportedHandler<Env>
