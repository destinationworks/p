import type { ProjectInstructionWorkPhase } from "../project-instructions/work-phases.ts";
import { inferProjectInstructionPhases } from "../project-instructions/work-phases.ts";
import { REQUIREMENT_AUDIT_TOOL_NAME, TASK_VERIFICATION_TOOL_NAME } from "../task-verification/constants.ts";
import { tokenizeShellCommands } from "../task-verification/git-command-classification.ts";
import {
  isDirectMutationTool,
  isRecognizedBashMutation,
  isShellTool,
  isStaticTool,
  shellCommand,
} from "../task-verification/tool-classification.ts";

const PHASE_NEUTRAL_TOOLS = new Set([
  "ask_user",
  "confirm_user",
  "keep_context",
  "list_skills",
  "mark_session_progress",
  "read_rules",
  "read_skills",
  "session_recall",
  "sleep",
  "tool_search",
  "update_session_state",
]);
const TASK_VERIFICATION_CONTROL_PLANE_ACTIONS = new Set([
  "declare_task",
  "authorize_baseline_test",
  "record_baseline",
  "record_completion_checklist",
  "record_final",
  "ready_to_finish",
  "status",
]);
const DISCOVERY_COMMANDS = new Set(["cat", "find", "grep", "head", "ls", "rg", "sed", "tail", "wc"]);
const TEST_COMMAND_PATTERN = /^(?:jest|pytest|rspec|test(?::[^\s]+)?|vitest)$/u;
const VERIFICATION_COMMAND_PATTERN = /^(?:benchmark|build|check(?::[^\s]+)?|lint|smoke|tsc|typecheck)$/u;
const DELIVERY_COMMAND_PATTERN = /^(?:deploy|publish|release|version-bump)$/u;
const DELIVERY_GIT_SUBCOMMANDS = new Set(["commit", "merge", "push", "rebase", "tag"]);
const DISCOVERY_GIT_SUBCOMMANDS = new Set(["diff", "log", "show", "status"]);

export function isProjectInstructionVerificationControlPlaneAction(toolName: string, args: unknown): boolean {
  if (toolName === REQUIREMENT_AUDIT_TOOL_NAME) return true;
  if (toolName !== TASK_VERIFICATION_TOOL_NAME || args === null || typeof args !== "object" || Array.isArray(args)) {
    return false;
  }
  const action = (args as { action?: unknown }).action;
  return typeof action === "string" && TASK_VERIFICATION_CONTROL_PLANE_ACTIONS.has(action);
}

export function inferProjectInstructionActionPhases(
  toolName: string,
  args: unknown,
  toolDescription?: string,
): ProjectInstructionWorkPhase[] {
  if (PHASE_NEUTRAL_TOOLS.has(toolName)) return [];
  const phases = new Set<ProjectInstructionWorkPhase>();
  if (toolName === "finish_work") phases.add("closure");
  if (isDirectMutationTool(toolName)) phases.add("implementation");
  if (isStaticTool(toolName)) phases.add("discovery");
  if (toolName === "process") phases.add("verification");
  if (isShellTool(toolName)) addShellPhases(phases, args);
  for (const phase of inferProjectInstructionPhases(toolDescription ?? "")) phases.add(phase);
  return [...phases];
}

function addShellPhases(phases: Set<ProjectInstructionWorkPhase>, args: unknown): void {
  const commands = tokenizeShellCommands(shellCommand(args));
  for (const words of commands) {
    // ⚡ Bolt: Replace map, some, indexOf, and slice with a single iteration
    let hasDiscovery = false;
    let hasTesting = false;
    let hasVerification = false;
    let hasDelivery = false;
    let gitIndex = -1;
    let gitSubcommand: string | undefined;

    for (let i = 0; i < words.length; i++) {
      const word = words[i]!.toLocaleLowerCase("en-US");
      const lastSlash = word.lastIndexOf("/");
      const name = lastSlash !== -1 ? word.substring(lastSlash + 1) : word;

      if (!hasDiscovery && DISCOVERY_COMMANDS.has(name)) hasDiscovery = true;
      if (!hasTesting && TEST_COMMAND_PATTERN.test(name)) hasTesting = true;
      if (!hasVerification && VERIFICATION_COMMAND_PATTERN.test(name)) hasVerification = true;
      if (!hasDelivery && DELIVERY_COMMAND_PATTERN.test(name)) hasDelivery = true;

      if (gitIndex === -1 && name === "git") {
        gitIndex = i;
      } else if (gitIndex !== -1 && !gitSubcommand && !name.startsWith("-")) {
        gitSubcommand = name;
      }
    }

    if (hasDiscovery) phases.add("discovery");
    if (hasTesting) phases.add("testing");
    if (hasVerification) phases.add("verification");
    if (hasDelivery) phases.add("delivery");

    if (gitSubcommand && DELIVERY_GIT_SUBCOMMANDS.has(gitSubcommand)) phases.add("delivery");
    if (gitSubcommand && DISCOVERY_GIT_SUBCOMMANDS.has(gitSubcommand)) phases.add("discovery");
  }
  if (isRecognizedBashMutation(args)) phases.add("implementation");
}
