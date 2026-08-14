// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const containers: HTMLElement[] = [];
const roots: Array<{ unmount: () => void }> = [];

function mount(ui: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(ui));
  return container;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
  while (containers.length > 0) containers.pop()?.remove();
  document.body.innerHTML = "";
});

describe("SkillsTab hard cutover", () => {
  it("loads only generic settings and renders no legacy memory or Qdrant controls", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(
        JSON.stringify({
          skillsEnabled: false,
          skillsmpApiKey: "configured",
          skillsProvider: "skillssh",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const { default: SkillsTab } =
      await import("../../../src/app/(dashboard)/dashboard/settings/components/SkillsTab");
    let container!: HTMLElement;
    await act(async () => {
      container = mount(<SkillsTab />);
    });
    await flushEffects();

    expect(requests).toEqual([{ url: "/api/settings", method: "GET", body: null }]);
    expect(container.querySelector('[data-testid="skills-settings-card"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="skills-enabled-switch"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="memory-enabled-switch"]')).toBeNull();
    expect(container.querySelector('[data-testid="qdrant-settings-card"]')).toBeNull();
    expect(container.textContent).not.toContain("qdrantTitle");
    expect(container.textContent).not.toContain("memoryTitle");
  });

  it("saves skillsEnabled through the generic settings endpoint", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url: String(input), method: init?.method ?? "GET", body });
      const response =
        init?.method === "PATCH"
          ? { skillsEnabled: Boolean(body?.skillsEnabled) }
          : { skillsEnabled: false, skillsmpApiKey: "", skillsProvider: "skillsmp" };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { default: SkillsTab } =
      await import("../../../src/app/(dashboard)/dashboard/settings/components/SkillsTab");
    let container!: HTMLElement;
    await act(async () => {
      container = mount(<SkillsTab />);
    });
    await flushEffects();

    const toggle = container.querySelector(
      '[data-testid="skills-enabled-switch"]'
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    await flushEffects();

    expect(requests.at(-1)).toEqual({
      url: "/api/settings",
      method: "PATCH",
      body: { skillsEnabled: true },
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
