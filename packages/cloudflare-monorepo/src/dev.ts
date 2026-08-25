// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { resolve, dirname, join } from 'pathe'
import type { Nitro } from 'nitropack'
import { buildContainerImages, type ContainerApp } from './runtime/containers'
import type { BundledWorker, ResolvedMonorepoConfig } from './types'

const LOG_PREFIX = '[cloudflare-monorepo]'
const execFileAsync = promisify(execFile)

/**
 * Find a wrangler config file in the given directory.
 */
async function findWranglerConfig(dir: string): Promise<string | undefined> {
    const candidates = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']
    for (const name of candidates) {
        const configPath = resolve(dir, name)
        if (existsSync(configPath)) {
            return configPath
        }
    }
    return undefined
}

/**
 * Bundle a worker entry point using esbuild.
 * Uses createRequire to resolve from the project's node_modules.
 */
async function bundleWorker(entryPath: string, rootDir: string): Promise<string> {
    // Create a require function that resolves from the project root
    // This allows us to find esbuild in the project's node_modules
    const projectRequire = createRequire(join(rootDir, 'package.json'))
    const esbuildPath = projectRequire.resolve('esbuild')

    // Dynamic import the resolved path
    const esbuild = (await import(esbuildPath)) as typeof import('esbuild')
    const result = await esbuild.build({
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

/**
 * Path of Nitro's own Cloudflare dev plugin, which we replace.
 *
 * Nitro 2.13 ships a `cloudflare-dev` preset that every cloudflare preset falls
 * back to in development, and it starts a Miniflare instance of its own through
 * `getPlatformProxy`. Ours is already running, holding the auxiliary workers and
 * the cross-script Durable Object binding that the built-in one cannot know
 * about — so leaving both in place means two workerd processes, two emulators
 * opening the SAME sqlite files under `.wrangler/state`, and a request hook race
 * deciding which set of bindings the app actually sees.
 *
 * Only the PLUGIN is removed. The rest of what that preset does — the
 * `cloudflare:workers` dev shim, the esbuild target — is still wanted.
 */
const BUILTIN_DEV_PLUGIN = /presets[/\\]cloudflare[/\\]runtime[/\\]plugin\.dev/

function replaceBuiltinEmulation(nitro: Nitro): void {
    const drop = () => {
        const plugins = nitro.options.plugins || []
        const kept = plugins.filter((p) => !BUILTIN_DEV_PLUGIN.test(String(p)))
        const removed = plugins.length - kept.length
        nitro.options.plugins = kept
        return removed
    }
    const announce = (removed: number) => {
        if (removed > 0) {
            nitro.logger.info(
                `${LOG_PREFIX} Replaced Nitro's built-in Cloudflare dev emulation ` +
                    `(it would start a second Miniflare against the same state directory)`
            )
        }
    }
    announce(drop())
    // Module order is not something to rely on: the built-in preset may add its
    // plugin after this module has run. `build:before` is the LAST hook that
    // still matters — Nitro turns the plugin list into a virtual module in
    // `getRollupConfig`, which runs immediately after it, so anything removed at
    // `rollup:before` has already been baked into the bundle.
    nitro.hooks.hook('build:before', () => announce(drop()))
}

/**
 * Dev module for Cloudflare monorepo preset.
 * Sets up the unified Miniflare instance with all workers.
 */
export async function cloudflareMonorepoDevModule(nitro: Nitro): Promise<void> {
    if (!nitro.options.dev) {
        return // Only for development
    }

    const logger = nitro.logger
    const rootDir = nitro.options.rootDir
    const config = nitro.options.cloudflareMonorepo || {}

    replaceBuiltinEmulation(nitro)

    // Check for wrangler
    let wrangler: typeof import('wrangler')
    try {
        wrangler = await import('wrangler')
    } catch {
        logger.warn(
            `${LOG_PREFIX} Wrangler is not installed. Run \`pnpm add -D wrangler\` to enable Cloudflare dev emulation.`
        )
        return
    }

    // Check for miniflare
    try {
        await import('miniflare')
    } catch {
        logger.warn(
            `${LOG_PREFIX} Miniflare is not installed. Run \`pnpm add -D miniflare\` to enable Cloudflare dev emulation.`
        )
        return
    }

    // Find main wrangler config
    let configPath = config.configPath
    if (!configPath) {
        configPath = await findWranglerConfig(rootDir)
    } else {
        configPath = resolve(rootDir, configPath)
    }

    // Resolve persist directory
    const persistDir = resolve(rootDir, config.persistDir || '.wrangler/state/v3')

    // Create temp directory for bundled workers
    const tempDir = resolve(persistDir, 'bundled-workers')
    if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true })
    }

    // Resolve and bundle auxiliary workers
    const bundledWorkers: BundledWorker[] = []

    for (const workerConfig of config.workers || []) {
        const workerConfigPath = resolve(rootDir, workerConfig.configPath)

        if (!existsSync(workerConfigPath)) {
            logger.error(`${LOG_PREFIX} Auxiliary worker config not found: ${workerConfigPath}`)
            continue
        }

        try {
            // Read the wrangler config to get the main entry
            const wranglerConfig = wrangler.unstable_readConfig(
                { config: workerConfigPath, env: config.environment },
                {}
            )

            const workerName =
                workerConfig.name || wranglerConfig.name || `aux-worker-${bundledWorkers.length}`

            // Get the main entry point
            let entryPath = wranglerConfig.main
            if (entryPath) {
                entryPath = resolve(dirname(workerConfigPath), entryPath)
            }

            if (!entryPath || !existsSync(entryPath)) {
                logger.error(
                    `${LOG_PREFIX} Worker entry point not found for ${workerName}: ${entryPath}`
                )
                continue
            }

            // Bundle the worker
            const script = await bundleWorker(entryPath, rootDir)

            // Write bundled script to temp file
            const scriptPath = resolve(tempDir, `${workerName}.mjs`)
            await writeFile(scriptPath, script, 'utf-8')

            // Containers are Docker images, so nothing in the bundling path
            // produces them — wrangler's own dev loop builds them and passes
            // the tag to Miniflare. Do the same here, or Miniflare gets a
            // durable object with no container behind it.
            const containers = (wranglerConfig.containers || []) as ContainerApp[]
            let containerBuildId: string | undefined
            if (containers.length && wranglerConfig.dev?.enable_containers !== false) {
                if (workerConfig.prepare) {
                    // Build steps the Dockerfile can't do itself — typically
                    // syncing generated assets into the build context. Must run
                    // BEFORE the hash, or the tag reflects pre-sync inputs.
                    logger.info(`${LOG_PREFIX} ${workerName}: ${workerConfig.prepare}`)
                    try {
                        await execFileAsync('sh', ['-c', workerConfig.prepare], {
                            cwd: rootDir,
                            maxBuffer: 16 * 1024 * 1024,
                        })
                    } catch (error) {
                        logger.error(
                            `${LOG_PREFIX} prepare failed for ${workerName}:`,
                            error instanceof Error ? error.message : String(error)
                        )
                    }
                }
                containerBuildId = await buildContainerImages(containers, logger, workerName)
            }

            bundledWorkers.push({
                configPath: workerConfigPath,
                name: workerName,
                scriptPath,
                entryPath,
                containers,
                prepare: workerConfig.prepare,
                containerBuildId,
                containersDisabled: containers.length > 0 && !containerBuildId,
            })

            logger.info(`${LOG_PREFIX} Bundling aux worker: ${workerName}`)
        } catch (error) {
            logger.error(`${LOG_PREFIX} Failed to bundle worker ${workerConfigPath}:`, error)
        }
    }

    // THE SAME MODULE THE DEPLOYED ENTRY USES.
    //
    // In production this is aliased into the worker entry, above Nitro, where a
    // 101 survives. Development has the same constraint for the same reason —
    // the Nitro dev server is Node and cannot return a workerd WebSocket — so
    // the module is bundled into Miniflare's main worker and invoked there. One
    // rule, one binding, both environments; the only thing that differs is the
    // origin the browser addresses, because in development the workers run in a
    // separate process from the app server.
    let upgradeScriptPath: string | undefined
    if (config.upgrade) {
        const upgradeEntry = resolve(rootDir, config.upgrade)
        if (!existsSync(upgradeEntry)) {
            logger.error(`${LOG_PREFIX} upgrade module not found: ${upgradeEntry}`)
        } else {
            try {
                const script = await bundleWorker(upgradeEntry, rootDir)
                upgradeScriptPath = resolve(tempDir, '__upgrade.mjs')
                await writeFile(upgradeScriptPath, script, 'utf-8')
                logger.info(`${LOG_PREFIX} WebSocket upgrades: ${config.upgrade}`)
            } catch (error) {
                logger.error(`${LOG_PREFIX} Failed to bundle upgrade module:`, error)
            }
        }
    }

    // Create resolved config for runtime
    const resolvedConfig: ResolvedMonorepoConfig = {
        configPath,
        persistDir,
        environment: config.environment,
        rootDir,
        workers: (config.workers || []).map((w) => ({
            configPath: resolve(rootDir, w.configPath),
            name: w.name,
        })),
        bundledWorkers,
        upgradeScriptPath,
    }

    // Pass config to runtime via environment variable
    // (runtimeConfig gets serialized oddly, env var is more reliable)
    process.env.NITRO_CLOUDFLARE_MONOREPO_CONFIG = JSON.stringify(resolvedConfig)

    // Get the path to our runtime plugin
    const pluginPath = new URL('./runtime/plugin.dev.mjs', import.meta.url).pathname

    // Add our plugin first in the chain
    nitro.options.plugins = nitro.options.plugins || []
    nitro.options.plugins.unshift(pluginPath)

    // Add .wrangler to gitignore if needed
    const gitIgnorePath = resolve(rootDir, '.gitignore')
    if (existsSync(gitIgnorePath)) {
        const gitIgnore = await readFile(gitIgnorePath, 'utf8')
        if (!gitIgnore.includes('.wrangler')) {
            await writeFile(gitIgnorePath, gitIgnore + '\n.wrangler\n').catch(() => {})
        }
    }

    logger.success(`${LOG_PREFIX} Bundled ${bundledWorkers.length} auxiliary worker(s)`)
}
