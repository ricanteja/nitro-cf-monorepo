// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

import type { NitroAppPlugin } from 'nitropack'
import type { Miniflare, WorkerOptions } from 'miniflare'
import { buildContainerImages, containerContextDirs, type ContainerApp } from './containers'
import type { BundledWorker, ResolvedMonorepoConfig } from '../types'

// ============================================================================
// Constants
// ============================================================================

const MAIN_WORKER_NAME = 'nitro-main'
const LOG_PREFIX = '[cloudflare-monorepo]'

/** Binding keys to copy from wrangler config to Miniflare worker options */
const BINDING_KEYS = [
    'durableObjects',
    // Worker-to-worker bindings. Without this, a `services` entry in
    // wrangler.jsonc deploys correctly but is simply absent from
    // `event.context.cloudflare.env` in dev — the aux worker gets bundled and
    // started, so the logs look right, and the binding is missing anyway.
    //
    // `unstable_getMiniflareWorkerOptions` already emits this in Miniflare's
    // shape (`{ BINDING: { name: 'worker-name' } }`), so it needs copying, not
    // converting.
    'serviceBindings',
    'compatibilityDate',
    'compatibilityFlags',
    'bindings',
    'kvNamespaces',
    'd1Databases',
    'r2Buckets',
    // How Miniflare reaches Docker. Per-worker (it lives in CoreOptionsSchema,
    // not the shared schema), and wrangler resolves it to the socket path.
    // Without it, a durable object's `container` option has no engine to run on.
    'containerEngine',
] as const

// ============================================================================
// Types
// ============================================================================

/** Type for chokidar FSWatcher - imported dynamically at runtime */
interface FSWatcher {
    close(): Promise<void>
    on(event: string, listener: (...args: unknown[]) => void): this
}

interface CloudflareProxy {
    env: Record<string, unknown>
    cf: Record<string, unknown>
    ctx: {
        waitUntil: (promise: Promise<unknown>) => void
        passThroughOnException: () => void
    }
    dispose: () => Promise<void>
}

// ============================================================================
// Helpers
// ============================================================================

/** Dynamic import that bypasses bundler analysis */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
) => Promise<unknown>

/** Copy binding properties from source to target */
function copyBindings(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const key of BINDING_KEYS) {
        if (source[key]) {
            target[key] = source[key]
        }
    }
}

// ============================================================================
// Module State
// ============================================================================

let hmrWatcher: FSWatcher | null = null
let miniflareInstance: Miniflare | null = null
let currentWorkers: Record<string, unknown>[] = []
let resolvedConfig: ResolvedMonorepoConfig | null = null
let proxyPromise: Promise<CloudflareProxy> | null = null

// Dynamic import cache for HMR
let esbuildModule: typeof import('esbuild') | null = null
let chokidarModule: { watch: (...args: unknown[]) => FSWatcher } | null = null

// Held from startup so a hot reload can recompute a worker's options without
// importing wrangler again.
let wranglerModule: typeof import('wrangler') | null = null
let fsModule: typeof import('node:fs') | null = null

// One rebuild at a time per worker. Editors write files in bursts, and two
// concurrent `docker build` runs against the same tag race each other.
const rebuildInFlight = new Set<string>()

/**
 * Bundle a worker entry point using esbuild.
 */
async function bundleWorker(entryPath: string): Promise<string> {
    if (!esbuildModule) {
        esbuildModule = (await dynamicImport('esbuild')) as typeof import('esbuild')
    }

    const result = await esbuildModule.build({
        entryPoints: [entryPath],
        bundle: true,
        format: 'esm',
        target: 'esnext',
        platform: 'neutral',
        conditions: ['workerd', 'worker', 'import'],
        external: ['cloudflare:*'],
        write: false,
    })
    return result.outputFiles[0].text
}

// Reference to the current proxy for refreshing after hot-swap
let currentProxy: CloudflareProxy | null = null

/**
 * Hot-swap a worker in Miniflare without restarting.
 */
