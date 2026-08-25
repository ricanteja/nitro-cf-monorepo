// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

// Main entry point
export { default, cloudflareMonorepo, cloudflareMonorepoDev } from './preset'
export { cloudflareMonorepoDevModule } from './dev'
export type {
    CloudflareMonorepoOptions,
    AuxiliaryWorkerConfig,
    ResolvedMonorepoConfig,
} from './types'
