// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'pathe'
import type { Nitro } from 'nitropack'
import { cloudflareMonorepoDevModule } from './dev'

export type { CloudflareMonorepoOptions as PresetOptions } from './types'

const LOG_PREFIX = '[cloudflare-monorepo]'

/** Absolute path to one of this package's built runtime modules. */
function runtimeFile(name: string): string {
    return fileURLToPath(new URL(`./runtime/${name}`, import.meta.url))
}

/** Find a wrangler config file in the given directory */
function findWranglerConfig(dir: string): string | undefined {
    const candidates = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
    for (const name of candidates) {
        const configPath = resolve(dir, name)
        if (existsSync(configPath)) {
            return configPath
        }
    }
    return undefined
}

/**
 * Cloudflare monorepo preset config.
 *
 * NOTE: Due to Nitro's preset resolution limitations, external packages cannot
 * fully replace built-in presets. In dev mode, Nitro resolves presets via an
 * internal registry before loading external packages, ignoring custom presets.
 *
 * Usage in nuxt.config.ts requires both preset and extends:
 *   preset: 'cloudflare-module',           // Production: WASM + Cloudflare config
 *   extends: ['nitro-cloudflare-monorepo'],  // Dev module + compiled hooks
 */
export const cloudflareMonorepo = {
    // Dev module handles its own dev/prod detection internally
    modules: [cloudflareMonorepoDevModule],
    hooks: {
        // Use build:before instead of compiled - writeBuildInfo runs before compiled hook
        // so our command changes wouldn't be persisted to nitro.json
        'build:before': async (nitro: Nitro) => {
            // Skip preview command generation in dev mode
            if (nitro.options.dev) {
                return
            }

            const config = nitro.options.cloudflareMonorepo || {}

            // REPLACE THE WORKER ENTRY.
            //
            // `build:before` fires immediately before getRollupConfig() reads
            // options.entry, so this is both the last point at which it can be
            // changed and the earliest that does not depend on how an external
            // preset's config merges with the built-in one. Setting `entry` as
            // a preset field instead would depend on that merge order.
            //
            // The entry wraps nitropack's, adding one branch: a WebSocket
            // upgrade is answered above Nitro, where a 101 survives. See
            // runtime/entry.prod.ts.
            nitro.options.entry = runtimeFile('entry.prod.mjs')

            // What that branch calls. An app declaring no `upgrade` module gets
            // one that returns nothing, so the entry needs no build-time
            // conditionals and behaves exactly like nitropack's.
            const upgradeModule = config.upgrade
                ? resolve(nitro.options.rootDir, config.upgrade)
                : runtimeFile('upgrade.noop.mjs')
            if (config.upgrade && !existsSync(upgradeModule)) {
                throw new Error(
                    `${LOG_PREFIX} cloudflareMonorepo.upgrade does not exist: ${upgradeModule}`
                )
            }
            nitro.options.alias = {
                ...nitro.options.alias,
                '#cloudflare-monorepo/upgrade': upgradeModule,
            }
            if (config.upgrade) {
                console.info(`${LOG_PREFIX} WebSocket upgrades: ${config.upgrade}`)
            }

            const workers = config.workers || []

            const outputDir = nitro.options.output.dir
            const configFlags: string[] = []

            const mainConfigPath = config.configPath || findWranglerConfig(nitro.options.rootDir)
            if (mainConfigPath) {
                const absoluteMainPath = resolve(nitro.options.rootDir, mainConfigPath)
                const relativeMainPath = relative(outputDir, absoluteMainPath)
                configFlags.push(`-c ${relativeMainPath}`)
            }

            for (const worker of workers) {
                const absolutePath = resolve(nitro.options.rootDir, worker.configPath)
                const relativePath = relative(outputDir, absolutePath)
                configFlags.push(`-c ${relativePath}`)
            }

            if (configFlags.length > 0) {
                nitro.options.commands.preview = `npx wrangler dev ${configFlags.join(' ')}`
                console.info(`${LOG_PREFIX} Preview command: ${nitro.options.commands.preview}`)
            }
        },
    },
}

// Legacy export for backwards compatibility
export const cloudflareMonorepoDev = cloudflareMonorepo

/**
 * Default export - the preset object.
 * This is what gets used when you set `preset: 'nitro-cloudflare-monorepo'`
 */
export default cloudflareMonorepo
