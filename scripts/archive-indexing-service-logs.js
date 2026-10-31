#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { archiveOversizedServiceLogs } from "./indexing-service-log-archive.js";

const agentDirectory = process.env.P_CODING_AGENT_DIR ?? path.join(os.homedir(), ".p", "agent");
const logDirectory = path.join(agentDirectory, "indexing-service", "logs");

for (const archive of await archiveOversizedServiceLogs(logDirectory)) {
  console.log(`Archived ${archive.bytes} bytes of ${path.basename(archive.logPath)} to ${archive.archivePath}`);
}
