/**
 * Agent-setup module — the Claude Code Stop hook (step 12). This barrel is the
 * module's only public surface (C2): siblings import from `../agent-setup`,
 * never from `./hook.js` directly.
 */

export type { StopHookResult } from './hook.js';
export { applyStopHook, CLAUDE_SETTINGS_FILE, stopHookCommand, writeStopHook } from './hook.js';