async function hotSwapWorker(workerName: string, newScriptContent: string): Promise<void> {
    if (!miniflareInstance || !currentWorkers.length) {
        console.warn(`${LOG_PREFIX} Cannot hot-swap: Miniflare not ready`)
        return
    }

    // Find and update the worker in currentWorkers
    const workerIndex = currentWorkers.findIndex((w) => w.name === workerName)
    if (workerIndex === -1) {
        console.warn(`${LOG_PREFIX} Worker ${workerName} not found for hot-swap`)
        return
    }

    // Update the module content
    const updatedWorker = {
        ...currentWorkers[workerIndex],
        modules: [
            {
                type: 'ESModule',
                path: `/${workerName}/index.mjs`,
                contents: newScriptContent,
            },
        ],
    }
    currentWorkers[workerIndex] = updatedWorker

    // Call setOptions to hot-swap the worker
    // IMPORTANT: Must include defaultPersistRoot to maintain database state
    try {
        await miniflareInstance.setOptions({
            workers: currentWorkers as WorkerOptions[],
            defaultPersistRoot: resolvedConfig?.persistDir,
        })

        await refreshBindings()
        console.info(`${LOG_PREFIX} Hot-swapped worker: ${workerName}`)
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed to hot-swap worker ${workerName}:`, error)
    }
}

/**
 * Publish the address a browser opens its WebSocket to in development.
 *
 * This exists only because development splits the app across two processes:
 * Nitro serves HTTP from Node, and Node cannot return a workerd socket. There
 * is no equivalent deployed — there the entry that answers the upgrade is the
 * app worker itself, so the socket goes to the page's own origin.
 *
 * Read from `ready` EVERY time rather than once at startup, because Miniflare
 * rebinds its HTTP server when options change and comes back on a different
 * port. Publishing it once looked correct for as long as nothing hot-reloaded,
 * and then quietly handed out a dead address for the rest of the session: the
 * app went on working, because everything else reaches a worker through a
 * binding, and only the one thing a BROWSER connects to directly — the
 * WebSocket — was broken, with no error anywhere on the server to explain it.
 */
async function publishOrigin(): Promise<void> {
    if (!miniflareInstance) return
    try {
        const ready = await miniflareInstance.ready
        const origin = ready.origin
        const previous = (globalThis as Record<string, unknown>).__miniflareOrigin__
        ;(globalThis as Record<string, unknown>).__miniflareOrigin__ = origin
        if (previous && previous !== origin) {
            console.info(`${LOG_PREFIX} Socket origin moved to ${origin}`)
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Could not determine Miniflare's address:`, error)
    }
}

/**
 * Re-read bindings after a setOptions().
 *
 * Miniflare invalidates existing binding handles when options change, so
 * anything still holding the old ones gets an object that looks alive and is
 * not. Both hot-reload paths end here.
 */
async function refreshBindings(): Promise<void> {
    if (!miniflareInstance) return
    const bindings = await miniflareInstance.getBindings(MAIN_WORKER_NAME)
    ;(globalThis as Record<string, unknown>).__env__ = bindings
    if (currentProxy) {
        currentProxy.env = bindings as Record<string, unknown>
    }
    await publishOrigin()
}

/**
 * Rebuild a worker's container images and put the new ones into service.
 *
 * This is the container half of hot reload. Editing the code inside a container
 * has to go through a Docker build, and — critically — through removing the
 * container Miniflare is already running, because Miniflare reuses containers
 * by name and would otherwise keep serving the old image indefinitely. That is
 * handled inside buildContainerImages.
 *
 * The build id is a hash of the build context, so an edit that changes nothing
 * meaningful costs one cached `docker build` and stops there.
 */
