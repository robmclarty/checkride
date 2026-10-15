/**
 * Package-manager module — the package-manager vocabulary the gate, `init`,
 * `doctor` and the built-ins speak, re-exported from `../launch/`, where the
 * `js-lockfile` pin source now owns it. Nothing is defined here; the
 * detection, the exec-prefix translation, the slot-tool lookup and the launch
 * refusals all live in the launch module.
 */

export type { LaunchRefusal, PackageManager } from '../launch/index.js';
export {
  detectPackageManager,
  execCommand,
  execTool,
  execUsesGlobalCache,
  installCommand,
  isAvailableUnder,
  isPnPInstall,
  launchRefusal,
  resolveSlotTool,
  runScript,
  SPAWN_FAILED_MARKER,
  translateExec,
} from '../launch/index.js';
