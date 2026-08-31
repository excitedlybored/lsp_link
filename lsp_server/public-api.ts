/** Stable integration surface consumed by the indexer package. */
export type { ILspAdapter } from './contracts/lsp-adapter.interface.js';
export { LspAdapterRegistry } from './registry/lsp-adapter-registry.js';
export type { LspAdapterFactory } from './registry/adapter-catalog.js';

export * from './adapters/java/bazel-project-model.js';
export * from './adapters/java/bazel-source-inventory.js';
export * from './adapters/java/jdtls-runtime.js';
export * from './adapters/java/jdtls-sharding.js';
