// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

/**
 * imgman container server.
 *
 * Two intakes, one pipeline, all of it needing native libraries the Workers
 * runtime does not have:
 *   POST /process  raw image bytes  -> analysis
 *   POST /import   { "url": "..." } -> the same, fetched from a remote URL
 *
 * "Analysis" means: decode (HEIC and PDF included), normalise orientation,
 * produce a JPEG thumbnail, read any text out of it with OCR, and find faces.
 *
 * `/import` lives HERE rather than in the Worker for a specific reason: safely
 * fetching a caller-supplied URL means checking the RESOLVED address before
 * connecting, and a Worker's fetch gives you no visibility into resolution.
 * A container has a real DNS stack, so the check can actually be made.
 */

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lookup } from 'node:dns/promises'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const execFileAsync = promisify(execFile)
const PORT = Number(process.env.PORT || 8080)
const MAX_BYTES = 25 * 1024 * 1024
const THUMB_MAX_EDGE = 512

/** RFC1918, loopback, link-local, multicast and friends. */
function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number)
        return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            a >= 224
        )
    }
    const v6 = ip.toLowerCase()
    return (
        v6 === '::' ||
        v6 === '::1' ||
        v6.startsWith('fc') ||
        v6.startsWith('fd') ||
        v6.startsWith('fe80')
    )
}

const MAX_REDIRECTS = 3
const USER_AGENT = 'skein-imgman/0.1 (+https://github.com/)'

/** Parse, check the scheme, resolve the host and reject private addresses. */
async function assertFetchable(rawUrl) {
    let url
    try {
        url = new URL(rawUrl)
    } catch {
        throw Object.assign(new Error('malformed url'), { status: 400 })
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw Object.assign(new Error(`unsupported scheme ${url.protocol}`), { status: 400 })
    }
    const { address } = await lookup(url.hostname)
    if (isPrivateAddress(address)) {
        throw Object.assign(new Error(`refusing to fetch private address ${address}`), {
            status: 403,
        })
    }
    return url
}

/**
 * Fetch a remote image, refusing anything that resolves to a private address.
 *
 * REDIRECTS ARE FOLLOWED BY HAND, and that is the whole point. Handing
 * `redirect: 'follow'` to fetch would check only the address the caller gave
 * us — a public host is then free to 302 straight to 169.254.169.254 and the
 * guard above would never see it. So each hop is re-validated. Handing it
 * `redirect: 'error'` instead, which is what this did first, is safe but
 * useless: ordinary image URLs redirect constantly and every one of them fails.
 *
 * NOTE: each hop resolves once for the check and again inside fetch, so a
 * hostile DNS server could answer differently the second time (a rebinding
 * attack). Closing that fully means connecting to the validated IP directly
 * and carrying the Host header. Left as-is deliberately: this is a demo, and
 * the gap is worth naming rather than hiding.
 */
async function fetchRemote(rawUrl) {
    let target = await assertFetchable(rawUrl)

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetch(target, {
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
            // Plenty of hosts (Wikimedia among them) reject a request with no
            // identifiable User-Agent outright.
            headers: { Accept: 'image/*,application/pdf', 'User-Agent': USER_AGENT },
        })

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location')
            if (!location) {
                throw Object.assign(new Error(`redirect with no location`), { status: 502 })
            }
            if (hop === MAX_REDIRECTS) {
                throw Object.assign(new Error('too many redirects'), { status: 502 })
            }
            target = await assertFetchable(new URL(location, target).toString())
            continue
        }

        if (!response.ok) {
            throw Object.assign(new Error(`upstream responded ${response.status}`), { status: 502 })
        }

        const declared = Number(response.headers.get('content-length') || 0)
        if (declared > MAX_BYTES) {
            throw Object.assign(new Error('image exceeds size limit'), { status: 413 })
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length > MAX_BYTES) {
            throw Object.assign(new Error('image exceeds size limit'), { status: 413 })
        }
        return bytes
    }
    throw Object.assign(new Error('too many redirects'), { status: 502 })
}

