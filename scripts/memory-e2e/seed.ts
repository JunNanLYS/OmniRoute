/**
 * Seeding for the smoke profile: provider node + connection against the
 * loopback mock upstream, model sync, deterministic distillation selector,
 * the management/judge API keys, and a per-fixture subject-key factory. All
 * through product APIs — no direct DB access, no browser.
 *
 * Auth note: the server boots in "open" bootstrap mode (no password), so
 * loopback management calls (provider-nodes/providers/keys) pass during the
 * bootstrap window without credentials. The created management key is used
 * for the memory management surface (selector), which always requires a
 * bearer subject.
 */
import { httpJson, sleep } from "./http.ts";
import { MOCK_MODEL_ID } from "./mockUpstream.ts";

export const MOCK_NODE_PREFIX = "mock";

export interface SeededKey {
  id: string;
  key: string;
}

export interface SeedResult {
  nodeId: string;
  connectionId: string;
  managementKeyId: string;
  /** Plaintext keys — NEVER written to reports (masked via `maskedSeedSummary`). */
  managementKey: string;
  judgeKeyId: string;
  judgeKey: string;
  /**
   * Mint a fresh subject owner for one fixture. Every fixture gets its own
   * key (capture+injection enabled on it), so L1/L2/L3 rows, the L2 scene
   * budget (15/owner), and the L3 persona singleton are fully isolated
   * between suites — no cross-fixture eviction or overwrite.
   */
  createSubject(): Promise<SeededKey>;
  selectorModel: string;
  gatewayModel: string;
  log: string[];
}

export function maskedSeedSummary(seed: SeedResult): Record<string, unknown> {
  const mask = (key: string): string => (key ? `${key.slice(0, 7)}***${key.slice(-4)}` : "");
  return {
    nodeId: seed.nodeId,
    connectionId: seed.connectionId,
    selectorModel: seed.selectorModel,
    gatewayModel: seed.gatewayModel,
    keys: {
      management: { id: seed.managementKeyId, value: mask(seed.managementKey) },
      judge: { id: seed.judgeKeyId, value: mask(seed.judgeKey) },
    },
    steps: seed.log,
  };
}

async function createKey(
  baseUrl: string,
  name: string,
  log: string[],
  scopes?: string[]
): Promise<SeededKey> {
  const response = await httpJson<{ key?: string; id?: string }>(`${baseUrl}/api/keys`, {
    method: "POST",
    body: JSON.stringify({ name, ...(scopes ? { scopes } : {}) }),
  });
  if (!response.ok || !response.body.key || !response.body.id) {
    throw new Error(
      `seed: failed to create key ${name}: HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`
    );
  }
  log.push(`created api key ${name} (${response.body.id})`);
  return { id: response.body.id, key: response.body.key };
}

/**
 * Mint one subject key and enable memory capture + injection on it. Used
 * per fixture so each suite distills into its own owner partition.
 */
export async function createSubjectKey(
  baseUrl: string,
  name: string,
  log: string[]
): Promise<SeededKey> {
  const subject = await createKey(baseUrl, name, log);
  const pipelinePut = await httpJson(`${baseUrl}/api/memory/pipeline-settings`, {
    method: "PUT",
    bearer: subject.key,
    body: JSON.stringify({ captureEnabled: true, injectionEnabled: true }),
  });
  if (!pipelinePut.ok) {
    throw new Error(
      `seed: failed to enable subject pipeline for ${name}: HTTP ${pipelinePut.status} ${JSON.stringify(pipelinePut.body).slice(0, 300)}`
    );
  }
  log.push(`subject ${name}: capture=on injection=on`);
  return subject;
}

