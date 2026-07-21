/**
 * Agent-setup module — the Claude Code Stop hook. This barrel is the
 * module's only public surface: siblings import from `../agent-setup`,
 * never from `./hook.js` directly.
 */

export { applyStopHook, CLAUDE_SETTINGS_FILE, stopHookCommand, writeStopHook } from './hook.js';
