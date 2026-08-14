const PROVIDERS_WITHOUT_SYSTEM_MESSAGE = new Set([
  "o1",
  "o1-mini",
  "o1-preview",
  "glm",
  "glmt",
  "glm-cn",
  "zai",
  "qianfan",
]);

const PROVIDERS_SYSTEM_MUST_BE_FIRST = new Set(["xiaomi-mimo", "mimo"]);

export function providerSupportsSystemMessage(provider: string | null | undefined): boolean {
  if (!provider) return true;
  return !PROVIDERS_WITHOUT_SYSTEM_MESSAGE.has(provider.toLowerCase().trim());
}

export function systemMessageMustBeFirst(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return PROVIDERS_SYSTEM_MUST_BE_FIRST.has(provider.toLowerCase().trim());
}
