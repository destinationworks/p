import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@dst0/p-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@dst0/p-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export function shortenPath(path: unknown): string {
  if (typeof path !== "string") return "";
  const home = os.homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
  if (!getCapabilities().hyperlinks) return styledText;
  const absolutePath = resolvePath(rawPath, cwd);
  return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
  return text.replace(/\r/g, "");
}

export function stripHarnessMessages(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("Verification evidence handle:"))
    .join("\n");
}

export function getTextOutput(
  result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
  showImages: boolean,
  showHarnessMessages = false,
): string {
  if (!result || !result.content || result.content.length === 0) return "";

  let output = "";
  let imageIndicators = "";

  const caps = getCapabilities();
  const shouldProcessImages = !caps.images || !showImages;

  let isFirstText = true;
  let isFirstImage = true;

  for (let i = 0; i < result.content.length; i++) {
    const c = result.content[i];
    if (c.type === "text") {
      if (!isFirstText) {
        output += "\n";
      }
      output += sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "");
      isFirstText = false;
    } else if (c.type === "image" && shouldProcessImages) {
      if (!isFirstImage) {
        imageIndicators += "\n";
      }
      const mimeType = c.mimeType ?? "image/unknown";
      const dims = c.data && c.mimeType ? (getImageDimensions(c.data, c.mimeType) ?? undefined) : undefined;
      imageIndicators += imageFallback(mimeType, dims);
      isFirstImage = false;
    }
  }

  if (!showHarnessMessages && output) {
    output = stripHarnessMessages(output);
  }

  if (imageIndicators) {
    output = output ? `${output}\n${imageIndicators}` : imageIndicators;
  }

  return output;
}

export type ToolRenderResultLike<TDetails> = {
  content: (TextContent | ImageContent)[];
  details: TDetails;
};

export function invalidArgText(theme: Theme): string {
  return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
  rawPath: string | null,
  theme: Theme,
  cwd: string,
  options?: { emptyFallback?: string },
): string {
  if (rawPath === null) return invalidArgText(theme);
  const value = rawPath || options?.emptyFallback;
  if (!value) return theme.fg("toolOutput", "...");
  return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
