// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock("@/store/notificationStore", () => ({ useNotificationStore: () => notifications }));
const fetchMock = vi.fn();
const jsonResponse = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;
const cleanupCallbacks: Array<() => void> = [];
const selectorResponse = {
  data: {
    provider: "openai",
    modelId: "gpt-4o-mini",
    sourceLayer: "global",
    apiKeyId: null,
    scope: "global",
  },
  canSetGlobal: true,
};

async function renderDistillation(apiKeyId?: string) {
  const { default: DistillationSettingsTab } =
    await import("../components/layers/DistillationSettingsTab");
  const container = document.createElement("div");
  document.body.appendChild(container);
  cleanupCallbacks.push(() => container.remove());
  const root = createRoot(container);
  await act(async () => root.render(<DistillationSettingsTab apiKeyId={apiKeyId} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, root };
}

const usageResponse = {
  data: [
    {
      id: 1,
      ownerApiKeyId: "self",
      kind: "L2_scene",
      provider: "openai",
      model: "gpt-4o-mini",
      tokens: 123,
      usd: 0.0123,
      recordedAt: "2026-08-13T00:00:00Z",
    },
    {
      id: 2,
      ownerApiKeyId: "self",
      kind: "L3_persona",
      provider: "openai",
      model: "gpt-4o-mini",
      tokens: 77,
      usd: 0.0077,
      recordedAt: "2026-08-13T00:01:00Z",
    },
  ],
  totals: { tokens: 200, usd: 0.02, tasks: 2 },
};

describe("DistillationSettingsTab", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    Object.values(notifications).forEach((fn) => fn.mockReset());
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const value = String(url);
      if (value.startsWith("/api/memory/pipeline-settings") && (!init || init.method === "GET")) {
        return jsonResponse({
          data: { captureEnabled: false, injectionEnabled: true, sourceLayer: "per-key" },
        });
      }
      if (value === "/api/memory/distillation-worker" && (!init || init.method === "GET")) {
        return jsonResponse({
          data: {
            enabled: true,
            intervalSeconds: 120,
            concurrency: 2,
            sourceLayer: "stored",
            runtime: {
              state: "running",
              activeTasks: 1,
              configuredIntervalSeconds: 120,
              configuredConcurrency: 2,
            },
          },
        });
      }
      if (value === "/api/memory/distillation-model" && (!init || init.method === "GET")) {
        return jsonResponse(selectorResponse);
      }
      if (value === "/api/memory/distillation-model/dlq" && (!init || init.method === "GET")) {
        return jsonResponse({
          data: [
            {
              id: "7",
              errorMessage: "parse failed",
              errorAt: "2026-01-01T00:00:00Z",
              status: "pending",
            },
          ],
          statusCounts: { pending: 1, running: 0, failed: 0, succeeded: 0 },
        });
      }
      if (value === "/api/memory/distillation-model/usage" && (!init || init.method === "GET")) {
        return jsonResponse(usageResponse);
      }
      if (value.startsWith("/api/synced-available-models")) {
        return jsonResponse({ models: [{ id: "gpt-4o-mini", name: "GPT-4o mini" }] });
      }
      return jsonResponse({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the canonical selector response and source layer", async () => {
    const { container } = await renderDistillation();
    expect(container.textContent).toContain("openai");
    expect(container.textContent).toContain("gpt-4o-mini");
    expect(
      container
        .querySelector("[data-testid='distillation-source-layer']")
        ?.getAttribute("data-source-layer")
    ).toBe("global");
  });

  it("PUTs provider/modelId and scope to the canonical selector route", async () => {
    const { container } = await renderDistillation();
    await act(async () => {
      (container.querySelector("[data-testid='distillation-apply']") as HTMLButtonElement).click();
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/memory/distillation-model" && init?.method === "PUT"
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
      scope: "self",
    });
  });

  it("loads and retries DLQ entries through the canonical endpoint", async () => {
    const { container } = await renderDistillation();
    expect(container.querySelector("[data-testid='distillation-dlq-7']")).toBeTruthy();
    await act(async () => {
      (
        container.querySelector("[data-testid='distillation-dlq-retry-7']") as HTMLButtonElement
      ).click();
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/memory/distillation-model/dlq?op=retry" && init?.method === "POST"
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ ids: ["7"] });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("distillation-status"))).toBe(
      false
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("distillation-dlq"))).toBe(
      false
    );
  });

  it("renders the distillation usage card with totals and rows", async () => {
    const { container } = await renderDistillation();
    expect(container.querySelector("[data-testid='distillation-usage']")).toBeTruthy();
    expect(
      container.querySelector("[data-testid='distillation-usage-tokens']")?.textContent
    ).toContain("200");
    expect(
      container.querySelector("[data-testid='distillation-usage-usd']")?.textContent
    ).toContain("$0.0200");
    expect(
      container.querySelector("[data-testid='distillation-usage-tasks']")?.textContent
    ).toContain("2");
    expect(container.querySelector("[data-testid='distillation-usage-row-1']")).toBeTruthy();
  });

  it("disables global scope when the API says it is unavailable", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === "/api/memory/distillation-model") {
        return jsonResponse({ ...selectorResponse, canSetGlobal: false });
      }
      if (String(url) === "/api/memory/distillation-model/dlq") {
        return jsonResponse({ data: [], statusCounts: {} });
      }
      return jsonResponse({ models: [] });
    });
    const { container } = await renderDistillation();
    const trigger = container.querySelector(
      "[data-testid='distillation-scope']"
    ) as HTMLButtonElement;
    await act(async () => trigger.click());
    const option = Array.from(container.querySelectorAll("[role='option']")).find(
      (node) => node.getAttribute("aria-disabled") === "true"
    );
    expect(option).toBeTruthy();
  });

  it("saves owner-scoped capture and injection settings", async () => {
    const { container } = await renderDistillation("owner-1");
    const capture = container.querySelector(
      "[data-testid='memory-capture-toggle'] [role='switch']"
    ) as HTMLButtonElement;
    await act(async () => capture.click());
    await act(async () => {
      (
        container.querySelector("[data-testid='memory-pipeline-save']") as HTMLButtonElement
      ).click();
    });

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/memory/pipeline-settings?apiKeyId=owner-1" && init?.method === "PUT"
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      captureEnabled: true,
      injectionEnabled: true,
    });
  });
  it("renders process-global distillation worker controls and saves them", async () => {
    const { container } = await renderDistillation("owner-1");

    expect(container.querySelector("[data-testid='distillation-worker-settings']")).toBeTruthy();
    expect(container.querySelector("[data-testid='distillation-worker-source']")?.textContent).toBe(
      "Saved global settings"
    );
    expect(container.querySelector("[data-testid='distillation-worker-interval']")).toHaveValue(
      120
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='distillation-worker-save']")
        ?.click();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/memory/distillation-worker" && init?.method === "PUT"
    );
    expect(call).toBeTruthy();
    expect(call?.[1]?.body).toBe(
      JSON.stringify({ enabled: true, intervalSeconds: 120, concurrency: 2 })
    );
  });

  it("renders owner-scoped capture and injection controls", async () => {
    const { container } = await renderDistillation();
    const capture = container.querySelector(
      "[data-testid='memory-capture-toggle'] [role='switch']"
    ) as HTMLButtonElement | null;
    const injection = container.querySelector(
      "[data-testid='memory-injection-toggle'] [role='switch']"
    ) as HTMLButtonElement | null;

    expect(capture).toBeTruthy();
    expect(capture?.getAttribute("role")).toBe("switch");
    expect(capture?.getAttribute("aria-checked")).toBe("false");
    expect(injection).toBeTruthy();
    expect(injection?.getAttribute("role")).toBe("switch");
    expect(injection?.getAttribute("aria-checked")).toBe("true");
  });
});
