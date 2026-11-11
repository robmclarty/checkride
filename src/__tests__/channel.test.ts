/**
 * Which machines a release carries a standalone binary for, and how a host is
 * read as one of them or not.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { BINARY_TARGETS, currentHost, hasBinary, hostName } from '../channel.js';

describe('the platforms a release carries a binary for', () => {
  test('BINARY_TARGETS is release.yaml’s matrix, target for target', () => {
    const workflow = readFileSync(join(import.meta.dirname, '..', '..', '.github', 'workflows', 'release.yaml'), 'utf8');
    const built = [...workflow.matchAll(/^ {10}- target: (\S+)$/gm)].map((match) => match[1]);
    expect(built.length).toBeGreaterThan(0);
    expect([...BINARY_TARGETS].toSorted()).toEqual(built.toSorted());
  });

  test.each([
    [{ platform: 'darwin', arch: 'arm64', glibc: false }, true, 'darwin-arm64'],
    [{ platform: 'darwin', arch: 'x64', glibc: false }, true, 'darwin-x64'],
    [{ platform: 'linux', arch: 'x64', glibc: true }, true, 'linux-x64'],
    [{ platform: 'linux', arch: 'arm64', glibc: true }, true, 'linux-arm64'],
    // Alpine: the tarball's name fits, and its glibc build can't start on musl.
    [{ platform: 'linux', arch: 'x64', glibc: false }, false, 'linux-x64 (musl)'],
    [{ platform: 'linux', arch: 'arm64', glibc: false }, false, 'linux-arm64 (musl)'],
    [{ platform: 'linux', arch: 'riscv64', glibc: true }, false, 'linux-riscv64'],
    [{ platform: 'win32', arch: 'x64', glibc: false }, false, 'win32-x64'],
    [{ platform: 'freebsd', arch: 'x64', glibc: false }, false, 'freebsd-x64'],
  ])('%o: a binary %s, named %s', (host, has, named) => {
    expect(hasBinary(host)).toBe(has);
    expect(hostName(host)).toBe(named);
  });

  test('this machine is read from the process, and glibc only ever on Linux', () => {
    const host = currentHost();
    expect(host).toMatchObject({ platform: process.platform, arch: process.arch });
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    expect(host.glibc).toBe(process.platform === 'linux' && typeof report.header?.glibcVersionRuntime === 'string');
  });
});
