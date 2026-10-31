import type { RunnerOptions } from "./runner-options.ts";
import { canonicalTaskTimeoutSeconds } from "./task-definition.ts";

export function certifiedPreflightTimeoutSeconds(agent: string): number {
  return agent === "p" ? 300 : 60;
}
const certifiedSetupSeconds = 300;
const certifiedOrchestrationSecondsPerCell = 30;

export function certifiedMinimumRuntimeSeconds(
  options: Pick<RunnerOptions, "agents" | "kiloStartupTimeoutSeconds" | "minimumTimeoutSeconds" | "runs">,
): number {
  const perAgentRun = Object.values(canonicalTaskTimeoutSeconds).reduce(
    (total, timeoutSeconds) => total + Math.max(timeoutSeconds, options.minimumTimeoutSeconds ?? 0),
    0,
  );
  const taskSeconds = perAgentRun * options.agents.length * options.runs;
  const cellCount = Object.keys(canonicalTaskTimeoutSeconds).length * options.agents.length * options.runs;
  const preflightSeconds = options.agents.reduce((total, agent) => total + certifiedPreflightTimeoutSeconds(agent), 0);
  const startupSeconds = options.agents.includes("kilo") ? options.kiloStartupTimeoutSeconds : 0;
  return (
    taskSeconds +
    preflightSeconds +
    startupSeconds +
    certifiedSetupSeconds +
    certifiedOrchestrationSecondsPerCell * cellCount
  );
}
