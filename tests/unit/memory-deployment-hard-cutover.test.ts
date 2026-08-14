import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("deployment templates do not expose the removed v3 memory engine", () => {
  const env = read(".env.example");
  const compose = read("docker-compose.yml");

  for (const removed of [
    "MEMORY_EMBEDDING_CACHE_TTL_MS",
    "MEMORY_EMBEDDING_CACHE_MAX",
    "MEMORY_TRANSFORMERS_MODEL",
    "MEMORY_STATIC_MODEL",
    "MEMORY_STATIC_CACHE_DIR",
    "MEMORY_VEC_TOP_K",
    "MEMORY_RRF_K",
    "MEMORY_TYPED_DECAY_ENABLED",
    "MEMORY_TYPED_DECAY_EPISODIC_DAYS",
    "MEMORY_TYPED_DECAY_ACCESS_IMMUNITY",
    "MEMORY_TYPED_DECAY_SWEEP_INTERVAL",
    "QDRANT_HOST",
    "QDRANT_PORT",
    "QDRANT_GRPC_PORT",
    "QDRANT_API_KEY",
    "QDRANT_COLLECTION",
    "QDRANT_EMBEDDING_MODEL",
    "QDRANT_VECTOR_SIZE",
    "QDRANT_HNSW_EF_CONSTRUCT",
  ]) {
    assert.doesNotMatch(env, new RegExp(`\\b${removed}\\b`), removed);
  }

  assert.doesNotMatch(compose, /^\s*qdrant:\s*$/m);
  assert.doesNotMatch(compose, /^\s*-\s*memory\s*$/m);
  assert.doesNotMatch(compose, /qdrant-data|omniroute-qdrant|QDRANT_/);
  assert.doesNotMatch(compose, /src\/lib\/memory/);
});