/** Sniff by magic bytes — the declared content-type is the caller's claim. */
function sniff(buffer) {
    const hex = buffer.subarray(0, 12).toString('hex')
    if (hex.startsWith('ffd8ff')) return 'jpeg'
    if (hex.startsWith('89504e47')) return 'png'
    if (hex.startsWith('47494638')) return 'gif'
    if (hex.startsWith('25504446')) return 'pdf'
    const brand = buffer.subarray(4, 12).toString('ascii')
    if (brand.startsWith('ftyp')) {
        if (brand.includes('heic') || brand.includes('heix') || brand.includes('mif1'))
            return 'heic'
        if (brand.includes('avif')) return 'avif'
    }
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return 'webp'
    // SVG is deliberately NOT supported. It is a document format that can
    // carry script, so accepting it here would mean either sanitising XML or
    // serving an XSS vector back to the board.
    const head = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase()
    if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg'
    return 'unknown'
}

const OCR_MIN_CONFIDENCE = 60
const OCR_MIN_CHARACTERS = 12
const DETECT_SCRIPT = new URL('./detect.py', import.meta.url).pathname

/**
 * Read the text out of an image.
 *
 * Uses tesseract's TSV output rather than plain text so per-word confidence is
 * available. A photograph run through OCR reliably produces a handful of
 * nonsense words; without a confidence floor those end up in the search index
 * and every query starts matching holiday snaps.
 *
 * Returns an empty string rather than throwing — a document whose text could
 * not be read is still a perfectly good thing to pin to a board.
 */
async function readText(imagePath) {
    let stdout
    try {
        ;({ stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', 'tsv'], {
            maxBuffer: 16 * 1024 * 1024,
        }))
    } catch (error) {
        console.warn('[imgman] OCR failed:', error?.message ?? error)
        return ''
    }

    // level page block par line word left top width height conf text
    const lines = new Map()
    for (const row of stdout.split('\n').slice(1)) {
        const cols = row.split('\t')
        if (cols.length < 12) continue
        const confidence = Number(cols[10])
        const word = cols[11]?.trim()
        if (!word || !Number.isFinite(confidence) || confidence < OCR_MIN_CONFIDENCE) continue
        const lineKey = cols.slice(1, 5).join('/')
        if (!lines.has(lineKey)) lines.set(lineKey, [])
        lines.get(lineKey).push(word)
    }

    const text = [...lines.values()]
        .map((words) => words.join(' '))
        .join('\n')
        .trim()

    // Below this it is noise rather than a document, and indexing it would make
    // search worse rather than better.
    const alphanumeric = (text.match(/[\p{L}\p{N}]/gu) ?? []).length
    return alphanumeric >= OCR_MIN_CHARACTERS ? text : ''
}

/**
 * Find faces, in the ORIGINAL image's coordinate space.
 *
 * Delegated to detect.py because Node has no reasonable face detector and the
 * alternatives that do exist cost roughly a gigabyte of image. Failure is not
 * fatal for the same reason OCR failure is not.
 */
async function findFaces(imagePath) {
    try {
        const { stdout } = await execFileAsync('python3', [DETECT_SCRIPT, imagePath], {
            maxBuffer: 4 * 1024 * 1024,
        })
        const parsed = JSON.parse(stdout)
        return Array.isArray(parsed.faces) ? parsed.faces : []
    } catch (error) {
        console.warn('[imgman] face detection failed:', error?.message ?? error)
        return []
    }
}

/**
 * Turn arbitrary input into everything the board needs to know about it.
 */
