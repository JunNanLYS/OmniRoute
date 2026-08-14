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
const samplePersonas = [
  {
    id: "persona-1",
    ownerApiKeyId: "owner-a",
    content: "Be concise and helpful.",
    promptMode: "chat",
    version: 4,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    lastModifiedBy: "user",
    editedByUser: true,
    deletedAt: null,
  },
];

async function renderL3() {
  const { default: L3Tab } = await import("../components/layers/L3Tab");
  const container = document.createElement("div");
  document.body.appendChild(container);
  cleanupCallbacks.push(() => container.remove());
  const root = createRoot(container);
  await act(async () => root.render(<L3Tab />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, root };
}

describe("L3Tab", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    Object.values(notifications).forEach((fn) => fn.mockReset());
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((!init || init.method === "GET") && String(url) === "/api/memory/l3") {
        return jsonResponse({ data: samplePersonas });
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

  it("renders the singleton persona with prompt mode and version", async () => {
    const { container } = await renderL3();
    const row = container.querySelector("[data-testid='l3-prompt-persona-1']") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.dataset.mode).toBe("chat");
    expect(container.textContent).toContain("4");
  });

  it("updates through the canonical detail route with expectedVersion", async () => {
    const { container } = await renderL3();
    await act(async () => {
      (container.querySelector("[data-testid='l3-edit-persona-1']") as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector("[data-testid='l3-save']") as HTMLButtonElement).click();
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/memory/l3/persona-1" && init?.method === "PUT"
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      content: "Be concise and helpful.",
      promptMode: "chat",
      expectedVersion: 4,
    });
  });

  it("clears the persona and regenerates the singleton through canonical routes", async () => {
    const { container } = await renderL3();
    await act(async () => {
      (container.querySelector("[data-testid='l3-clear-persona-1']") as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector("[data-testid='l3-confirm-clear']") as HTMLButtonElement).click();
    });
    expect(fetchMock.mock.calls).toContainEqual([
      "/api/memory/l3/persona-1",
      expect.objectContaining({ method: "DELETE" }),
    ]);

    await act(async () => {
      (
        container.querySelector("[data-testid='l3-regenerate-persona-1']") as HTMLButtonElement
      ).click();
    });
    expect(fetchMock.mock.calls).toContainEqual([
      "/api/memory/l3",
      expect.objectContaining({ method: "POST" }),
    ]);
  });
});
