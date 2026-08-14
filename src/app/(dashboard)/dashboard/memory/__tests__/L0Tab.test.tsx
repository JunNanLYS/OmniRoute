// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock("@/store/notificationStore", () => ({ useNotificationStore: () => notifications }));

const fetchMock = vi.fn();
const jsonResponse = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;
const cleanupCallbacks: Array<() => void> = [];

function makeContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  cleanupCallbacks.push(() => container.remove());
  return container;
}

const sampleMessages = [
  {
    id: "msg-1",
    ownerApiKeyId: "owner-a",
    sessionKey: "sess-abc",
    sessionId: "sess-abc",
    role: "user",
    content: "Hello there.",
    timestamp: "2026-01-01T00:00:00Z",
    recordedAt: "2026-01-01T00:00:00Z",
    source: "user",
    correlationId: null,
    comboExecutionKey: null,
    isInternal: false,
    provider: "openai",
    model: "gpt-4o-mini",
    truncated: false,
    idempotencyKey: "turn-1",
    deletedAt: null,
    associatedL1Ids: ["unsupported-l1-id"],
  },
];
const sampleBin = [
  {
    ...sampleMessages[0],
    id: "msg-9",
    content: "Removed message.",
    deletedAt: "2026-01-02T00:00:00Z",
  },
];

async function renderL0() {
  const { default: L0Tab } = await import("../components/layers/L0Tab");
  const container = makeContainer();
  const root = createRoot(container);
  await act(async () => root.render(<L0Tab />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, root };
}

describe("L0Tab", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    Object.values(notifications).forEach((fn) => fn.mockReset());
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const value = String(url);
      if ((!init || init.method === "GET") && value === "/api/memory/l0?includeDeleted=deleted") {
        return jsonResponse({ data: sampleBin });
      }
      if ((!init || init.method === "GET") && value === "/api/memory/l0/status") {
        return jsonResponse({
          data: {
            ownerApiKeyId: "owner-a",
            successCount: 12,
            failureCount: 2,
            lastSuccessAt: "2026-08-13T00:00:00Z",
            lastFailureAt: "2026-08-12T00:00:00Z",
            lastFailureCategory: "storage_error",
          },
        });
      }
      if ((!init || init.method === "GET") && value.startsWith("/api/memory/l0")) {
        return jsonResponse({ data: sampleMessages });
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

  it("loads active and deleted rows from the canonical L0 collection", async () => {
    const { container } = await renderL0();
    expect(container.querySelector("[data-testid='l0-message-msg-1']")).toBeTruthy();
    expect(container.querySelector("[data-testid='l0-recycle-msg-9']")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/l0",
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/l0?includeDeleted=deleted",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("does not render reverse lineage fields outside the canonical L0 contract", async () => {
    const { container } = await renderL0();
    expect(container.querySelector("[data-testid='l0-associated-l1-msg-1']")).toBeNull();
  });

  it("restores through POST ?op=restore", async () => {
    const { container } = await renderL0();
    await act(async () => {
      (container.querySelector("[data-testid='l0-restore-msg-9']") as HTMLButtonElement).click();
    });
    expect(fetchMock.mock.calls).toContainEqual([
      "/api/memory/l0/msg-9?op=restore",
      expect.objectContaining({ method: "POST" }),
    ]);
  });

  it("permanently deletes through the detail route with an explicit mode", async () => {
    const { container } = await renderL0();
    await act(async () => {
      (
        container.querySelector("[data-testid='l0-perm-delete-msg-9']") as HTMLButtonElement
      ).click();
    });
    const input = container.querySelector(
      "[data-testid='l0-perm-confirm-input']"
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "DELETE"
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (
        container.querySelector("[data-testid='l0-confirm-perm-delete']") as HTMLButtonElement
      ).click();
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/memory/l0/msg-9" && init?.method === "DELETE"
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ mode: "permanent" });
  });

  it("renders the masked L0 capture status card with aggregate counters", async () => {
    const { container } = await renderL0();
    expect(container.querySelector("[data-testid='l0-capture-status']")).toBeTruthy();
    expect(container.querySelector("[data-testid='l0-capture-success']")?.textContent).toContain(
      "12"
    );
    expect(container.querySelector("[data-testid='l0-capture-failure']")?.textContent).toContain(
      "2"
    );
    expect(
      container.querySelector("[data-testid='l0-capture-last-success']")?.textContent
    ).toContain("2026-08-13");
    expect(
      container.querySelector("[data-testid='l0-capture-last-failure']")?.textContent
    ).toContain("storage_error");
    const statusCall = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith("/api/memory/l0/status")
    );
    expect(statusCall).toBeTruthy();
  });
});
