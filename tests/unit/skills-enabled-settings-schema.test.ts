import test from "node:test";
import assert from "node:assert/strict";

import { updateSettingsSchema } from "../../src/shared/validation/settingsSchemas.ts";

test("generic settings schema accepts the independent skillsEnabled flag", () => {
  assert.deepEqual(updateSettingsSchema.parse({ skillsEnabled: true }), { skillsEnabled: true });
  assert.deepEqual(updateSettingsSchema.parse({ skillsEnabled: false }), { skillsEnabled: false });
});
