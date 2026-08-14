import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const spec = yaml.load(readFileSync(ROOT + "docs/openapi.yaml", "utf8")) as {
  paths: Record<
    string,
    Record<
      string,
      {
        security?: Array<Record<string, unknown>>;
        parameters?: Array<{ name?: string; in?: string }>;
        requestBody?: { required?: boolean };
      }
    >
  >;
};

test("every four-layer memory operation documents API-key or dashboard-session auth", () => {
  const memoryPaths = Object.entries(spec.paths).filter(([path]) => path.startsWith("/api/memory"));
  assert.equal(memoryPaths.length, 13);

  for (const [path, pathItem] of memoryPaths) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!METHODS.has(method)) continue;
      assert.deepEqual(
        operation.security,
        [{ BearerAuth: [] }, { ManagementSessionAuth: [] }],
        `${method.toUpperCase()} ${path} must document both supported auth alternatives`
      );
    }
  }
});

test("memory collection parameters match the filters production storage applies", () => {
  const expected: Record<string, string[]> = {
    "/api/memory/l0": ["apiKeyId", "page", "limit", "offset", "sessionId", "q", "includeDeleted"],
    "/api/memory/l1": [
      "apiKeyId",
      "page",
      "limit",
      "offset",
      "sceneName",
      "type",
      "q",
      "includeDeleted",
    ],
    "/api/memory/l2": ["apiKeyId", "page", "limit", "offset", "sceneName", "q", "includeDeleted"],
    "/api/memory/l3": ["apiKeyId", "page", "limit", "offset", "includeDeleted"],
  };

  for (const [path, names] of Object.entries(expected)) {
    const parameters = spec.paths[path]?.get?.parameters ?? [];
    assert.deepEqual(
      parameters.filter((parameter) => parameter.in === "query").map((parameter) => parameter.name),
      names,
      `GET ${path} must not advertise ignored filters`
    );
  }
});

test("regeneration request bodies are optional", () => {
  assert.equal(spec.paths["/api/memory/l2/{id}/regenerate"]?.post?.requestBody?.required, false);
  assert.equal(spec.paths["/api/memory/l3"]?.post?.requestBody?.required, false);
});
