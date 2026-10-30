import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

export const SERVICE_LOG_ARCHIVE_THRESHOLD_BYTES = 50 * 1024 * 1024;
const SERVICE_LOG_NAMES = ["service.log", "service-error.log"];
const BROTLI_QUALITY = 6;

/**
 * Archives a service log that outgrew the threshold into `<name>-until-<date>.log.br` (Brotli Q6) and empties it.
 * launchd and systemd keep the log open, so the file is truncated in place, never renamed. The archive is written
 * under a temporary name and moved into place first, so a failed compression leaves the original log untouched.
 */
export async function archiveOversizedServiceLogs(
  logDirectory,
  { thresholdBytes = SERVICE_LOG_ARCHIVE_THRESHOLD_BYTES, now = new Date() } = {},
) {
  const archives = [];
  for (const name of SERVICE_LOG_NAMES) {
    const logPath = path.join(logDirectory, name);
    const size = regularFileSize(logPath);
    if (size === undefined || size <= thresholdBytes) continue;
    const archivePath = uniqueArchivePath(logDirectory, name, now);
    const temporaryPath = `${archivePath}.${process.pid}.tmp`;
    try {
      await pipeline(
        fs.createReadStream(logPath, { end: size - 1 }),
        zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }),
        fs.createWriteStream(temporaryPath, { mode: 0o600 }),
      );
      fs.renameSync(temporaryPath, archivePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
    fs.truncateSync(logPath, 0);
    archives.push({ logPath, archivePath, bytes: size });
  }
  return archives;
}

function regularFileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function uniqueArchivePath(logDirectory, name, now) {
  const base = name.replace(/\.log$/u, "");
  const date = now.toISOString().slice(0, 10);
  for (let attempt = 0; ; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidate = path.join(logDirectory, `${base}-until-${date}${suffix}.log.br`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
