/**
 * Agent-setup module — the hooks every supported harness gets (the stop gate and
 * kin). This barrel is the module's only public surface: siblings import from
 * `../agent-setup`, never from `./hook.js` or a per-harness writer directly.
 */

export {
  applyHooks,
  CLAUDE_SETTINGS_FILE,
  GATE_SCRIPT_FILE,
  PROTECT_SCRIPT_FILE,
  removeHooks,
} from './claude.js';

export { type HooksOptions, runHooks } from './command.js';

export { applyCursorHooks, CURSOR_HOOKS_FILE, removeCursorHooks } from './cursor.js';

export type { HookFile } from './files.js';

export { detectHarnesses, HOOK_NAMES, type HookName, writeHooks } from './hook.js';

export { dirtyScript, gateScript, protectScript } from './scripts.js';

export { CURSOR_SKILLS_DIR, renameSkill, writeCursorSkills } from './skills.js';
