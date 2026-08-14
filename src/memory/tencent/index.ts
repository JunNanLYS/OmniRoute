/**
 * Selective port of TencentDB Agent Memory pure behavior modules.
 *
 * This subtree contains pure TypeScript helpers adapted from the TencentDB
 * Agent Memory project (https://github.com/your-org/tencentdb-agent-memory
 * — local mirror at D:/Project/TencentDB-Agent-Memory/, commit fe3230f).
 *
 * Source license: MIT — Copyright (C) 2026 Tencent.
 *
 * What is here, and what is NOT
 * -----------------------------
 * The port is *snapshot-style* and *minimal*. It contains only the pure
 * behavior modules whose contracts are stable:
 *
 *   - src/text/sanitize.ts              L0 capture / text-cleaning helpers
 *                                        (sanitizeText, stripCodeBlocks,
 *                                         escapeXmlTags, shouldCaptureL0,
 *                                         shouldExtractL1,
 *                                         looksLikePromptInjection,
 *                                         sanitizeJsonForParse,
 *                                         repairExtractionJson,
 *                                         parseExtractionScenes)
 *   - src/text/chunking.ts              Head/tail extraction chunking
 *                                        (applyOversizeStrategy,
 *                                         DEFAULT_OVERSIZE_OPTIONS)
 *   - src/text/fts.ts                   FTS5 query + tokenize + BM25 helper
 *                                        (buildFtsQuery, tokenizeForFts,
 *                                         bm25RankToScore,
 *                                         normalizeFtsTokens,
 *                                         ZH_STOP_WORDS)
 *   - src/prompts/l1-extraction.ts      L1 extraction system + user prompt
 *                                        (EXTRACT_MEMORIES_SYSTEM_PROMPT,
 *                                         EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
 *                                         getExtractMemoriesSystemPrompt,
 *                                         formatExtractionPrompt)
 *   - src/prompts/l1-dedup.ts           L1 dedup batch prompt
 *                                        (CONFLICT_DETECTION_SYSTEM_PROMPT,
 *                                         WORK_CONFLICT_DETECTION_SYSTEM_PROMPT,
 *                                         getConflictDetectionSystemPrompt,
 *                                         formatBatchConflictPrompt)
 *   - src/prompts/scene-extraction.ts   L2 scene system + user prompt
 *                                        (buildSceneSystemPrompt,
 *                                         buildWorkSceneSystemPrompt,
 *                                         getSceneSystemPrompt,
 *                                         buildSceneExtractionPrompt)
 *   - src/prompts/persona-generation.ts L3 persona / team doctrine prompt
 *                                        (PERSONA_SYSTEM_PROMPT,
 *                                         TEAM_MEMORY_SYSTEM_PROMPT,
 *                                         PERSONA_MAX_CHARS,
 *                                         TEAM_DOCTRINE_MAX_CHARS,
 *                                         buildPersonaPrompt)
 *   - src/prompts/offload-prompts.ts    L1/L1.5/L2 offload prompt families
 *                                        (L1_SYSTEM_PROMPT, buildL1UserPrompt,
 *                                         L15_SYSTEM_PROMPT,
 *                                         buildL15UserPrompt,
 *                                         L2_SYSTEM_PROMPT, buildL2UserPrompt,
 *                                         L1_PARAMS_MAX_LEN,
 *                                         L1_RESULT_MAX_LEN,
 *                                         L1_COMPRESS_THRESHOLD,
 *                                         L2_MMD_BUDGET_CHARS,
 *                                         L2_MMD_WARN_CHARS)
 *   - src/parsers/json-utils.ts         Tolerant JSON parsing
 *                                        (extractJson, extractMermaidFromFence)
 *   - src/parsers/l1-offload-parser.ts  L1 offload entry parser
 *                                        (parseL1OffloadResponse)
 *   - src/parsers/l15-parser.ts         L1.5 task-judgment parser
 *                                        (parseL15Response)
 *   - src/parsers/l2-offload-parser.ts  L2 MMD parser
 *                                        (parseL2OffloadResponse)
 *   - src/parsers/l1-dedup-parser.ts    L1 dedup decision parser
 *                                        (parseL1DedupResponse)
 *   - src/parsers/scene-action-parser.ts L2 scene action parser (UPDATE/MERGE/CREATE)
 *                                        (parseSceneExtractionResponse,
 *                                         isValidSceneFilename,
 *                                         SCENE_ACTION_PRIORITY,
 *                                         SCENE_BODY_MAX_CHARS,
 *                                         SCENE_DELETED_MARKER,
 *                                         recoverPersonaUpdateRequest)
 *   - src/recall/budget.ts              RRF + recall char budget helpers
 *                                        (rrfMerge, RRF_K,
 *                                         RECALL_TRUNCATION_SUFFIX,
 *                                         applyRecallBudget,
 *                                         deriveTotalRecallBudget,
 *                                         DEFAULT_MAX_CHARS_PER_MEMORY)
 *   - src/recall/memory-tools-guide.ts  Memory tools guide + per-turn budget
 *                                        (buildMemoryToolsGuide,
 *                                         MemoryToolCallBudget,
 *                                         MEMORY_TOOLS_PER_TURN_LIMIT,
 *                                         TOOL_MEMORY_SEARCH,
 *                                         TOOL_CONVERSATION_SEARCH)
 *   - src/scheduling/pipeline.ts        Pure L1/L2/L3 scheduling logic
 *                                        (shouldTriggerL1, shouldTriggerL2,
 *                                         shouldTriggerL3,
 *                                         advanceWarmup,
 *                                         DEFAULT_EVERY_N_CONVERSATIONS,
 *                                         DEFAULT_L3_EVERY_N_SCENES,
 *                                         DEFAULT_L3_MIN_MEMORIES_SINCE)
 *   - src/index.ts                      Public barrel re-exports
 *
 * What is intentionally NOT here:
 *
 *   - The full `extractL1Memories` runner (depends on CleanContextRunner +
 *     embedding service + storage adapter). The OmniRoute native memory
 *     worker has its own equivalent.
 *   - Storage adapters (Cos / local). The native worker persists via
 *     OmniRoute's existing DB modules.
 *   - Hooks (auto-recall, auto-capture, offload hooks). The native worker
 *     integrates via injection.ts / chatCore.
 *   - MCP server tools. The native worker exposes any new memory tools via
 *     the existing MCP/A2A infrastructure.
 *   - Anything that imports `ai` (the `ai-sdk` package) or the OpenClaw
 *     adapter. LLM calls live in the native worker.
 *
 * Attribution
 * -----------
 * Every vendored file carries an `ADAPTED FROM TencentDB Agent Memory (MIT)`
 * header with:
 *
 *   1. The exact upstream file path
 *   2. The source commit hash
 *   3. Local modifications list
 *
 * See ../LICENSE.txt for the verbatim Tencent MIT terms and ../SOURCE.txt
 * for the upstream file list with file-by-file modification notes.
 *
 * See ../../THIRD_PARTY_NOTICES.md for the umbrella attribution block and
 * the OpenClaw-helper reimplementation note (FTS5 helpers are not derived
 * from openclaw — see src/text/fts.ts).
 */

export * from "./text/sanitize.js";
export * from "./text/chunking.js";
export * from "./text/fts.js";

export * from "./prompts/l1-extraction.js";
export * from "./prompts/l1-dedup.js";
export * from "./prompts/scene-extraction.js";
export * from "./prompts/persona-generation.js";
export * from "./prompts/offload-prompts.js";

export * from "./parsers/json-utils.js";
export * from "./parsers/l1-offload-parser.js";
export * from "./parsers/l15-parser.js";
export * from "./parsers/l2-offload-parser.js";
export * from "./parsers/l1-dedup-parser.js";
export * from "./parsers/scene-action-parser.js";

export * from "./recall/budget.js";
export * from "./recall/memory-tools-guide.js";

export * from "./scheduling/pipeline.js";
