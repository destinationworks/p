import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { enableIndexingForRepo } from "../src/core/indexed-repos.ts";
import { createSemanticSearchServiceOptions } from "../src/core/tools/semantic-search.ts";

describe("semantic_search with a remote embedder", () => {
  it("lets the remote embedder fall back by waking the daemon's local embedding server", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p-semantic-remote-"));
    const agentDir = path.join(root, "agent");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "code-rag.json"),
      JSON.stringify({
        remoteBackendsAllowed: true,
        remoteEmbeddingUrl: "https://192.168.8.167:11450",
        remoteEmbeddingModel: "mini-pc-2/qwen3-embedding-0.6b",
      }),
    );
    enableIndexingForRepo(workspace, agentDir);
    const previousAgentDir = process.env[ENV_AGENT_DIR];
    process.env[ENV_AGENT_DIR] = agentDir;
    try {
      const options = createSemanticSearchServiceOptions(workspace, agentDir);
      expect(options).toMatchObject({ manageLocalBackends: false, allowSearchRefresh: false });
      const prepare = options.prepareEmbeddingFallback;
      expect(prepare).toBeTypeOf("function");
      // Without localFallback a remote-first readiness wait returns at once; the
      // fallback hook instead probes the local server, so an aborted probe rejects.
      const controller = new AbortController();
      const reason = new Error("search cancelled");
      controller.abort(reason);
      await expect(prepare?.(controller.signal)).rejects.toBe(reason);
    } finally {
      if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
      else process.env[ENV_AGENT_DIR] = previousAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
