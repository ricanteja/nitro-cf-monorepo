// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

/**
 * The deployed worker entry.
 *
 * Wraps nitropack's own cloudflare-module entry rather than reimplementing it,
 * so asset serving and the `scheduled` / `queue` / `email` / `tail` handlers
 * keep whatever behaviour the installed nitropack gives them. The only thing
 * added is a branch for WebSocket upgrades.
 *
 * WHY THE BRANCH HAS TO BE HERE. Nitro rebuilds every handler's return value
 * into a fresh `Response`, and `new Response(null, { status: 101 })` throws —
 * so an upgrade can never be answered from a Nitro route, no matter how it is
 * written. The worker entry is upstream of that: what it returns is what the
 * runtime sends. nitropack's own entry already relies on this, branching on
 * `Upgrade: websocket` in the same place for crossws.
 *
 * The alternative — giving the Durable Object's worker a public hostname so the
 * browser can reach it directly — costs a second public surface, a hostname
 * composed at deploy time, its own certificate, its own teardown, and an
 * authentication story that has to be told twice. This costs one branch.
 */
// The app's own module, aliased in by the preset. Resolves to `upgrade.noop`
// when an app declares none; declared ambiently in ../upgrade.d.ts so this file
// typechecks outside a consuming build.
import upgrade from '#cloudflare-monorepo/upgrade'
// Resolved by the consuming Nitro build, which supplies the `#nitro-internal-*`
// virtuals this module depends on.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import base from 'nitropack/presets/cloudflare/runtime/cloudflare-module'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = {
    fetch(request: any, env: any, context: any): Promise<any>
    [key: string]: any
}

const nitro = base as Handler

export default {
    ...nitro,
    async fetch(request: any, env: any, context: any): Promise<any> {
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            // Returned untouched. Anything that re-wraps this loses the 101 and
            // the client half of the socket with it.
            const answered = await (upgrade as any)(request, env, context)
            if (answered) return answered
        }
        return nitro.fetch(request, env, context)
    },
} satisfies Handler
