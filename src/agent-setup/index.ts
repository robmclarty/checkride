/**
 * Agent-setup module — the Claude Code hooks (the Stop-hook gate and kin).
 * This barrel is the module's only public surface: siblings import from
 * `../agent-setup`, never from `./hook.js` directly.
 */

export {
  applyHooks,
  CLAUDE_SETTINGS_FILE,
  GATE_SCRIPT_FILE,
  gateScript,
  HOOK_NAMES,
  type HookName,
  PROTECT_SCRIPT_FILE,
  protectScript,
  writeHooks,
} from './hook.js';
