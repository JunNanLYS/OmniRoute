/**
 * Loopback mock upstream for the smoke profile.
 *
 * Serves an OpenAI-compatible surface on 127.0.0.1 (models + chat
 * completions). Every chat request is classified by the system-prompt marker
 * of the distillation handlers (or treated as a gateway chat turn) and
 * answered with a canned, contract-valid payload so the L1→L2→L3 pipeline
 * completes deterministically with zero external cost. The live profile does
 * NOT use this module — it points the provider at a real upstream.
 */
import http from "node:http";
import net from "node:net";

export type MockCallKind = "l1" | "l2" | "l3" | "chat";

export interface MockCallLogEntry {
  kind: MockCallKind;
  at: number;
  model: string;
  preview: string;
}

const L1_MARKER = "Extract durable memories";
const L2_MARKER = "Update one durable scene";
const L3_MARKER = "Synthesize the supplied scenes";

/**
 * Decide which pipeline stage is calling. The distillation handlers pin a
 * distinctive system prompt per kind (`loadTencentPrompt` in
 * `src/memory/distillation/handlers.ts`); gateway chat turns carry either no
 * system message or an unrelated one.
 */
export function classifyMockCall(body: unknown): MockCallKind {
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as { messages?: unknown })
      : null;
  const messages = Array.isArray(record?.messages) ? record!.messages : [];
  for (const item of messages) {
    const message =
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? (item as { role?: unknown; content?: unknown })
        : null;
    if (message?.role !== "system" || typeof message.content !== "string") continue;
    if (message.content.includes(L1_MARKER)) return "l1";
    if (message.content.includes(L2_MARKER)) return "l2";
    if (message.content.includes(L3_MARKER)) return "l3";
  }
  return "chat";
}

/** First two `user: ...` lines of a distillation conversation slice. */
function userLinesFromConversation(conversation: string): string[] {
  return conversation
    .split("\n")
    .filter((line) => line.startsWith("user: "))
    .map((line) => line.slice("user: ".length).trim())
    .filter(Boolean);
}

/**
 * Canned, contract-valid model output per pipeline stage.
 *
 * L1 memories are derived from the request's own conversation slice (the
 * first two user turns): the harness reuses one owner across suites, and the
 * L1 apply pipeline keys on `sceneName + type + content`. Two fixtures that
 * receive identical canned content would collide on the pipeline key and
 * merge their sourceMessageIds across sessions. Deriving the content from
 * the conversation keeps every session's L1 memories distinct.
 */
export function buildMockAssistantText(kind: MockCallKind, conversation = ""): string {
  switch (kind) {
    case "l1": {
      const users = userLinesFromConversation(conversation);
      const first = users[0] ?? "用户提供了一条新的项目事实。";
      const second = users[1] ?? "用户补充了一条新的工程约定。";
      return JSON.stringify([
        {
          scene_name: "项目会话",
          message_ids: [],
          memories: [
            {
              content: first.slice(0, 200),
              type: "work_fact",
              priority: 80,
              source_message_ids: [],
              metadata: {},
            },
            {
              content: second.slice(0, 200),
              type: "work_fact",
              priority: 75,
              source_message_ids: [],
              metadata: {},
            },
          ],
        },
      ]);
    }
    case "l2":
      return JSON.stringify({
        summary: "工程协作约定：TypeScript strict、pnpm、Nx。",
        tags: ["typescript", "pnpm", "nx"],
        content:
          "团队新服务统一使用 TypeScript（strict 模式），包管理用 pnpm，monorepo 用 Nx；评审优先关注类型安全与边界条件。",
        heat: 0.7,
        persona_update_requested: true,
      });
    case "l3":
      return JSON.stringify({
        content:
          "该用户的团队约定：新服务统一使用 TypeScript 并启用 strict 模式；包管理用 pnpm；monorepo 用 Nx；代码评审优先关注类型安全与边界条件。回答代码问题时默认给出 TypeScript 示例。",
        prompt_mode: "chat",
      });
    case "chat":
    default:
      return "已整理为团队规范：新服务统一使用 TypeScript（strict 模式）、pnpm 管理依赖、Nx 搭建 monorepo，评审优先关注类型安全与边界条件。之后的新项目默认照此执行。";
  }
}

export const MOCK_MODEL_ID = "mock-model";

export class MemoryMockUpstream {
  private server: http.Server | null = null;
  private _baseUrl = "";
  private readonly calls: MockCallLogEntry[] = [];

  get baseUrl(): string {
    if (!this._baseUrl) throw new Error("mock upstream not started");
    return this._baseUrl;
  }

  get callLog(): readonly MockCallLogEntry[] {
    return this.calls;
  }

  async start(): Promise<string> {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") {
          probe.close();
          reject(new Error("failed to allocate mock upstream port"));
          return;
        }
        const { port: freePort } = address;
        probe.close((err) => (err ? reject(err) : resolve(freePort)));
      });
    });
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    this._baseUrl = `http://127.0.0.1:${port}/v1`;
    return this._baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown = {};
    try {
      parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      parsed = {};
    }

    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MOCK_MODEL_ID, object: "model" }] }));
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
      const kind = classifyMockCall(parsed);
      const conversation =
        typeof (parsed as { messages?: unknown }).messages === "object"
          ? ((parsed as { messages?: unknown }).messages as unknown[])
              .filter((m): m is { role: string; content: string } =>
                Boolean(
                  m &&
                  typeof m === "object" &&
                  (m as { role?: unknown }).role === "user" &&
                  typeof (m as { content?: unknown }).content === "string"
                )
              )
              .map((m) => m.content)
              .join("\n")
          : "";
      const text = buildMockAssistantText(kind, conversation);
      const requestModel =
        typeof (parsed as { model?: unknown }).model === "string"
          ? String((parsed as { model: string }).model)
          : MOCK_MODEL_ID;
      this.calls.push({
        kind,
        at: Date.now(),
        model: requestModel,
        preview: text.slice(0, 120),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `mockcmpl_${this.calls.length}`,
          object: "chat.completion",
          model: requestModel,
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 },
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `mock: unhandled ${req.method} ${req.url}` } }));
  }
}
