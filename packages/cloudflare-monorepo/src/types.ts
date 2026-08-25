// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

/**
 * Configuration for an auxiliary worker in the monorepo.
 */
export interface AuxiliaryWorkerConfig {
    /**
     * Path to the wrangler.json/wrangler.jsonc/wrangler.toml config file.
     * Can be relative to the Nitro root directory.
     */
    configPath: string

    /**
     * Optional name override for the worker.
     * If not provided, the name from the wrangler config will be used.
     */
    name?: string

    /**
     * Shell command run once, before this worker's container image is built.
     * Use it for build steps the Dockerfile can't do itself — e.g. syncing
     * generated assets into the build context. Runs from the Nitro root dir.
     * Ignored for workers that declare no containers.
     */
    prepare?: string
}

/**
 * Configuration options for the cloudflare-monorepo preset.
 */
export interface CloudflareMonorepoOptions {
    /**
     * List of auxiliary workers to include in the local development environment.
     * Each worker will be loaded into the shared Miniflare instance.
     */
    workers?: AuxiliaryWorkerConfig[]

    /**
     * Directory to persist Miniflare state (D1, KV, R2, etc.).
     * @default ".wrangler/state/v3"
     */
    persistDir?: string

    /**
     * Cloudflare environment to use (for wrangler config environments).
     */
    environment?: string

    /**
     * Path to the main wrangler config file.
     * If not provided, will auto-detect wrangler.json/wrangler.jsonc/wrangler.toml.
     */
    configPath?: string

    /**
     * Module that answers WebSocket upgrades, relative to the Nitro root.
     *
     * A browser cannot hold a binding, so anything it needs to talk to has to
     * be reachable over HTTP. Giving an auxiliary worker its own hostname to
     * satisfy that is a second public surface, and the wrong answer: the app
     * worker already holds bindings to every one of them.
     *
     * The obstacle is that Nitro rebuilds every HANDLER's return value into a
     * fresh `Response`, and `new Response(null, { status: 101 })` throws, so an
     * upgrade cannot be answered from a route. This module is invoked ABOVE
     * Nitro — from the worker entry in production, and from the Miniflare main
     * worker in development — where whatever it returns is what the runtime
     * sends, 101 included.
     *
     * Its default export receives the request and the environment, and returns
     * a `Response` to answer the upgrade or `undefined` to let Nitro handle the
     * request normally:
     *
     * ```ts
     * export default function (request: Request, env: Env) {
     *     const match = /^\/api\/rooms\/([^/]+)\/socket$/.exec(new URL(request.url).pathname)
     *     if (!match) return
     *     return env.ROOM.get(env.ROOM.idFromName(match[1])).fetch(request)
     * }
     * ```
     *
     * Only requests carrying `Upgrade: websocket` reach it.
     */
    upgrade?: string
}

/**
 * Information about a bundled auxiliary worker.
 */
export interface BundledWorker {
    /** Path to the wrangler config file */
    configPath: string
    /**
     * Container applications this worker declares, carried through from its
     * wrangler config so the dev runtime can rebuild them without re-reading it.
     */
    containers?: {
        class_name: string
        image?: string
        image_uri?: string
        image_build_context?: string
        image_vars?: Record<string, string>
    }[]
    /** Shell command to run before rebuilding this worker's container images. */
    prepare?: string
    /** Worker name */
    name: string
    /** Path to the bundled script file */
    scriptPath: string
    /** Original entry point path (for HMR rebundling) */
    entryPath: string
    /**
     * Tag of the container image(s) built for this worker, if it declares any.
     * Wrangler derives the image name Miniflare looks for from this
     * (`cloudflare-dev/<class_name>:<containerBuildId>`), and it ASSERTS the
     * value is present whenever containers are declared and enabled — so this
     * being undefined for a container worker means containers are off.
     */
    containerBuildId?: string
    /** True when the worker declares containers but we could not build them. */
    containersDisabled?: boolean
}

/**
 * Resolved configuration passed to the runtime plugin.
 */
export interface ResolvedMonorepoConfig {
    configPath: string | undefined
    persistDir: string
    environment: string | undefined
    rootDir: string
    workers: Array<{
        configPath: string
        name: string | undefined
    }>
    bundledWorkers: BundledWorker[]
    /**
     * Path to the bundled `upgrade` module, or undefined when the app declares
     * none. Bundled at build time so the Miniflare main worker can hold the
     * same code the deployed entry does.
     */
    upgradeScriptPath?: string
}

// Extend NitroConfig to include our options
declare module 'nitropack' {
    interface NitroConfig {
        cloudflareMonorepo?: CloudflareMonorepoOptions
    }

    interface NitroOptions {
        cloudflareMonorepo?: CloudflareMonorepoOptions
    }

    interface NitroRuntimeConfig {
        cloudflareMonorepo?: ResolvedMonorepoConfig
    }
}
