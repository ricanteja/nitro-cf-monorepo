// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

/**
 * Stand-in for an app that declares no `upgrade` module.
 *
 * The entry always imports something, so this exists to keep that import
 * resolvable rather than making the entry conditional on build-time config.
 * Returning nothing means every request falls through to Nitro, which is what
 * an app without WebSockets wants.
 */
export default function upgrade(): undefined {
    return undefined
}