async function reloadContainers(worker: BundledWorker): Promise<void> {
    if (!worker.containers?.length) return
    if (!miniflareInstance || !resolvedConfig || !wranglerModule || !fsModule) return
    if (rebuildInFlight.has(worker.name)) return

    rebuildInFlight.add(worker.name)
    try {
        if (worker.prepare) {
            const { execFile } = (await dynamicImport(
                'node:child_process'
            )) as typeof import('node:child_process')
            const { promisify } = (await dynamicImport('node:util')) as typeof import('node:util')
            try {
                await promisify(execFile)('sh', ['-c', worker.prepare], {
                    cwd: resolvedConfig.rootDir,
                    maxBuffer: 16 * 1024 * 1024,
                })
            } catch (error) {
                console.error(`${LOG_PREFIX} prepare failed for ${worker.name}:`, error)
            }
        }

        const logger = {
            info: (...args: unknown[]) => console.info(...(args as [unknown])),
            warn: (...args: unknown[]) => console.warn(...(args as [unknown])),
            error: (...args: unknown[]) => console.error(...(args as [unknown])),
        }
        const buildId = await buildContainerImages(
            worker.containers as ContainerApp[],
            logger,
            worker.name
        )

        if (!buildId) {
            console.warn(
                `${LOG_PREFIX} ${worker.name}: container rebuild failed, keeping the old image`
            )
            return
        }
        if (buildId === worker.containerBuildId) {
            console.info(`${LOG_PREFIX} ${worker.name}: container unchanged`)
            return
        }

        worker.containerBuildId = buildId
        worker.containersDisabled = false

        const index = currentWorkers.findIndex((w) => w.name === worker.name)
        if (index === -1) return
        currentWorkers[index] = await buildWorkerOptions(
            worker,
            resolvedConfig,
            wranglerModule,
            fsModule
        )

        await miniflareInstance.setOptions({
            workers: currentWorkers as WorkerOptions[],
            defaultPersistRoot: resolvedConfig.persistDir,
        })
        await refreshBindings()
        console.info(`${LOG_PREFIX} Reloaded container for ${worker.name} (${buildId})`)
    } catch (error) {
        console.error(`${LOG_PREFIX} Container reload failed for ${worker.name}:`, error)
    } finally {
        rebuildInFlight.delete(worker.name)
    }
}

/**
 * Set up HMR file watching for auxiliary workers.
 */
async function setupHMRWatcher(): Promise<void> {
    if (!resolvedConfig?.bundledWorkers?.length) {
        return
    }

    // Import chokidar for file watching
    // Use createRequire to resolve from the project's node_modules
    if (!chokidarModule) {
        try {
            const { createRequire } = (await dynamicImport(
                'node:module'
            )) as typeof import('node:module')
            const projectRequire = createRequire(resolvedConfig.rootDir + '/package.json')
            const chokidarPath = projectRequire.resolve('chokidar')
            chokidarModule = (await dynamicImport(chokidarPath)) as typeof chokidarModule
        } catch (err) {
            console.warn(`${LOG_PREFIX} Chokidar not available, HMR disabled:`, err)
            return
        }
    }

    // Two kinds of directory get watched, and a change in each means something
    // completely different: editing a worker's source re-bundles JavaScript in
    // milliseconds, while editing a container's source needs a Docker build and
    // a container replacement.
    const watchPaths: string[] = []
    const containerDirs: { dir: string; worker: BundledWorker }[] = []

    for (const worker of resolvedConfig.bundledWorkers) {
        const lastSlash = worker.entryPath.lastIndexOf('/')
        watchPaths.push(lastSlash > 0 ? worker.entryPath.substring(0, lastSlash) : worker.entryPath)
        for (const dir of containerContextDirs((worker.containers ?? []) as ContainerApp[])) {
            watchPaths.push(dir)
            containerDirs.push({ dir, worker })
        }
    }

    // Create a map from file paths to worker info for quick lookup
    const entryToWorker = new Map<string, BundledWorker>()
    for (const worker of resolvedConfig.bundledWorkers) {
        entryToWorker.set(worker.entryPath, worker)
    }

    // Set up the watcher
    hmrWatcher = chokidarModule!.watch(watchPaths, {
        ignoreInitial: true,
        ignored: ['**/node_modules/**', '**/.git/**'],
    })

    hmrWatcher.on('change', async (filePath: unknown) => {
        const changedPath = filePath as string
        console.info(`${LOG_PREFIX} File changed: ${changedPath}`)

        // Container contexts are checked FIRST. A build context can legitimately
        // sit inside the directory holding the worker's own sources, and
        // re-bundling the worker would not pick up a change to the image.
        const container = containerDirs.find((c) => changedPath.startsWith(c.dir))
        if (container) {
            await reloadContainers(container.worker)
            return
        }

        // Find which worker this file belongs to
        let affectedWorker: BundledWorker | undefined

        // Check if it's a direct entry file
        if (entryToWorker.has(changedPath)) {
            affectedWorker = entryToWorker.get(changedPath)
        } else {
            // Check if the file is in any worker's directory
            for (const worker of resolvedConfig!.bundledWorkers) {
                const workerDir = worker.entryPath.substring(0, worker.entryPath.lastIndexOf('/'))
                if (changedPath.startsWith(workerDir)) {
                    affectedWorker = worker
                    break
                }
            }
        }

        if (!affectedWorker) {
            console.warn(
                `${LOG_PREFIX} Changed file not associated with any worker: ${changedPath}`
            )
            return
        }

        // Rebundle and hot-swap
        try {
            console.info(`${LOG_PREFIX} Rebundling worker: ${affectedWorker.name}`)
            const newScript = await bundleWorker(affectedWorker.entryPath)
            await hotSwapWorker(affectedWorker.name, newScript)
        } catch (error) {
            console.error(`${LOG_PREFIX} HMR error for ${affectedWorker.name}:`, error)
        }
    })

    console.info(
        `${LOG_PREFIX} HMR watching ${resolvedConfig.bundledWorkers.length} worker(s)` +
            (containerDirs.length > 0 ? ` and ${containerDirs.length} container context(s)` : '')
    )
}

