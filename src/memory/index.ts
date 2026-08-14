/**
 * src/memory/index.ts
 *
 * Public surface of the standalone four-layer memory storage core.
 *
 * Re-exports the layer modules (l0..l3), operations, retrieval helpers, vector
 * store, types, and the DB lifecycle. Callers should import from this entry point
 * rather than reaching into individual files — that lets the internals evolve
 * without breaking public callers.
 */

export * from "./types.ts";

export {
  getMemoryDbInstance,
  resetMemoryDbInstance,
  getMemoryDbFilePath,
  isMemoryDbReady,
} from "./db/core.ts";

export * as l0 from "./l0.ts";
export * as l1 from "./l1.ts";
export * as l2 from "./l2.ts";
export * as l3 from "./l3.ts";

export * as ops from "./operations.ts";
export * as rrf from "./retrieval/rrf.ts";
export * as vec from "./vectorStore.ts";
