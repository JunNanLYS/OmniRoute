/**
 * LLM judge for the live memory-E2E profile.
 *
 * The judge runs through the real gateway with a dedicated key (capture and
 * injection disabled) at temperature 0, `response_format: json_object`, and a
 * prompt that embeds the strict JSON output contract. Per the design doc, a
 * JSON parse or schema validation failure is recorded as an evaluation
 * failure — it is never silently retried.
 */
import { httpJson } from "./http.ts";

export interface JudgeFixtureInput {
  fixtureId: string;
  title: string;
  /** Real L0 transcript (user/assistant lines, in order). */
  transcript: string;
  l1Memories: string[];
  l2Scenes: string[];
  l3Persona: string;
  mandatoryPoints: string[];
  negativePoints: string[];
  rubrics: { l1: string; l2: string; l3: string };
}

export interface JudgeVerdict {
  scores: { l1: number; l2: number; l3: number };
  /** One score per mandatory point, same order. */
  mandatoryPointScores: number[];
  /** Negative points that were incorrectly retained or promoted. */
  negativeViolations: string[];
  hallucination: boolean;
  rationale: string;
  evidence: string[];
}

export type JudgeParseResult = { ok: true; verdict: JudgeVerdict } | { ok: false; error: string };

const SCORE_MIN = 1;
const SCORE_MAX = 5;