export async function seedSmokeTarget(options: {
  baseUrl: string;
  mockBaseUrl: string;
  syncTimeoutMs?: number;
  onLog?: (line: string) => void;
}): Promise<SeedResult> {
  const { baseUrl, mockBaseUrl } = options;
  const log: string[] = [];
  const push = (line: string): void => {
    log.push(line);
    options.onLog?.(line);
  };

  // 1. Loopback OpenAI-compatible provider node + connection (fake key).
  const nodeResponse = await httpJson<{ node?: { id?: string } }>(`${baseUrl}/api/provider-nodes`, {
    method: "POST",
    body: JSON.stringify({
      name: "memory-e2e-mock",
      prefix: MOCK_NODE_PREFIX,
      apiType: "chat",
      type: "openai-compatible",
      baseUrl: mockBaseUrl,
    }),
  });
  const nodeId = nodeResponse.body.node?.id;
  if (!nodeId) {
    throw new Error(
      `seed: failed to create provider node: HTTP ${nodeResponse.status} ${JSON.stringify(nodeResponse.body)}`
    );
  }
  push(`created provider node ${nodeId} -> ${mockBaseUrl}`);

  const connectionResponse = await httpJson<{ connection?: { id?: string } }>(
    `${baseUrl}/api/providers`,
    {
      method: "POST",
      body: JSON.stringify({
        provider: nodeId,
        apiKey: "sk-mock-e2e",
        name: "memory-e2e-mock-connection",
      }),
    }
  );
  const connectionId =
    connectionResponse.body.connection?.id ?? (connectionResponse.body as { id?: string }).id;
  if (!connectionId) {
    throw new Error(
      `seed: failed to create provider connection: HTTP ${connectionResponse.status} ${JSON.stringify(connectionResponse.body)}`
    );
  }
  push(`created provider connection ${connectionId}`);

  // 2. Management key for the memory management surface.
  const management = await createKey(baseUrl, "memory-e2e-management", log, ["manage"]);

  // 3. Sync models from the mock upstream. The successful response is the
  //    authoritative sync contract (`models`, `syncedModels`, counts); the
  //    effective selector is a different surface and may remain `auto` until
  //    we pin it below.
  const syncResponse = await httpJson<{
    ok?: boolean;
    syncedModels?: number;
    availableModelsCount?: number;
    models?: Array<{ id?: string }>;
    importedModels?: Array<{ id?: string }>;
  }>(`${baseUrl}/api/providers/${encodeURIComponent(connectionId)}/sync-models`, {
    method: "POST",
    bearer: management.key,
  });
  if (!syncResponse.ok || syncResponse.body.ok !== true) {
    throw new Error(
      `seed: model sync failed: HTTP ${syncResponse.status} ${JSON.stringify(syncResponse.body).slice(0, 400)}`
    );
  }
  const responseModels = [
    ...(Array.isArray(syncResponse.body.models) ? syncResponse.body.models : []),
    ...(Array.isArray(syncResponse.body.importedModels) ? syncResponse.body.importedModels : []),
  ];
  const modelSynced =
    responseModels.some((model) => model.id === MOCK_MODEL_ID) ||
    Number(syncResponse.body.syncedModels ?? 0) > 0 ||
    Number(syncResponse.body.availableModelsCount ?? 0) > 0;
  if (!modelSynced) {
    throw new Error(
      `seed: sync returned no available models: ${JSON.stringify(syncResponse.body).slice(0, 400)}`
    );
  }
  push(`catalog exposes ${MOCK_MODEL_ID} (sync HTTP ${syncResponse.status})`);

  // 4. Pin the global distillation selector for determinism.
  const selectorPut = await httpJson(`${baseUrl}/api/memory/distillation-model`, {
    method: "PUT",
    bearer: management.key,
    body: JSON.stringify({
      provider: nodeId,
      modelId: MOCK_MODEL_ID,
      scope: "global",
    }),
  });
  if (!selectorPut.ok) {
    throw new Error(
      `seed: failed to set global selector: HTTP ${selectorPut.status} ${JSON.stringify(selectorPut.body)}`
    );
  }
  push(`pinned global distillation selector to ${nodeId}/${MOCK_MODEL_ID}`);

  // 5. Judge key (capture/injection stay disabled — it must never feed the
  //    memory it judges) + the per-fixture subject factory.
  const judge = await createKey(baseUrl, "memory-e2e-judge", log);
  let subjectSeq = 0;
  const createSubject = async (): Promise<SeededKey> => {
    subjectSeq += 1;
    return createSubjectKey(baseUrl, `memory-e2e-subject-${subjectSeq}`, log);
  };
  push("subject factory ready (per-fixture owners); judge pipeline: default (off)");

  await sleep(100);
  return {
    nodeId,
    connectionId,
    managementKeyId: management.id,
    managementKey: management.key,
    judgeKeyId: judge.id,
    judgeKey: judge.key,
    createSubject,
    selectorModel: `${MOCK_NODE_PREFIX}/${MOCK_MODEL_ID}`,
    gatewayModel: `${MOCK_NODE_PREFIX}/${MOCK_MODEL_ID}`,
    log,
  };
}
