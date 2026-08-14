/**
 * Regression coverage for #1701 against the four-layer injection transformer.
 *
 * Providers that reject the system role receive one leading user reference containing
 * stable layer context and dynamic L1 recall. Providers with system-role support keep
 * stable context in a system message.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderLayeredInjection,
  type InjectionBudgets,
  type LayerInjectionInput,
} from "../../src/memory/integration/injectionTransformer.ts";
import { providerSupportsSystemMessage } from "../../src/shared/utils/providerSystemMessages.ts";

interface ChatMessage extends Record<string, unknown> {
  role: string;
  content: string;
}

interface ChatBody extends Record<string, unknown> {
  model: string;
  messages: ChatMessage[];
}

const BUDGETS: InjectionBudgets = {
  l3CharBudget: 600,
  l2CharBudget: 600,
  l1CharBudget: 600,
  totalCharBudget: 8_000,
};

const LAYERS: LayerInjectionInput = {
  l3: [{ id: "l3-1", title: "Preferences", content: "User prefers dark mode" }],
  l2: [{ id: "l2-1", title: "UI notes", summary: "Navigation for display preferences" }],
  l1: [{ id: "l1-1", content: "Use dark mode", score: 0.9, tags: ["ui"] }],
  toolsGuide: "MEMORY TOOLS GUIDE",
};

function requestFor(provider: string): ChatBody {
  return {
    model: `${provider}-model`,
    messages: [{ role: "user", content: "Hello" }],
  };
}

function messagesFrom(body: Record<string, unknown>): ChatMessage[] {
  assert.ok(Array.isArray(body.messages));
  return body.messages as ChatMessage[];
}

describe("providerSupportsSystemMessage — GLM provider family (#1701)", () => {
  it("marks GLM, Z.AI, Qianfan, and o1 providers as system-role incompatible", () => {
    for (const provider of ["glm", "glmt", "glm-cn", "zai", "qianfan", "o1"]) {
      assert.equal(providerSupportsSystemMessage(provider), false, provider);
    }
    assert.equal(providerSupportsSystemMessage(" GLM "), false);
  });

  it("keeps the safe default for standard and unspecified providers", () => {
    assert.equal(providerSupportsSystemMessage("openai"), true);
    assert.equal(providerSupportsSystemMessage("anthropic"), true);
    assert.equal(providerSupportsSystemMessage(null), true);
    assert.equal(providerSupportsSystemMessage(undefined), true);
  });
});

describe("four-layer injection — GLM system-role fallback (#1701)", () => {
  it("renders one leading user reference for each incompatible provider", () => {
    for (const provider of ["glm", "glmt", "glm-cn", "zai", "qianfan"]) {
      const request = requestFor(provider);
      const before = JSON.stringify(request);
      const result = renderLayeredInjection(request, LAYERS, BUDGETS, { provider });
      const messages = messagesFrom(result.body);

      assert.equal(result.systemPlacement, "fallback-user-leading", provider);
      assert.equal(result.l1Placement, "leading-user", provider);
      assert.equal(messages.length, 2, provider);
      assert.equal(messages[0].role, "user", provider);
      assert.equal(
        messages.some((message) => message.role === "system"),
        false,
        provider
      );
      assert.match(messages[0].content, /\[L3 stable context\]/, provider);
      assert.match(messages[0].content, /\[L2 navigation index\]/, provider);
      assert.match(messages[0].content, /MEMORY TOOLS GUIDE/, provider);
      assert.match(messages[0].content, /<relevant-memories>/, provider);
      assert.match(messages[0].content, /Use dark mode/, provider);
      assert.equal(messages[1].content, "Hello", provider);
      assert.equal(JSON.stringify(request), before, `${provider} input was mutated`);
    }
  });

  it("uses a leading system message for providers that support the role", () => {
    for (const provider of ["openai", "anthropic"]) {
      const result = renderLayeredInjection(requestFor(provider), LAYERS, BUDGETS, {
        provider,
      });
      const messages = messagesFrom(result.body);

      assert.equal(result.systemPlacement, "leading-prepended", provider);
      assert.equal(messages[0].role, "system", provider);
      assert.match(messages[0].content, /\[L3 stable context\]/, provider);
      assert.equal(messages[1].role, "user", provider);
      assert.match(messages[1].content, /<relevant-memories>/, provider);
      assert.equal(messages[2].content, "Hello", provider);
    }
  });
});
