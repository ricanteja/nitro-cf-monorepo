// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

/**
 * The app's `upgrade` module, aliased in by the preset at build time.
 *
 * Ambient rather than an augmentation in types.ts: the specifier resolves only
 * inside a consuming Nitro build, so this package has to be able to typecheck
 * without it existing. It resolves to `runtime/upgrade.noop` for an app that
 * declares none.
 */
declare module '#cloudflare-monorepo/upgrade' {
    const upgrade: (request: unknown, env: unknown, context?: unknown) => unknown | Promise<unknown>
    export default upgrade
}
