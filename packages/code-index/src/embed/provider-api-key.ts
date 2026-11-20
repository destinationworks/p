import fs from "node:fs";

/**
 * Reads a provider's bearer token from p's models.json (`providers.<name>.apiKey`).
 *
 * The token is read on every call so a credential rotation of that provider entry
 * applies to the next request without a daemon restart. The value is never logged.
 */
export function readProviderApiKey(modelsConfigPath: string, providerName: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(modelsConfigPath, "utf-8"));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "is not valid JSON" : "is not readable";
    throw new Error(`${modelsConfigPath} ${reason}`);
  }
  const providers = isRecord(parsed) ? parsed.providers : undefined;
  const provider = isRecord(providers) ? providers[providerName] : undefined;
  const apiKey = isRecord(provider) ? provider.apiKey : undefined;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error(`${modelsConfigPath} has no apiKey for provider ${providerName}`);
  }
  return apiKey.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
