import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-route-scope-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["API_KEY_SECRET"] = "memory-route-scope-secret";
process.env["JWT_SECRET"] = "memory-route-scope-jwt";
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const dbCore = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const settings = await import("../../src/lib/db/settings.ts");
const dependencies = await import("../../src/memory/api/dependencies.ts");
const { createFourLayerService } = await import("../../src/memory/db/service.ts");
const { ownerFromApiKeyId } = await import("../../src/memory/integration/runtime.ts");

await settings.updateSettings({ requireLogin: false });
const management = await apiKeys.createApiKey(
  "memory-route-management",
  "memory-route-management-secret",
  ["manage"]
);

const managementHeaders = { authorization: `Bearer ${management.key}` };

test.afterEach(() => dependencies.resetFourLayerServiceForTesting());

test.after(() => {
  dependencies.resetFourLayerServiceForTesting();
  dbCore.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("management list route passes the resolved target owner scope to storage", async () => {
  let received: dependencies.MemoryRequestScope | null = null;
  dependencies.setFourLayerServiceForTesting({
    ...createFourLayerService(),
    listL1: async (scope, query) => {
      received = scope;
      return { data: [], total: 0, page: query.page ?? 1, limit: query.limit ?? 20 };
    },
  });

  const route = await import("../../src/app/api/memory/l1/route.ts");
  const response = await route.GET(
    new Request("http://localhost/api/memory/l1?apiKeyId=target-owner", {
      headers: managementHeaders,
    })
  );

  assert.equal(response.status, 200);
  assert.equal(received?.ownerApiKeyId, "target-owner");
  assert.deepEqual(received?.owner, ownerFromApiKeyId("target-owner"));
  assert.equal(received?.actor.apiKeyId, management.id);
});

test("management detail route keeps the resolved target owner scope", async () => {
  let received: dependencies.MemoryRequestScope | null = null;
  dependencies.setFourLayerServiceForTesting({
    ...createFourLayerService(),
    getL1: async (scope) => {
      received = scope;
      return null;
    },
  });

  const route = await import("../../src/app/api/memory/l1/[id]/route.ts");
  const response = await route.GET(
    new Request("http://localhost/api/memory/l1/missing?apiKeyId=target-owner", {
      headers: managementHeaders,
    }),
    { params: Promise.resolve({ id: "missing" }) }
  );

  assert.equal(response.status, 404);
  assert.equal(received?.ownerApiKeyId, "target-owner");
  assert.deepEqual(received?.owner, ownerFromApiKeyId("target-owner"));
});
