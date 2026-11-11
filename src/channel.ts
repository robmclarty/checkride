/**
 * How this checkride runs: from the npm package, or as the standalone binary
 * (R14.1), a Node single executable application with the CLI and the
 * package's own files embedded.
 *
 * {@link runtime} is the one value that says so. It is worked out once, from
 * `node:sea`, and holds each thing a caller does differently in the binary
 * as a field: where bundled files are read from, the argv that runs the
 * `checkride` on `PATH`, how the repo's Node is found, the pin a hint
 * recommends. Callers read the field they need and never ask which channel
 * they are on, so a new difference is a new field here and not a branch
 * somewhere else.
 *
 * `node:sea` is looked up when asked and never imported: a runtime that has
 * no such module, as Bun has none, would fail a static import while loading
 * the npm package, and a runtime without it is by definition not the binary.
 */

import { isRecord } from './json.js';

/** How checkride was installed: from npm, or as the standalone binary. */
export type Channel = 'npm' | 'binary';

/**
 * The `[tools]` key that pins each channel's checkride in a `mise.toml` (D46).
 * The binary's names the GitHub repository whose releases carry it, the one
 * `package.json`'s `repository` names.
 */
export const MISE_IDS: Readonly<Record<Channel, string>> = { npm: 'npm:checkride', binary: 'github:robmclarty/checkride' };

/**
 * The platforms a release carries a standalone binary for, as its tarballs
 * name them: `<os>-<arch>`. `.github/workflows/release.yaml` builds one per
 * entry of its matrix, and a test holds this list equal to that matrix. The
 * Linux builds are glibc ones.
 */
export const BINARY_TARGETS: readonly string[] = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

/** The machine a command runs on, as far as which binary it could run goes. */
export type Host = {
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** Whether the C library is glibc: `false` on a musl Linux such as Alpine, and wherever the platform isn't Linux. */
  glibc: boolean;
};

/**
 * Whether this process runs on glibc. Node's diagnostic report names the
 * glibc it runs on in its header, and a musl build's names none, which is how
 * the two are told apart without spawning anything.
 */
function onGlibc(): boolean {
  const report: unknown = process.report.getReport();
  const header = isRecord(report) ? report['header'] : undefined;
  return isRecord(header) && typeof header['glibcVersionRuntime'] === 'string';
}

/** The machine this process runs on. */
export function currentHost(): Host {
  const { platform, arch } = process;
  return { platform, arch, glibc: platform === 'linux' && onGlibc() };
}

/** `host` as a release target would name it, with the C library where that is what rules it out. */
export function hostName(host: Host): string {
  return `${host.platform}-${host.arch}${host.platform === 'linux' && !host.glibc ? ' (musl)' : ''}`;
}

/** Whether a release carries a binary `host` can run. */
export function hasBinary(host: Host): boolean {
  return BINARY_TARGETS.includes(`${host.platform}-${host.arch}`) && (host.platform !== 'linux' || host.glibc);
}

/** What this checkride does its own way, by how it runs. */
export type Runtime = {
  channel: Channel;
  /** The Node the binary embeds and runs on, `null` for the npm package, whose Node is the repo's. */
  embeddedNode: string | null;
  /** Whether every start of this process is the CLI's: the binary is one bundle with the CLI as its main. */
  main: boolean;
  /** Reads a file embedded in this checkride, by its path from the package root; `null` where the package directory holds them. */
  asset: ((key: string) => string) | null;
  /** Whether an `extends` entry may name an npm package. */
  packagePresets: boolean;
  /** The argv that runs the `checkride` on `PATH`: that name, or the binary itself, which is that checkride whatever `PATH` holds. */
  onPath: readonly [string];
  /** Whether this checkride is the one a `mise` or `PATH` entry command runs, so its `doctor` is asked through that entry. */
  runsEntry: boolean;
  /** The Node that runs a script of the repo's: the one running this process, or the `node` on `PATH`. */
  node: string;
  /**
   * The repo's Node, as a child started now would find it, without the
   * leading `v`: the one running this process, or for the binary whatever
   * `onPath` answers for the `node` on `PATH`, `null` when there is none.
   * The Node a binary embeds runs checkride and nothing of the repo's, so it
   * never stands for the repo's Node. `onPath` isn't called from npm.
   */
  repoNode: (onPath: () => string | null) => string | null;
  /** The command that pins this channel's checkride in a repo's `mise.toml`, as a hint names it. */
  pin: string;
  /** Where a built-in's own libraries are loaded from: the repo's install, or the copies bundled in the binary. */
  libraries: 'repo' | 'bundled';
};

/** What this module asks of `node:sea`. */
type Sea = { isSea: () => boolean; getAsset: (key: string, encoding: string) => string };

/** `node:sea`, or `undefined` on a runtime that has none. */
function sea(): Sea | undefined {
  try {
    return process.getBuiltinModule('node:sea');
  } catch {
    return undefined;
  }
}

/** The npm package's runtime. */
export function npmRuntime(): Runtime {
  const own = process.versions.node;
  return {
    channel: 'npm',
    embeddedNode: null,
    main: false,
    asset: null,
    packagePresets: true,
    onPath: ['checkride'],
    runsEntry: false,
    node: process.execPath,
    repoNode: () => own,
    // `allow_low_downloads`: mise's npm backend refuses a package under 1000 weekly downloads without it (D46, D80).
    // The quotes keep a shell from reading the brackets as a glob, which zsh refuses to run.
    pin: `mise use '${MISE_IDS.npm}[allow_low_downloads=true]@<version>'`,
    libraries: 'repo',
  };
}

/** The standalone binary's runtime, reading its embedded files through `asset`. */
export function binaryRuntime(asset: (key: string) => string): Runtime {
  return {
    channel: 'binary',
    embeddedNode: process.versions.node,
    main: true,
    asset,
    packagePresets: false,
    onPath: [process.execPath],
    runsEntry: true,
    node: 'node',
    repoNode: (onPath) => onPath(),
    // The `github:` pin installs a release's binary and needs no Node, where the npm pin would install the package.
    pin: `mise use ${MISE_IDS.binary}@<version>`,
    libraries: 'bundled',
  };
}

let current: Runtime | undefined;

/** How this checkride runs, worked out once. */
export function runtime(): Runtime {
  if (current === undefined) {
    const module = sea();
    current = module?.isSea() === true ? binaryRuntime((key) => module.getAsset(key, 'utf8')) : npmRuntime();
  }
  return current;
}

/** Stand `value` in for {@link runtime}, for a test; `undefined` has it worked out afresh on the next ask. */
export function useRuntime(value: Runtime | undefined): void {
  current = value;
}
