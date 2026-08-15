/**
 * Shared types + the fixture loader for the memory E2E harness.
 *
 * Fixtures live in `tests/fixtures/memory-e2e/case-*.json`. The harness
 * imports `history` through the canonical L0 import API, sends `finalUser`
 * through the real gateway, and (live profile only) hands the judge the
 * mandatory/negative points and per-layer rubrics.
 */

export interface FixtureMessage {
  role: "user" | "assistant";
  content: string;
}

export interface FixtureRubrics {
  l1: string;
  l2: string;
  l3: string;
}

export interface MemoryE2eFixture {
  /** Two-digit suite id ("01".."12"). */
  id: string;
  title: string;
  domain: string;
  /** Multi-turn history; MUST end with an assistant message. */
  history: FixtureMessage[];
  /** Sent through the real gateway (never imported directly). */
  finalUser: string;
  mandatoryPoints: string[];
  negativePoints: string[];
  rubrics: FixtureRubrics;
}

export class FixtureParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureParseError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new FixtureParseError(`${field} must be an array of strings`);
  return value.map((item) => {
    const text = nonEmptyString(item);
    if (!text) throw new FixtureParseError(`${field} entries must be non-empty strings`);
    return text;
  });
}

export function parseFixture(raw: unknown): MemoryE2eFixture {
  const record = asRecord(raw);
  if (!record) throw new FixtureParseError("fixture must be a JSON object");
  const id = nonEmptyString(record.id);
  if (!id || !/^\d{2}$/.test(id)) throw new FixtureParseError("fixture.id must be a two-digit id");
  const title = nonEmptyString(record.title);
  if (!title) throw new FixtureParseError("fixture.title is required");
  const domain = nonEmptyString(record.domain) ?? title;
  const finalUser = nonEmptyString(record.finalUser);
  if (!finalUser) throw new FixtureParseError("fixture.finalUser is required");

  if (!Array.isArray(record.history) || record.history.length < 2) {
    throw new FixtureParseError("fixture.history must have at least two messages");
  }
  const history: FixtureMessage[] = record.history.map((item, index) => {
    const message = asRecord(item);
    const role = message?.role;
    const content = nonEmptyString(message?.content);
    if (!message || (role !== "user" && role !== "assistant") || !content) {
      throw new FixtureParseError(
        `fixture.history[${index}] must be { role: "user"|"assistant", content: string }`
      );
    }
    return { role, content };
  });
  if (history[0]!.role !== "user") {
    throw new FixtureParseError("fixture.history must start with a user message");
  }
  if (history.at(-1)!.role !== "assistant") {
    throw new FixtureParseError("fixture.history must end with an assistant message");
  }

  const rubricsRecord = asRecord(record.rubrics);
  const rubricL1 = rubricsRecord ? nonEmptyString(rubricsRecord.l1) : null;
  const rubricL2 = rubricsRecord ? nonEmptyString(rubricsRecord.l2) : null;
  const rubricL3 = rubricsRecord ? nonEmptyString(rubricsRecord.l3) : null;
  if (!rubricL1 || !rubricL2 || !rubricL3) {
    throw new FixtureParseError("fixture.rubrics must define l1, l2, and l3");
  }

  return {
    id,
    title,
    domain,
    history,
    finalUser,
    mandatoryPoints: stringArray(record.mandatoryPoints ?? [], "fixture.mandatoryPoints"),
    negativePoints: stringArray(record.negativePoints ?? [], "fixture.negativePoints"),
    rubrics: { l1: rubricL1, l2: rubricL2, l3: rubricL3 },
  };
}

export async function loadFixtures(dir: string, filter?: string): Promise<MemoryE2eFixture[]> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^case-\d{2}.*\.json$/.test(name))
    .sort();
  if (files.length === 0) throw new FixtureParseError(`no fixtures found in ${dir}`);
  const fixtures: MemoryE2eFixture[] = [];
  for (const name of files) {
    const fixture = parseFixture(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    if (!filter || filter === fixture.id || name.includes(filter)) fixtures.push(fixture);
  }
  if (fixtures.length === 0) throw new FixtureParseError(`no fixture matched filter: ${filter}`);
  return fixtures;
}
