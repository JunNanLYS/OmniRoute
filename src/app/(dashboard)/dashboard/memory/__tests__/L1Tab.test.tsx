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

const sampleMemories = [
  {
    id: "mem-abc-123",
    ownerApiKeyId: "owner-a",
    type: "work_fact",
    priority: 80,
    content: "The project uses TypeScript.",
    sceneName: "project",
    metadata: { tags: ["typescript"] },
    sourceMessageIds: [],
    version: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    lastModifiedBy: "user",
    editedByUser: true,
    deletedAt: null,
  },
];

async function renderL1() {
  const { default: L1Tab } = await import("../components/layers/L1Tab");
  const container = makeContainer();
  const root = createRoot(container);
  await act(async () => root.render(<L1Tab />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, root };
}

describe("L1Tab", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    Object.values(notifications).forEach((fn) => fn.mockReset());
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((!init || init.method === "GET") && String(url).startsWith("/api/memory/l1")) {
        return jsonResponse({ data: sampleMemories });
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

  it("renders canonical taxonomy and metadata", async () => {
    const { container } = await renderL1();
    expect(container.querySelector("[data-testid='l1-memory-mem-abc-123']")).toBeTruthy();
    expect(container.textContent).toContain("work_fact");
    expect(container.textContent).toContain("project");
    const trigger = container.querySelector("[data-testid='l1-type-filter']") as HTMLButtonElement;
    await act(async () => trigger.click());
    const options = Array.from(container.querySelectorAll("[role='option']")).map(
      (option) => option.textContent
    );
    expect(options.slice(1)).toEqual([
      "persona",
      "episodic",
      "instruction",
      "work_fact",
      "work_task",
      "work_method",
      "work_artifact",
    ]);
  });

  it("updates through the canonical detail route with expectedVersion", async () => {
    const { container } = await renderL1();
    await act(async () => {
      (container.querySelector("[data-testid='l1-edit-mem-abc-123']") as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector("[data-testid='l1-save']") as HTMLButtonElement).click();
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/memory/l1/mem-abc-123" && init?.method === "PUT"
    );
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.expectedVersion).toBe(3);
    expect(body.type).toBeUndefined();
  });

  it("soft deletes an active row through the canonical detail route", async () => {
    const { container } = await renderL1();
    await act(async () => {
      (
        container.querySelector("[data-testid='l1-soft-delete-mem-abc-123']") as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (
        container.querySelector("[data-testid='l1-confirm-soft-delete']") as HTMLButtonElement
      ).click();
    });
    const deletion = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/memory/l1/mem-abc-123" && init?.method === "DELETE"
    );
    expect(JSON.parse(String(deletion?.[1]?.body))).toEqual({ mode: "soft" });
  });

  it("restores a deleted row through POST ?op=restore", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((!init || init.method === "GET") && String(url).startsWith("/api/memory/l1")) {
        return jsonResponse({
          data: [{ ...sampleMemories[0], deletedAt: "2026-01-03T00:00:00Z" }],
        });
      }
      return jsonResponse({ success: true });
    });
    const { container } = await renderL1();
    await act(async () => {
      (
        container.querySelector("[data-testid='l1-restore-mem-abc-123']") as HTMLButtonElement
      ).click();
    });
    expect(fetchMock.mock.calls).toContainEqual([
      "/api/memory/l1/mem-abc-123?op=restore",
      expect.objectContaining({ method: "POST" }),
    ]);
  });
});
