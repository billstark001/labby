/**
 * @labby/algorithm – main entry point.
 *
 * Exports the TypeScript fallback implementation synchronously.
 * When the Rust-compiled WASM or native addon is available it can be loaded
 * via the `loadWasmEngine` / `loadNativeEngine` helpers, but the TypeScript
 * fallback is always available for testing and environments that have not run
 * the Rust build step.
 */

export { EmbeddingEngine, createEngine, DIMS } from './fallback.js';
export type { DirtyResult } from './fallback.js';
