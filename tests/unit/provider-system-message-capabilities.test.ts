import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  providerSupportsSystemMessage,
  systemMessageMustBeFirst,
} from "../../src/shared/utils/providerSystemMessages.ts";

describe("provider system-message capabilities", () => {
  it("keeps system-role support defaults and known exclusions", () => {
    assert.equal(providerSupportsSystemMessage("anthropic"), true);
    assert.equal(providerSupportsSystemMessage(" GLM "), false);
    assert.equal(providerSupportsSystemMessage("qianfan"), false);
    assert.equal(providerSupportsSystemMessage(null), true);
  });

  it("flags only strict-first providers", () => {
    assert.equal(systemMessageMustBeFirst("xiaomi-mimo"), true);
    assert.equal(systemMessageMustBeFirst(" MIMO "), true);
    assert.equal(systemMessageMustBeFirst("anthropic"), false);
    assert.equal(systemMessageMustBeFirst(undefined), false);
  });
});