async function analyse(bytes) {
    const format = sniff(bytes)
    if (format === 'svg') {
        throw Object.assign(new Error('svg is not accepted; rasterise it first'), { status: 415 })
    }
    if (format === 'unknown') {
        throw Object.assign(new Error('unrecognised image format'), { status: 415 })
    }

    const dir = await mkdtemp(join(tmpdir(), 'imgman-'))
    try {
        const input = join(dir, `in.${format}`)
        await writeFile(input, bytes)
        let source = input

        // PDFs are rasterised with poppler rather than delegated to
        // ghostscript, which Debian's ImageMagick policy blocks outright.
        if (format === 'pdf') {
            await execFileAsync('pdftoppm', [
                '-png',
                '-r',
                '150',
                '-f',
                '1',
                '-l',
                '1',
                input,
                join(dir, 'page'),
            ])
            source = join(dir, 'page-1.png')
        } else if (format === 'heic') {
            const decoded = join(dir, 'decoded.png')
            await execFileAsync('heif-convert', [input, decoded])
            source = decoded
        }

        // One full-size, correctly-rotated copy that everything downstream
        // works from. Without it OCR and face detection would run on the
        // unrotated original while the thumbnail is rotated, so a portrait
        // photo taken sideways would return face boxes that do not line up
        // with what the board displays.
        const oriented = join(dir, 'oriented.png')
        await execFileAsync('convert', [source, '-auto-orient', '-strip', oriented])

        const output = join(dir, 'thumb.jpg')
        await execFileAsync('convert', [
            oriented,
            '-resize',
            `${THUMB_MAX_EDGE}x${THUMB_MAX_EDGE}>`,
            '-quality',
            '82',
            output,
        ])

        const [{ stdout: fullSize }, { stdout: thumbSize }] = await Promise.all([
            execFileAsync('identify', ['-format', '%w %h', oriented]),
            execFileAsync('identify', ['-format', '%w %h', output]),
        ])
        const [width, height] = fullSize.trim().split(/\s+/).map(Number)
        const [thumbWidth, thumbHeight] = thumbSize.trim().split(/\s+/).map(Number)

        // Independent of each other, and each is the slowest thing here on a
        // quarter-vCPU instance, so they run together.
        const [text, faces] = await Promise.all([readText(oriented), findFaces(oriented)])

        return {
            format,
            width,
            height,
            thumbWidth,
            thumbHeight,
            text,
            faces,
            thumbnail: await readFile(output),
        }
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

/**
 * Which of the native tools this image is supposed to carry actually run.
 *
 * Each binary is executed rather than merely looked for on PATH: a package that
 * installed but cannot load its own shared libraries is exactly the failure
 * worth catching, and it looks identical to a healthy one from `which`.
 */
async function checkTools() {
    const probes = {
        convert: ['convert', ['-version']],
        identify: ['identify', ['-version']],
        pdftoppm: ['pdftoppm', ['-v']],
        'heif-convert': ['heif-convert', ['--version']],
        tesseract: ['tesseract', ['--version']],
        opencv: ['python3', ['-c', 'import cv2; print(cv2.__version__)']],
    }
    const entries = await Promise.all(
        Object.entries(probes).map(async ([name, [bin, args]]) => {
            try {
                await execFileAsync(bin, args, { timeout: 10_000 })
                return [name, true]
            } catch {
                return [name, false]
            }
        })
    )
    return Object.fromEntries(entries)
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let total = 0
        req.on('data', (c) => {
            total += c.length
            if (total > MAX_BYTES) {
                reject(Object.assign(new Error('request body too large'), { status: 413 }))
                req.destroy()
                return
            }
            chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
    })
}

const server = createServer(async (req, res) => {
    const send = (status, body) => {
        const payload = JSON.stringify(body)
        res.writeHead(status, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
        })
        res.end(payload)
    }

    try {
        const url = new URL(req.url, 'http://container')

        if (req.method === 'GET' && url.pathname === '/health') {
            const tools = await checkTools()
            return send(200, { ok: Object.values(tools).every(Boolean), tools })
        }

        if (req.method === 'POST' && url.pathname === '/process') {
            const result = await analyse(await readBody(req))
            return send(200, {
                format: result.format,
                width: result.width,
                height: result.height,
                thumb_width: result.thumbWidth,
                thumb_height: result.thumbHeight,
                text: result.text,
                faces: result.faces,
                // base64 rather than a streamed body: this is a demo, and one
                // JSON response is far easier to follow than a multipart one.
                // A production version would stream both parts.
                thumbnail_b64: result.thumbnail.toString('base64'),
            })
        }

        if (req.method === 'POST' && url.pathname === '/import') {
            const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
            if (!body.url) return send(400, { error: 'missing url' })
            const original = await fetchRemote(body.url)
            const result = await analyse(original)
            return send(200, {
                format: result.format,
                width: result.width,
                height: result.height,
                thumb_width: result.thumbWidth,
                thumb_height: result.thumbHeight,
                text: result.text,
                faces: result.faces,
                original_b64: original.toString('base64'),
                thumbnail_b64: result.thumbnail.toString('base64'),
            })
        }

        return send(404, { error: 'not found' })
    } catch (error) {
        const status = error?.status ?? 500
        if (status >= 500) console.error('[imgman]', error)
        return send(status, { error: String(error?.message ?? error) })
    }
})

server.listen(PORT, () => console.log(`[imgman] listening on ${PORT}`))
