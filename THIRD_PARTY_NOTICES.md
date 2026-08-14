# Third-Party Notices

This document lists third-party software components incorporated into this
project, with their licenses, sources, and any modifications made by the
OmniRoute team.

## Scope

This project selectively ports a small set of **pure behavior modules** from
TencentDB Agent Memory. The port is **snapshot-style**, **minimal**, and
**non-fork**: the OmniRoute repo does not advertise itself as a fork of
TencentDB Agent Memory, does not re-publish the full upstream project, and
does not ship any of TencentDB's storage adapters (Cos / local / tcvdb) or
its OpenClaw host plugin. Only modules whose contracts are stable and whose
dependencies are limited to the standard library are ported.

Publication scope of this repo:

- Source files live under `src/memory/tencent/`.
- Each vendored `.ts` file carries an `ADAPTED FROM TencentDB Agent Memory (MIT)`
  header with the upstream path, source commit, and local modifications.
- The verbatim upstream MIT terms are reproduced at
  `src/memory/tencent/README/LICENSE.txt`.
- The upstream file list and per-file modification log live at
  `src/memory/tencent/README/SOURCE.txt`.
- This file (the umbrella attribution block) lives at the repo root.

---

## TencentDB Agent Memory

| Field              | Value                                              |
| ------------------ | -------------------------------------------------- |
| Component name     | TencentDB Agent Memory (MemoryCore)                |
| Used here          | `src/memory/tencent/**` (pure behavior modules)    |
| Source URL         | https://github.com/your-org/tencentdb-agent-memory |
| Local mirror       | `D:/Project/TencentDB-Agent-Memory/`               |
| Source commit      | `fe3230f` ("Update package.json")                  |
| License            | MIT                                                |
| License URL        | https://opensource.org/licenses/MIT                |
| Upstream copyright | Copyright (C) 2026 Tencent. All rights reserved.   |
| Verbatim terms     | `src/memory/tencent/README/LICENSE.txt`            |

### What is adapted

The port reproduces, with minor local adaptations, the following upstream
files:

| Upstream file                                                            | Local file                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `MemoryCore/src/utils/sanitize.ts`                                       | `src/memory/tencent/text/sanitize.ts`                                                    |
| `MemoryCore/src/core/skill/conversation-add/oversize-strategy.ts`        | `src/memory/tencent/text/chunking.ts`                                                    |
| `MemoryCore/src/core/prompts/l1-extraction.ts`                           | `src/memory/tencent/prompts/l1-extraction.ts`                                            |
| `MemoryCore/src/core/prompts/l1-dedup.ts`                                | `src/memory/tencent/prompts/l1-dedup.ts`                                                 |
| `MemoryCore/src/core/prompts/scene-extraction.ts`                        | `src/memory/tencent/prompts/scene-extraction.ts`                                         |
| `MemoryCore/src/core/prompts/persona-generation.ts`                      | `src/memory/tencent/prompts/persona-generation.ts`                                       |
| `MemoryCore/src/offload/local-llm/prompts/l1-prompt.ts`                  | `src/memory/tencent/prompts/offload-prompts.ts`                                          |
| `MemoryCore/src/offload/local-llm/prompts/l15-prompt.ts`                 | `src/memory/tencent/prompts/offload-prompts.ts`                                          |
| `MemoryCore/src/offload/local-llm/prompts/l2-prompt.ts`                  | `src/memory/tencent/prompts/offload-prompts.ts`                                          |
| `MemoryCore/src/offload/local-llm/parsers/json-utils.ts`                 | `src/memory/tencent/parsers/json-utils.ts`                                               |
| `MemoryCore/src/offload_server/parsers/json-utils.ts`                    | `src/memory/tencent/parsers/json-utils.ts`                                               |
| `MemoryCore/src/offload/local-llm/parsers/l1-parser.ts`                  | `src/memory/tencent/parsers/l1-offload-parser.ts`                                        |
| `MemoryCore/src/offload_server/parsers/l1-parser.ts`                     | `src/memory/tencent/parsers/l1-offload-parser.ts`                                        |
| `MemoryCore/src/offload_server/parsers/l15-parser.ts`                    | `src/memory/tencent/parsers/l15-parser.ts`                                               |
| `MemoryCore/src/offload_server/parsers/l2-parser.ts`                     | `src/memory/tencent/parsers/l2-offload-parser.ts`                                        |
| `MemoryCore/src/core/record/l1-dedup.ts` (action-application pattern)    | `src/memory/tencent/parsers/l1-dedup-parser.ts`                                          |
| `MemoryCore/src/core/scene/scene-extractor.ts` (action contract)         | `src/memory/tencent/parsers/scene-action-parser.ts`                                      |
| `MemoryCore/src/core/store/search-utils.ts`                              | `src/memory/tencent/recall/budget.ts`                                                    |
| `MemoryCore/src/core/hooks/auto-recall.ts` (recall budget + tools guide) | `src/memory/tencent/recall/budget.ts`, `src/memory/tencent/recall/memory-tools-guide.ts` |
| `MemoryCore/src/utils/checkpoint.ts` (warmup ladder)                     | `src/memory/tencent/scheduling/pipeline.ts`                                              |