/**
 * Build worker options for a bundled worker.
 */
async function buildWorkerOptions(
    bundledWorker: BundledWorker,
    config: ResolvedMonorepoConfig,
    wrangler: typeof import('wrangler'),
    fs: typeof import('node:fs')
): Promise<Record<string, unknown>> {
    // Read the worker's wrangler config to get its settings
    const workerConfig = wrangler.unstable_readConfig(
        { config: bundledWorker.configPath, env: config.environment },
        {}
    )

    // containerBuildId is what turns a container declaration into a real image
    // name (`cloudflare-dev/<class>:<id>`) on the durable object. Wrangler
    // ASSERTS it is present whenever containers are declared and enabled, so a
    // worker whose images we could not build must explicitly disable them —
    // otherwise this throws and the worker vanishes from Miniflare entirely.
    const miniflareOpts = wrangler.unstable_getMiniflareWorkerOptions(
        workerConfig,
        config.environment,
        bundledWorker.containersDisabled
            ? { overrides: { enableContainers: false } }
            : { containerBuildId: bundledWorker.containerBuildId }
    )
    const workerOpts = miniflareOpts.workerOptions as Record<string, unknown>

    // Read the bundled script content
    const scriptContent = fs.readFileSync(bundledWorker.scriptPath, 'utf-8')

    const cleanOpts: Record<string, unknown> = {
        name: bundledWorker.name,
        modules: [
            {
                type: 'ESModule',
                path: `/${bundledWorker.name}/index.mjs`,
                contents: scriptContent,
            },
        ],
        modulesRoot: '/',
    }

    // Copy settings from wrangler config
    copyBindings(cleanOpts, workerOpts)

    return cleanOpts
}

/**
 * Get or create the unified Miniflare proxy.
 */
async function getProxy(): Promise<CloudflareProxy> {
    if (proxyPromise) {
        return proxyPromise
    }

    proxyPromise = createProxy()
    return proxyPromise
}

/**
 * Create the unified Miniflare instance with all workers.
 */
