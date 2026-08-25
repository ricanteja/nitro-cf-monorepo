// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, join, relative } from 'pathe'

const execFileAsync = promisify(execFile)

/** Just enough of a logger for this module to work with Nitro's or console. */
export interface ContainerLogger {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
}

export type ContainerApp = {
    class_name: string
    image?: string
    image_uri?: string
    image_build_context?: string
    image_vars?: Record<string, string>
}

/** Wrangler's local-dev image naming: `cloudflare-dev/<class>:<buildId>`. */
export const devImageName = (className: string, buildId: string) =>
    `cloudflare-dev/${className.toLowerCase()}:${buildId}`

/** Directory entries never worth hashing, whatever .dockerignore says. */
const ALWAYS_SKIP = new Set(['node_modules', '.git'])

/**
 * Read a build context's .dockerignore into a set of plain names.
 *
 * Deliberately NOT a full matcher — globs and negations are ignored. Its only
 * job is keeping the build-id hash from reacting to files Docker would not
 * have copied anyway. Over-hashing is a wasted (cached) rebuild, not an error.
 */
function readDockerignore(contextDir: string): Set<string> {
    const skip = new Set(ALWAYS_SKIP)
    try {
        for (const raw of readFileSync(join(contextDir, '.dockerignore'), 'utf8').split('\n')) {
            const line = raw.trim()
            if (!line || line.startsWith('#') || line.startsWith('!') || line.includes('*'))
                continue
            skip.add(line.replace(/^\.?\//, '').replace(/\/$/, ''))
        }
    } catch {
        // No .dockerignore is normal.
    }
    return skip
}

/**
 * Content hash of a build context, used as the image tag.
 *
 * Wrangler tags dev images with a random UUID per dev session, which means a
 * fresh image every restart. Hashing the inputs instead makes the tag stable:
 * unchanged context → same tag → `docker build` is a full cache hit and nothing
 * accumulates on disk. It also makes the tag a CHANGE DETECTOR, which is what
 * lets a running container be reloaded when its sources are edited.
 */
export function hashBuildContext(dockerfile: string, contextDir: string): string {
    const hash = createHash('sha256')
    hash.update(readFileSync(dockerfile))
    const skip = readDockerignore(contextDir)

    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name < b.name ? -1 : 1
        )) {
            if (skip.has(entry.name)) continue
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
                walk(full)
            } else if (entry.isFile()) {
                // Path + size + mtime rather than contents: this runs on every
                // dev start and on every edit, and the context can be hundreds
                // of megabytes.
                const st = statSync(full)
                hash.update(`${relative(contextDir, full)}:${st.size}:${st.mtimeMs}`)
            }
        }
    }
    try {
        walk(contextDir)
    } catch {
        // Unreadable context — fall back to hashing the Dockerfile alone.
    }
    return hash.digest('hex').slice(0, 8)
}

/** The build id a worker's containers WOULD have, without building anything. */
export function computeBuildId(containers: ContainerApp[]): string {
    const parts: string[] = []
    for (const c of containers) {
        if (c.image_uri) {
            parts.push(c.image_uri)
        } else if (c.image) {
            parts.push(hashBuildContext(c.image, c.image_build_context || dirname(c.image)))
        }
    }
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8)
}

/** Every directory whose contents feed a worker's container build ids. */
export function containerContextDirs(containers: ContainerApp[]): string[] {
    const dirs = new Set<string>()
    for (const c of containers) {
        if (c.image) dirs.add(c.image_build_context || dirname(c.image))
    }
    return [...dirs]
}

export async function dockerAvailable(): Promise<boolean> {
    try {
        await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'])
        return true
    } catch {
        return false
    }
}

/**
 * Remove containers Miniflare would otherwise REUSE.
 *
 * Miniflare names a container after the worker and Durable Object class, not
 * after the image it was built from, and it restarts an existing container by
 * that name rather than recreating it. So a container left behind by an earlier
 * dev session — or by the previous version of an image you just edited — keeps
 * serving the OLD code, silently, with a freshly built image sitting unused on
 * disk. Removing the mismatched ones is what makes a rebuild take effect.
 */
export async function removeStaleContainers(
    workerName: string,
    containers: ContainerApp[],
    buildId: string,
    logger: ContainerLogger
): Promise<number> {
    let removed = 0
    for (const c of containers) {
        const expected = devImageName(c.class_name, buildId)
        const prefix = `workerd-${workerName}-${c.class_name}-`
        let stdout = ''
        try {
            ;({ stdout } = await execFileAsync('docker', [
                'ps',
                '-a',
                '--filter',
                `name=${prefix}`,
                '--format',
                '{{.ID}} {{.Image}}',
            ]))
        } catch {
            return removed
        }

        for (const line of stdout.split('\n')) {
            const [id, image] = line.trim().split(/\s+/)
            if (!id) continue
            if (image === expected) continue
            try {
                // Miniflare's own sidecar proxy shares the name prefix and is
                // caught by the same filter, which is what we want: leaving it
                // attached to a container that no longer exists is worse than
                // letting Miniflare recreate the pair.
                await execFileAsync('docker', ['rm', '-f', id])
                removed++
                logger.info(
                    `[cloudflare-monorepo] Removed container ${id} (${image}); it predates ${expected}, and Miniflare reuses containers by name rather than by image`
                )
            } catch (error) {
                logger.warn(
                    `[cloudflare-monorepo] Could not remove stale container ${id}:`,
                    error instanceof Error ? error.message : String(error)
                )
            }
        }
    }
    return removed
}

/**
 * Build every container image a worker declares, tagged the way Miniflare will
 * look for it, and clear away any container still running a different image.
 *
 * Returns the build id, or undefined when containers can't run — in which case
 * the caller must tell wrangler to disable them, because
 * `unstable_getMiniflareWorkerOptions` ASSERTS the value is present whenever
 * containers are declared and enabled.
 */
export async function buildContainerImages(
    containers: ContainerApp[],
    logger: ContainerLogger,
    workerName: string
): Promise<string | undefined> {
    if (process.platform === 'win32') {
        logger.warn(
            `[cloudflare-monorepo] ${workerName}: containers are unsupported on Windows (use WSL). Disabling them.`
        )
        return undefined
    }
    if (!(await dockerAvailable())) {
        logger.warn(
            `[cloudflare-monorepo] ${workerName}: Docker is not available, so its container(s) will not run. ` +
                `Routes that reach a container will fail.`
        )
        return undefined
    }

    // One id for the whole worker (wrangler does the same), derived from every
    // context so a change in any of them produces a new tag.
    const buildId = computeBuildId(containers)

    for (const c of containers) {
        const tag = devImageName(c.class_name, buildId)
        try {
            if (c.image_uri) {
                await execFileAsync('docker', ['pull', c.image_uri])
                await execFileAsync('docker', ['tag', c.image_uri, tag])
                continue
            }
            if (!c.image) continue
            const context = c.image_build_context || dirname(c.image)
            const args = ['build', '-t', tag, '-f', c.image, context]
            for (const [k, v] of Object.entries(c.image_vars || {})) {
                args.push('--build-arg', `${k}=${v}`)
            }
            logger.info(`[cloudflare-monorepo] Building container image ${tag}…`)
            await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 })
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            logger.error(`[cloudflare-monorepo] Failed to build ${tag}:`, detail)
            return undefined
        }
    }

    await removeStaleContainers(workerName, containers, buildId, logger)
    return buildId
}
