export type {
  AskHandler,
  EvaluateRequest,
  PermissionConfig,
  PermissionMode,
  PermissionRule,
  PermissionVerdict,
} from './types.js';
export { parseRule } from './parse.js';
export {
  globToRegExp,
  matchBashPattern,
  matchPathGlob,
  ruleMatchesBash,
  ruleMatchesMcp,
  ruleMatchesPath,
} from './match.js';
export {
  PathEscapeError,
  assertInsideWorkspace,
  isInsideWorkspace,
  isProtectedPath,
  isSensitivePath,
  relativeToWorkspace,
  resolveInWorkspace,
} from './paths.js';
export { inspectBash } from './bash-ast.js';
export { isReadOnlyBashCommand, READ_ONLY_BASH_COMMANDS } from './read-only-bash.js';
export { DEFAULT_ALLOW_RULES, KNOWN_TOOLS, READ_ONLY_TOOLS } from './defaults.js';
export { PermissionEngine, createPermissionEngine } from './engine.js';
export type { PermissionEngineOptions } from './engine.js';
export { isAutoModeAvailable } from './available.js';
export type { AutoModeAvailability } from './available.js';
export { createPermissionHooks, nonInteractiveAskHandler } from './hooks.js';
export type { AutoModeHookOptions, AutoModeNotice } from './hooks.js';
export {
  AutoModeClassifier,
  AutoModeState,
  applySubagentReview,
  resolveAutoModeRules,
  listUsesDefaults,
  defaultRulesFor,
  classifierDenyMessage,
} from './auto-mode/index.js';
export type { AutoModeDenial, ClassifyResult } from './auto-mode/index.js';
export { isSecretEnvKey, sandboxedEnv } from './sandbox.js';
export { buildSandboxProfile, isSandboxExecAvailable, wrapCommand } from './macos-sandbox.js';
export type { WrappedCommand } from './macos-sandbox.js';
