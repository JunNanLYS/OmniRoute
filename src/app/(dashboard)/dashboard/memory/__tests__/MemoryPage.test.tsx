// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockSearchParams: Record<string, string> = {};
const replaceMock = vi.fn();
const fetchMock = vi.fn();
const receivedLayerProps: Array<Record<string, unknown>> = [];

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => mockSearchParams[key] ?? null,
    toString: () => new URLSearchParams(mockSearchParams).toString(),
  }),
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock("../components/MemoryConceptCard", () => ({
  default: () => <div data-testid="concept-card">Concept</div>,
}));

function layer(testId: string, props: Record<string, unknown>) {
  receivedLayerProps.push(props);
  return <div data-testid={testId}>{String(props.apiKeyId ?? "")}</div>;
}

vi.mock("../components/layers/L0Tab", () => ({
  default: (props: Record<string, unknown>) => layer("l0-tab-content", props),
}));
vi.mock("../components/layers/L1Tab", () => ({
  default: (props: Record<string, unknown>) => layer("l1-tab-content", props),
}));
vi.mock("../components/layers/L2Tab", () => ({
  default: (props: Record<string, unknown>) => layer("l2-tab-content", props),
}));
vi.mock("../components/layers/L3Tab", () => ({
  default: (props: Record<string, unknown>) => layer("l3-tab-content", props),
}));
vi.mock("../components/layers/DistillationSettingsTab", () => ({
  default: (props: Record<string, unknown>) => layer("settings-tab-content", props),
}));

const cleanupCallbacks: Array<() => void> = [];

async function renderMemoryPage() {
  const { default: MemoryPage } = await import("../page");
  const container = document.createElement("div");
  document.body.appendChild(container);
  cleanupCallbacks.push(() => container.remove());
  const root = createRoot(container);
  await act(async () => root.render(<MemoryPage />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, root };
}

describe("MemoryPage owner scope", () => {
  beforeEach(() => {
    mockSearchParams = {};
    replaceMock.mockReset();
    receivedLayerProps.length = 0;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        keys: [
          { id: "owner-a", name: "Owner A", isActive: true, isBanned: false },
          { id: "owner-b", name: "Owner B", isActive: true, isBanned: false },
        ],
      }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("loads API keys and defaults the owner to the first active key", async () => {
    const { container } = await renderMemoryPage();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/keys?limit=100",
      expect.objectContaining({ credentials: "same-origin", signal: expect.any(AbortSignal) })
    );
    expect(container.querySelector("[data-testid='memory-owner-select']")).toBeTruthy();
    expect(container.querySelector("[data-testid='l0-tab-content']")?.textContent).toBe("owner-a");
    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("apiKeyId=owner-a"), {
      scroll: false,
    });
  });

  it("preserves an owner selected in the URL", async () => {
    mockSearchParams = { tab: "l2", apiKeyId: "owner-b" };
    const { container } = await renderMemoryPage();
    expect(container.querySelector("[data-testid='l2-tab-content']")?.textContent).toBe("owner-b");
    expect(receivedLayerProps.at(-1)?.apiKeyId).toBe("owner-b");
  });

  it("keeps apiKeyId when switching tabs", async () => {
    mockSearchParams = { tab: "l0", apiKeyId: "owner-b" };
    const { container } = await renderMemoryPage();
    await act(async () => {
      (container.querySelector("[data-testid='tab-l3']") as HTMLButtonElement).click();
    });
    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("apiKeyId=owner-b"), {
      scroll: false,
    });
  });

  it("does not mount owner-scoped layers when no API key is available", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) } as Response);
    const { container } = await renderMemoryPage();
    expect(container.querySelector("[data-testid='memory-owner-empty']")).toBeTruthy();
    expect(container.querySelector("[data-testid='l0-tab-content']")).toBeNull();
  });
});