export function buildJudgeMessages(
  input: JudgeFixtureInput
): Array<{ role: "system" | "user"; content: string }> {
  const system = [
    "你是记忆系统的语义评审员（judge）。",
    "根据给定的真实对话记录（L0 transcript）与蒸馏产物（L1 记忆、L2 场景、L3 人设），对四层记忆系统输出严格评分。",
    "只输出一个 json 对象，不要任何多余文本。json 结构如下：",
    "{",
    '  "scores": { "l1": 1-5, "l2": 1-5, "l3": 1-5 },',
    '  "mandatoryPointScores": [与必要点顺序一致的分次数组，每项 1-5],',
    '  "negativeViolations": [被错误保留或提升的负面点描述],',
    '  "hallucination": true|false,',
    '  "rationale": "评分理由",',
    '  "evidence": ["引用蒸馏产物中的原句作为证据"]',
    "}",
    "评分标准：5=完全准确完整；4=基本准确；3=部分准确；2=明显缺失或错误；1=严重错误。",
    "若蒸馏产物中出现对话中从未提及的事实，hallucination 必须为 true。",
  ].join("\n");

  const user = [
    `# 套件 ${input.fixtureId}：${input.title}`,
    "",
    "## 真实对话记录（L0）",
    input.transcript,
    "",
    "## L1 记忆",
    ...(input.l1Memories.length ? input.l1Memories.map((m) => `- ${m}`) : ["（无）"]),
    "",
    "## L2 场景",
    ...(input.l2Scenes.length ? input.l2Scenes.map((s) => `- ${s}`) : ["（无）"]),
    "",
    "## L3 人设",
    input.l3Persona || "（无）",
    "",
    "## 必要点（每条都必须打分，顺序一致）",
    ...input.mandatoryPoints.map((p, i) => `${i + 1}. ${p}`),
    "",
    "## 负面点（不应被保留或提升）",
    ...(input.negativePoints.length ? input.negativePoints.map((p) => `- ${p}`) : ["（无）"]),
    "",
    "## 分层评审标准",
    `- L1：${input.rubrics.l1}`,
    `- L2：${input.rubrics.l2}`,
    `- L3：${input.rubrics.l3}`,
    "",
    "请按要求输出严格 json。",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseScore(value: unknown): number | null {
  const score = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(score) || score < SCORE_MIN || score > SCORE_MAX) return null;
  return score;
}

/** Tolerate fenced json blocks; anything else that is not JSON fails. */
function extractJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fenced extraction
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function parseJudgeVerdict(raw: string, mandatoryPointCount: number): JudgeParseResult {
  const parsed = extractJson(raw);
  const record = asRecord(parsed);
  if (!record) return { ok: false, error: "judge response is not JSON" };

  const scoresRecord = asRecord(record.scores);
  const l1 = parseScore(scoresRecord?.l1);
  const l2 = parseScore(scoresRecord?.l2);
  const l3 = parseScore(scoresRecord?.l3);
  if (l1 === null || l2 === null || l3 === null) {
    return { ok: false, error: "scores.l1/l2/l3 must be integers in 1..5" };
  }

  const points = Array.isArray(record.mandatoryPointScores) ? record.mandatoryPointScores : null;
  if (!points || points.length !== mandatoryPointCount) {
    return {
      ok: false,
      error: `mandatoryPointScores must contain exactly ${mandatoryPointCount} entries (got ${points?.length ?? 0})`,
    };
  }
  const mandatoryPointScores: number[] = [];
  for (const value of points) {
    const score = parseScore(value);
    if (score === null) {
      return { ok: false, error: "mandatoryPointScores entries must be integers in 1..5" };
    }
    mandatoryPointScores.push(score);
  }

  const negativeViolations = Array.isArray(record.negativeViolations)
    ? record.negativeViolations.filter((item): item is string => typeof item === "string")
    : [];
  const rationale = typeof record.rationale === "string" ? record.rationale : "";
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.filter((item): item is string => typeof item === "string")
    : [];

  return {
    ok: true,
    verdict: {
      scores: { l1, l2, l3 },
      mandatoryPointScores,
      negativeViolations,
      hallucination: record.hallucination === true,
      rationale,
      evidence,
    },
  };
}

export interface ThresholdFixtureVerdict {
  fixtureId: string;
  verdict: JudgeVerdict;
}

export interface ThresholdEvaluation {
  passed: boolean;
  violations: string[];
  overallMean: number;
  layerMeans: { l1: number; l2: number; l3: number };
}

/**
 * Spec thresholds: overall mean >= 4.5, every layer mean >= 4.5, every
 * mandatory point >= 4, and any hallucination vetoes the evaluation.
 */
export function evaluateEvaluationThresholds(
  fixtures: ThresholdFixtureVerdict[]
): ThresholdEvaluation {
  const violations: string[] = [];
  const count = fixtures.length;
  const mean = (values: number[]): number =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  const overallMean = mean(
    fixtures.flatMap((f) => [f.verdict.scores.l1, f.verdict.scores.l2, f.verdict.scores.l3])
  );
  const layerMeans = {
    l1: mean(fixtures.map((f) => f.verdict.scores.l1)),
    l2: mean(fixtures.map((f) => f.verdict.scores.l2)),
    l3: mean(fixtures.map((f) => f.verdict.scores.l3)),
  };

  if (count === 0) violations.push("no judged fixtures");
  if (overallMean < 4.5) violations.push(`overall mean ${overallMean.toFixed(2)} < 4.5`);
  for (const layer of ["l1", "l2", "l3"] as const) {
    if (layerMeans[layer] < 4.5) {
      violations.push(`${layer} layer mean ${layerMeans[layer].toFixed(2)} < 4.5`);
    }
  }
  for (const fixture of fixtures) {
    fixture.verdict.mandatoryPointScores.forEach((score, index) => {
      if (score < 4) {
        violations.push(
          `fixture ${fixture.fixtureId} mandatory point ${index + 1} scored ${score} < 4`
        );
      }
    });
    if (fixture.verdict.hallucination) {
      violations.push(`fixture ${fixture.fixtureId} hallucination veto`);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    overallMean,
    layerMeans,
  };
}

/** One judged gateway call. Parse/validation failure is terminal — no retry. */
export async function runJudge(options: {
  baseUrl: string;
  judgeKey: string;
  model: string;
  input: JudgeFixtureInput;
}): Promise<JudgeVerdict> {
  const response = await httpJson<{
    choices?: Array<{ message?: { content?: string } }>;
  }>(`${options.baseUrl}/v1/chat/completions`, {
    method: "POST",
    bearer: options.judgeKey,
    body: JSON.stringify({
      model: options.model,
      stream: false,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: buildJudgeMessages(options.input),
    }),
  });
  const content = response.body.choices?.[0]?.message?.content;
  if (!response.ok || typeof content !== "string") {
    throw new Error(
      `judge call failed: HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`
    );
  }
  const parsed = parseJudgeVerdict(content, options.input.mandatoryPoints.length);
  if (!parsed.ok) {
    throw new Error(`judge verdict invalid: ${parsed.error}`);
  }
  return parsed.verdict;
}
