# `src/memory/tencent/`

Selective port of pure behavior modules from TencentDB Agent Memory
(MIT, Copyright (C) 2026 Tencent). See `../../../THIRD_PARTY_NOTICES.md`
for the umbrella attribution block.

## Contents

```
src/memory/tencent/
├── README/
│   ├── LICENSE.txt   — verbatim upstream MIT terms
│   ├── SOURCE.txt    — file-by-file upstream → local mapping
│   └── README.md     — this file
├── index.ts          — public barrel
├── text/
│   ├── sanitize.ts   — L0 capture / text-cleaning helpers
│   ├── chunking.ts   — head/tail extraction chunking
│   └── fts.ts        — FTS5 query + tokenize + BM25 helper
│                       (reimplemented from scratch, see THIRD_PARTY_NOTICES.md)
├── prompts/
│   ├── l1-extraction.ts     — L1 extraction system + user prompt
│   ├── l1-dedup.ts          — L1 dedup batch prompt
│   ├── scene-extraction.ts  — L2 scene system + user prompt
│   ├── persona-generation.ts — L3 persona / team doctrine prompt
│   └── offload-prompts.ts   — L1 / L1.5 / L2 offload prompt families
├── parsers/
│   ├── json-utils.ts          — tolerant JSON parsing
│   ├── l1-offload-parser.ts   — L1 offload entry parser
│   ├── l15-parser.ts          — L1.5 task-judgment parser
│   ├── l2-offload-parser.ts   — L2 MMD parser
│   ├── l1-dedup-parser.ts     — L1 dedup decision parser
│   └── scene-action-parser.ts — L2 scene action parser (UPDATE/MERGE/CREATE)
├── recall/
│   ├── budget.ts             — RRF + recall char-budget helpers
│   └── memory-tools-guide.ts — memory tools guide + per-turn budget
└── scheduling/
    └── pipeline.ts           — pure L1/L2/L3 scheduling logic
```

## Usage

Import from the barrel:

```ts
import {
  stripCodeBlocks,
  applyOversizeStrategy,
  buildFtsQuery,
  parseL1OffloadResponse,
  parseL15Response,
  parseL2OffloadResponse,
  parseL1DedupResponse,
  parseSceneExtractionResponse,
  shouldTriggerL1,
  shouldTriggerL2,
  shouldTriggerL3,
  rrfMerge,
  applyRecallBudget,
  buildMemoryToolsGuide,
  RRF_K,
  PERSONA_MAX_CHARS,
  TEAM_DOCTRINE_MAX_CHARS,
} from "@/memory/tencent";
```

## What this subtree is NOT

This is **not** a wholesale facade, not a fork, and not a full upstream
re-publication. It does not include:

- the upstream LLM runner (the native OmniRoute memory worker is
  responsible for LLM dispatch via the project's own
  OpenAI-compatible handler stack)
- storage adapters (Cos / local / tcvdb)
- the OpenClaw host adapter / hooks (auto-capture, auto-recall, offload
  hooks)
- MCP server tools
- anything that imports the `ai` package, OpenClaw adapter, or
  `@node-rs/jieba`

## Attribution

Every vendored `.ts` file carries an `ADAPTED FROM TencentDB Agent
Memory (MIT)` header. The umbrella attribution block is at
`../../../THIRD_PARTY_NOTICES.md`. The verbatim upstream MIT terms are
at `README/LICENSE.txt`. The per-file modification log is at
`README/SOURCE.txt`.