Full per-file modification log: `src/memory/tencent/README/SOURCE.txt`.

### Modifications summary

- All prompt strings are reproduced **verbatim**. They are stable contracts;
  any drift changes LLM behavior.
- Parser logic is preserved. Tool-name constants and a few local-only type
  renames (e.g. `OversizeMessage` → `OversizeChunkMessage`) avoid collision
  with the OmniRoute domain vocabulary.
- Behavior emitted as file-tool calls (read/write/edit against a sandboxed
  `scene_blocks/` directory) is reframed as structured-action return values.
  This avoids the OpenClaw host-adapter dependency.
- Filename rules, body caps (1500 chars/scene, 2000 chars/persona,
  1200 chars/team doctrine), the MMD 4000-char budget, the per-memory
  600-char recall budget, the ≤3 calls/turn semantic, the UPDATE > MERGE
  > CREATE priority, and the warmup doubling ladder (1 → 2 → 4 → …) are
  > all preserved.
- No `ai-sdk`, / `ai` / OpenClaw / `@node-rs/jieba` runtime dependencies
  are pulled in by this subtree. (The native OmniRoute memory worker is
  responsible for LLM dispatch via the project's own OpenAI-compatible
  handler stack.)
- No full upstream project is published re-published; only the pure
  helpers above.

### Evidence

Local repo commit inspected during the port:

```
$ git -C D:/Project/TencentDB-Agent-Memory log --oneline -1
fe3230f Update package.json
```

Local repo LICENSE inspected during the port:

```
$ head -5 D:/Project/TencentDB-Agent-Memory/LICENSE
Tencent is pleased to support the open source community by making
TencentDB Agent Memory available.
Copyright (C) 2026 Tencent.  All rights reserved.
TencentDB Agent Memory is licensed under the MIT.
```

### License compatibility

The Tencent MIT terms grant an unrestricted license to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software,
subject to retaining the copyright notice. This is compatible with the
OmniRoute MIT license under which this repo is published. The only
requirement is that the upstream copyright + permission notice travel with
substantial portions of the Software — every adapted file in this subtree
carries both.

---

## OpenClaw-helper FTS5 utilities

The upstream TencentDB code references an "openclaw core hybrid.ts"
file containing FTS5 query/tokenization helpers. That file is not present
in the TencentDB repo (no source, no LICENSE file located during the
port), so we did **not** copy those helpers into this subtree. Instead,
the small normalization/FTS5 helpers in `src/memory/tencent/text/fts.ts`
are **reimplemented from scratch** with the same observable behavior
(token-stream shape, quoted OR-joined MATCH output, codepoint-based
truncation, BM25-rank-to-score formula, small Chinese stop-word set).

| Field              | Value                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| Component name     | "openclaw core hybrid.ts" (referenced by name in upstream comments)               |
| Used here          | `src/memory/tencent/text/fts.ts` — **reimplemented from scratch**, no code copied |
| Source URL         | n/a — file not present in upstream TencentDB repo                                 |
| Local mirror       | n/a                                                                               |
| Source commit      | n/a                                                                               |
| License            | n/a — no license file located during the port; we did not copy any code           |
| Upstream copyright | n/a                                                                               |
| Verbatim terms     | n/a                                                                               |

### What is implemented

- `normalizeFtsTokens` — Unicode-regex split fallback + optional segmenter
  hook + Chinese stop-word filtering.
- `buildFtsQuery` — quoted OR-joined MATCH operand. Returns null on empty
  input.
- `tokenizeForFts` — space-joined index-side tokens. Pass-through when no
  segmenter is provided.
- `bm25RankToScore` — `[0, 1]` score from BM25 rank, with a small constant
  floor for non-finite ranks.
- `ZH_STOP_WORDS` — small high-frequency Chinese stop-word set.

### Evidence

The upstream comment that references `hybrid.ts` is at
`MemoryCore/src/core/store/sqlite.ts:148` and `:297`. No
`hybrid.ts` source file is shipped in the TencentDB repo at any version
of `MemoryCore/src/` searched during the port. No LICENSE file for the
"openclaw core" component is shipped in the upstream tree either. We
therefore treat the upstream helpers as evidence-of-behavior only and
reimplemented the small surface area we needed.

### License risk and decision

Because no upstream source / LICENSE could be verified for
"openclaw core hybrid.ts", the conservative choice was not to copy any
code. The reimplementation is small, dependency-free, and behavior-
equivalent at the public API level.

---

## Other third-party components

This OmniRoute repo at large depends on a number of third-party packages.
They are listed in `package.json` and tracked by the regular lockfile.
Their licenses are compatible with the project MIT license. None of
those packages are reproduced verbatim inside this subtree.
