#!/usr/bin/env node
/**
 * Print the name a wrangler config gives one of its resources.
 *
 * Usage: resource-name.mjs <config> <environment> <d1|r2>
 *
 * WHY THIS EXISTS. CI has to know what a preview's database is called before it
 * can create one, and it used to work that out by rebuilding the string —
 * `d1-${PREFIX}-pr-${PR}` in a shell script, next to a wrangler config that
 * separately declared `d1-[[PREFIX]]-pr-[[PR_NUM]]`. Two copies of one naming
 * convention, and changing the config alone would have CI provision resources
 * the deployed worker does not bind.
 *
 * So the config is asked instead, through wrangler's OWN parser — the same
 * `unstable_readConfig` the deploy uses, which means environment inheritance and
 * JSONC are resolved exactly as they will be at deploy time rather than by a
 * second implementation of the same rules.
 *
 * Run it against a config whose `[[PREFIX]]`/`[[PR_NUM]]` have already been
 * substituted; see scripts/wrangler-env.sh.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const [config, environment, kind] = process.argv.slice(2)
if (!config || !environment || !kind) {
    console.error('usage: resource-name.mjs <config> <environment> <d1|r2>')
    process.exit(1)
}

// Resolved from the working directory rather than from this file: wrangler is a
// dependency of the workspace package being deployed, and pnpm does not hoist
// it somewhere a script in scripts/ could find on its own.
const require = createRequire(resolve(process.cwd(), 'package.json'))
const { unstable_readConfig } = await import(pathToFileURL(require.resolve('wrangler')).href)

const parsed = unstable_readConfig({ config, env: environment }, {})
const name =
    kind === 'd1'
        ? parsed.d1_databases?.[0]?.database_name
        : kind === 'r2'
          ? parsed.r2_buckets?.[0]?.bucket_name
          : undefined

if (!name) {
    console.error(`::error::no ${kind} binding in ${config} for environment ${environment}`)
    process.exit(1)
}
process.stdout.write(name)