async function createProxy(): Promise<CloudflareProxy> {
    // Get config from environment variable
    const configJson = process.env.NITRO_CLOUDFLARE_MONOREPO_CONFIG
    if (!configJson) {
        console.warn(`${LOG_PREFIX} No config found, using stub proxy`)
        return createStubProxy()
    }

    resolvedConfig = JSON.parse(configJson) as ResolvedMonorepoConfig

    // A project with NO auxiliary workers is a perfectly ordinary case — a Nuxt
    // app that just wants its own D1 and R2 in dev — and it used to land here
    // on a stub proxy with an empty env, so every binding silently came back
    // undefined. Only bail when there is nothing to build a Miniflare instance
    // out of at all: no aux workers AND no main wrangler config.
    if (!resolvedConfig.configPath && !resolvedConfig.bundledWorkers?.length) {
        console.warn(
            `${LOG_PREFIX} No wrangler config and no auxiliary workers found, using stub proxy`
        )
        return createStubProxy()
    }

    // Dynamic imports to avoid bundling issues
    const wrangler = (await dynamicImport('wrangler')) as typeof import('wrangler')
    const { Miniflare } = (await dynamicImport('miniflare')) as typeof import('miniflare')
    const fs = (await dynamicImport('node:fs')) as typeof import('node:fs')
    wranglerModule = wrangler
    fsModule = fs

    // Build worker options for each bundled worker
    currentWorkers = []

    // Read the main worker config to get its bindings (including DO references)
    let mainWorkerBindings: Record<string, unknown> = {}
    if (resolvedConfig.configPath) {
        try {
            const mainConfig = wrangler.unstable_readConfig(
                { config: resolvedConfig.configPath, env: resolvedConfig.environment },
                {}
            )
            const mainOpts = wrangler.unstable_getMiniflareWorkerOptions(
                mainConfig,
                resolvedConfig.environment
            )
            mainWorkerBindings = mainOpts.workerOptions as Record<string, unknown>
        } catch (error) {
            console.warn(`${LOG_PREFIX} Failed to read main config:`, error)
        }
    }

    // The stub main worker exists to carry the app's bindings, and is the only
    // thing listening on Miniflare's HTTP port. Nitro serves every ordinary
    // request from Node, so the one thing this has to answer is the one thing
    // Node cannot: a WebSocket upgrade, which needs a workerd `WebSocketPair`
    // and a 101 that survives being returned.
    //
    // It answers it with the app's OWN upgrade module — the same file the
    // deployed entry is given — so a socket takes the same route through the
    // same binding in both environments. An auxiliary worker stays reachable
    // only through a binding here exactly as it is in production; nothing gets
    // an address of its own.
    let upgradeScript: string | undefined
    if (resolvedConfig.upgradeScriptPath) {
        try {
            upgradeScript = fs.readFileSync(resolvedConfig.upgradeScriptPath, 'utf-8')
        } catch (error) {
            console.error(`${LOG_PREFIX} Could not read the bundled upgrade module:`, error)
        }
    }

    const routerScript = upgradeScript
        ? `
        import upgrade from "./__upgrade.mjs";
        export default {
            async fetch(request, env, ctx) {
                if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
                    const answered = await upgrade(request, env, ctx);
                    if (answered) return answered;
                }
                return new Response("Nitro handles requests", { status: 200 });
            }
        }`
        : `
        export default {
            fetch() { return new Response("Nitro handles requests", { status: 200 }); }
        }`

    const mainWorkerModules: Array<Record<string, unknown>> = [
        {
            type: 'ESModule',
            path: `/${MAIN_WORKER_NAME}/index.mjs`,
            contents: routerScript,
        },
    ]
    if (upgradeScript) {
        mainWorkerModules.push({
            type: 'ESModule',
            path: `/${MAIN_WORKER_NAME}/__upgrade.mjs`,
            contents: upgradeScript,
        })
    }

    const mainWorkerCleanOpts: Record<string, unknown> = {
        name: MAIN_WORKER_NAME,
        modules: mainWorkerModules,
        modulesRoot: '/',
    }

    // Copy bindings from main config
    copyBindings(mainWorkerCleanOpts, mainWorkerBindings)

    currentWorkers.push(mainWorkerCleanOpts)

    // Add auxiliary workers
    for (const bundledWorker of resolvedConfig.bundledWorkers) {
        try {
            const workerOpts = await buildWorkerOptions(bundledWorker, resolvedConfig, wrangler, fs)
            currentWorkers.push(workerOpts)
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to configure worker ${bundledWorker.name}:`, error)
        }
    }

    if (currentWorkers.length === 0) {
        console.warn(`${LOG_PREFIX} No workers configured`)
        return createStubProxy()
    }

    // A service binding pointing at a worker Miniflare does not have is fatal at
    // startup, and the error names the binding rather than the reason — so one
    // service that lives outside the monorepo would take the whole dev server
    // down. Drop those and say so; the rest of dev still works.
    const knownWorkers = new Set(currentWorkers.map((w) => w.name as string))
    for (const worker of currentWorkers) {
        const bindings = worker.serviceBindings as Record<string, { name?: string }> | undefined
        if (!bindings) continue
        for (const [bindingName, target] of Object.entries(bindings)) {
            if (target?.name && !knownWorkers.has(target.name)) {
                console.warn(
                    `${LOG_PREFIX} ${worker.name}: dropping service binding ${bindingName} -> ` +
                        `"${target.name}" (not bundled locally). It will still work when deployed.`
                )
                delete bindings[bindingName]
            }
        }
    }

    console.info(
        `${LOG_PREFIX} Started Miniflare with ${currentWorkers.length} worker(s):\n\t-`,
        currentWorkers.map((w) => w.name).join('\n\t- ')
    )

    // Create unified Miniflare instance
    miniflareInstance = new Miniflare({
        workers: currentWorkers as WorkerOptions[],
        defaultPersistRoot: resolvedConfig.persistDir,
    })

    // Miniflare's HTTP address, published so the app can tell a browser where
    // to open a WebSocket in development. Deployed there is nothing to publish:
    // the socket goes to the app's own origin, because the entry that answers
    // it IS the app worker.
    await publishOrigin()
    if (resolvedConfig.upgradeScriptPath) {
        console.info(
            `${LOG_PREFIX} WebSocket origin: ` +
                `${(globalThis as Record<string, unknown>).__miniflareOrigin__}`
        )
    }

    // Get bindings from the main worker
    const bindings = await miniflareInstance.getBindings(MAIN_WORKER_NAME)

    // Store env globally for shims
    ;(globalThis as Record<string, unknown>).__env__ = bindings

    // Set up HMR file watching for auxiliary workers
    setupHMRWatcher().catch((err) => {
        console.error(`${LOG_PREFIX} Failed to set up HMR:`, err)
    })

    // Create and store the proxy - currentProxy is used by hotSwapWorker to refresh bindings
    currentProxy = {
        env: bindings as Record<string, unknown>,
        cf: {},
        ctx: {
            waitUntil: () => {},
            passThroughOnException: () => {},
        },
        dispose: async () => {
            if (miniflareInstance) {
                await miniflareInstance.dispose()
                miniflareInstance = null
            }
        },
    }

    return currentProxy
}

/**
 * Create a stub proxy when no config is available.
 */
function createStubProxy(): CloudflareProxy {
    return {
        env: {},
        cf: {},
        ctx: {
            waitUntil: () => {},
            passThroughOnException: () => {},
        },
        dispose: () => Promise.resolve(),
    }
}

/**
 * Nitro plugin that injects Cloudflare bindings into request context.
 * Uses the onRequest hook from nitro app which properly supports async handlers.
 */
const cloudflareMonorepoPlugin: NitroAppPlugin = (nitroApp) => {
    // Initialize proxy eagerly
    const initPromise = getProxy().catch((err) => {
        console.error(`${LOG_PREFIX} Failed to initialize proxy:`, err)
        return null
    })

    // Use the onRequest hook to inject bindings before any handler runs
    // This hook is called for every request and properly supports async
    nitroApp.hooks.hook('request', async (event) => {
        try {
            const proxy = await initPromise

            if (proxy) {
                // Set up cloudflare context - this is what Nitro's cloudflare runtime expects
                event.context.cloudflare = {
                    env: proxy.env,
                    cf: proxy.cf,
                    context: proxy.ctx,
                }

                // Also set waitUntil directly on context for convenience
                event.context.waitUntil = proxy.ctx.waitUntil
            }
        } catch (err) {
            console.error(`${LOG_PREFIX} Error in request hook:`, err)
        }
    })

    // Clean up on close
    nitroApp.hooks.hook('close', async () => {
        // Close HMR watcher
        if (hmrWatcher) {
            await hmrWatcher.close()
            hmrWatcher = null
        }

        // Dispose Miniflare
        if (proxyPromise) {
            const proxy = await proxyPromise
            await proxy.dispose()
            proxyPromise = null
            miniflareInstance = null
            currentWorkers = []
            resolvedConfig = null
        }
    })
}

export default cloudflareMonorepoPlugin
