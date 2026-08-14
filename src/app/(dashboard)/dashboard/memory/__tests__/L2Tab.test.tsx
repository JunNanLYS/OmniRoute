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

const sampleScenes = [
  {
    id: "scene-1",
    ownerApiKeyId: "owner-a",
    sceneName: "project",
    groupKey: "repo-a",
    summary: "Project context",
    heat: 0.7,
    content: "Long content here.",
    version: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    lastModifiedBy: "user",
    editedByUser: true,
    deletedAt: null,
  },
];

async function renderL2() {
  const { default: L2Tab } = await import("../components/layers/L2Tab");
  const container = document.createElement("div");
  document.body.appendChild(container);
  cleanupCallbacks.push(() => container.remove());
  const root = createRoot(container);
  await act(async () => root.render(<L2Tab />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, root };
}

describe("L2Tab", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    Object.values(notifications).forEach((fn) => fn.mockReset());
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((!init || init.method === "GET") && String(url).startsWith("/api/memory/l2")) {
        return jsonResponse({ data: sampleScenes });
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

  it("renders native scene fields", async () => {
    const { container } = await renderL2();
    expect(container.querySelector("[data-testid='l2-scene-scene-1']")).toBeTruthy();
    expect(container.textContent).toContain("project");
    expect(container.textContent).toContain("repo-a");
    expect(container.textContent).toContain("0.70");
  });

  it("updates with expectedVersion through the canonical detail route", async () => {
    const { container } = await renderL2();
    await act(async () => {
      (container.querySelector("[data-testid='l2-edit-scene-1']") as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector("[data-testid='l2-save']") as HTMLButtonElement).click();
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/memory/l2/scene-1" && init?.method === "PUT"
    );
    expect(JSON.parse(String(call?.[1]?.body)).expectedVersion).toBe(2);
  });

  it("regenerates and deletes through canonical routes", async () => {
    const { container } = await renderL2();
    await act(async () => {
      (
        container.querySelector("[data-testid='l2-regenerate-scene-1']") as HTMLButtonElement
      ).click();
    });
    expect(fetchMock.mock.calls).toContainEqual([
      "/api/memory/l2/scene-1/regenerate",
      expect.objectContaining({ method: "POST" }),
    ]);

    await act(async () => {
      (container.querySelector("[data-testid='l2-delete-scene-1']") as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector("[data-testid='l2-confirm-delete']") as HTMLButtonElement).click();
    });
    expect(fetchMock.mock.calls).toContainEqual([
      "/api/memory/l2/scene-1",
      expect.objectContaining({ method: "DELETE" }),
    ]);
  });
});
