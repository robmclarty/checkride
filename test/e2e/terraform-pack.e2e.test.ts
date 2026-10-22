/**
 * The terraform pack, run end to end against the real tools (R5.8).
 *
 * A root module, `infra`, calls a local child module and declares OpenTofu
 * through `.opentofu-version`; its lock file marks it a root module, and it
 * needs no provider download, so setup's `tofu init -backend=false` runs
 * offline. A second target, `shared`, holds a module with no lock file.
 * Clean, every check is green: validate runs `tofu` at the release the file
 * names, tflint is detected by `.tflint.hcl`, and fmt and trivy are opted in.
 * An unformatted file fails `format`, an unused variable fails `lint`, an
 * undeclared reference fails `types`, and an open security group fails
 * `security`. Without `.terraform/`, `types` fails naming `tofu init
 * -backend=false` and nothing spawns (F42); `shared:types` stands down, since
 * no lock file marks a root module there; a `.tf` directory outside both
 * targets fails `unclaimed` (F43); and `--discover` proposes both targets.
 * `--static-only` keeps `infra:lint` under its terraform-only `.tflint.hcl`,
 * and skips it once `.tflint.d/` ships a binary tflint would run as its
 * terraform ruleset, which then never runs.
 */

import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { describeWithToolchain } from '../helpers/toolchains.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

/** The OpenTofu release `.opentofu-version` pins, as the dev `mise.toml` does. */
const TOFU = '1.13.1';

const ROOT_MAIN = [
  'terraform {',
  '  required_version = ">= 1.6"',
  '}',
  '',
  'module "greet" {',
  '  source = "./modules/greet"',
  '  name   = "world"',
  '}',
  '',
  'resource "terraform_data" "greeting" {',
  '  input = module.greet.message',
  '}',
  '',
  'output "greeting" {',
  '  description = "The greeting the module built."',
  '  value       = terraform_data.greeting.output',
  '}',
  '',
].join('\n');

const GREET = [
  'terraform {',
  '  required_version = ">= 1.6"',
  '}',
  '',
  'variable "name" {',
  '  description = "Who to greet."',
  '  type        = string',
  '}',
  '',
  'output "message" {',
  '  description = "The greeting."',
  '  value       = "hello, ${var.name}"',
  '}',
  '',
].join('\n');

const FILES: Record<string, string> = {
  'infra/.opentofu-version': `${TOFU}\n`,
  'infra/.terraform.lock.hcl': '# This file is maintained automatically by "tofu init".\n# Manual edits may be lost in future updates.\n',
  'infra/.tflint.hcl': 'plugin "terraform" {\n  enabled = true\n  preset  = "recommended"\n}\n',
  'infra/main.tf': ROOT_MAIN,
  'infra/modules/greet/main.tf': GREET,
  'shared/main.tf': GREET,
  'checkride.config.json': JSON.stringify({
    targets: {
      infra: { lang: 'terraform', root: 'infra', checks: { security: 'trivy-config' } },
      shared: { lang: 'terraform', root: 'shared' },
    },
  }),
};

type Check = Record<string, unknown>;

describeWithToolchain('terraform')('the terraform pack', () => {
  let template: string;
  let dir: string;

  beforeAll(async () => {
    template = await mkdtemp(join(tmpdir(), 'checkride-terraform-pack-template-'));
    for (const [rel, content] of Object.entries(FILES)) {
      await mkdir(dirname(join(template, rel)), { recursive: true });
      await writeFile(join(template, rel), content);
    }
    // The builtin provider and a local module: init installs both offline.
    const init = spawnSync('tofu', ['init', '-backend=false', '-input=false'], { cwd: join(template, 'infra'), encoding: 'utf8', timeout: 60_000 });
    if (init.status !== 0) throw new Error(`tofu init failed:\n${init.stderr}`);
  });
  afterAll(async () => { await rm(template, { recursive: true, force: true }); });

  beforeEach(async (context) => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-terraform-pack-'));
    await cp(template, dir, { recursive: true });
    context.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  });

  const put = async (rel: string, content: string): Promise<void> => {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  };
  const artifact = (rel: string): Promise<string> => readFile(join(dir, '.check', rel), 'utf8');

  async function run(...args: string[]): Promise<{ code: number; stderr: string; checks: Map<string, Check> }> {
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('node', [CLI, ...args], { cwd: dir, maxBuffer: 32 * 1024 * 1024 }, (error, _stdout, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr: err });
      });
    });
    const summary = JSON.parse(await artifact('summary.json')) as { checks: Check[] };
    return { code, stderr, checks: new Map(summary.checks.map((c) => [String(c['name']), c])) };
  }

  test('a clean root module is green, validate running tofu at the release .opentofu-version names', async () => {
    const { code, checks, stderr } = await run('--only', 'infra', '--include', 'infra:format,infra:security');
    expect(code, stderr).toBe(0);
    expect(checks.get('infra:types')).toMatchObject({
      ok: true,
      adapter: 'terraform-validate',
      detected_by: '.terraform.lock.hcl',
      pin_source: 'tf-version',
      tool_version: TOFU,
      argv: ['tofu', 'validate', '-json'],
      output_file: 'infra/types.json',
    });
    expect(checks.get('infra:lint')).toMatchObject({ ok: true, adapter: 'tflint', detected_by: '.tflint.hcl', pin_source: 'path', output_file: 'infra/lint.json' });
    expect(checks.get('infra:format')).toMatchObject({ ok: true, adapter: 'terraform-fmt', argv: ['tofu', 'fmt', '-check', '-recursive', '-diff'] });
    expect(checks.get('infra:security')).toMatchObject({ ok: true, adapter: 'trivy-config', output_file: 'infra/security.json' });
    // trivy reads no checks bundle from its scratch cache, and writes nothing there.
    expect(await artifact('infra/security.stderr.txt')).toContain('Falling back to embedded checks');
    expect(existsSync(join(dir, '.check', 'infra', 'trivy-cache'))).toBe(false);
  });

  test('an unformatted file fails infra:format with fmt’s exit 3, its diff on stdout', async () => {
    await put('infra/modules/greet/main.tf', GREET.replace('type        = string', 'type = string'));
    const { code, checks } = await run('--only', 'infra:format');
    expect(code).toBe(1);
    expect(checks.get('infra:format')).toMatchObject({ ok: false, exit_code: 3 });
    expect(await artifact('infra/format.stdout.txt')).toContain('modules/greet/main.tf');
  });

  test('an unused variable fails infra:lint with tflint’s exit 2, its issue captured as JSON', async () => {
    await put('infra/unused.tf', 'variable "unused" {\n  description = "Nothing reads it."\n  type        = string\n}\n');
    const { code, checks } = await run('--only', 'infra:lint');
    expect(code).toBe(1);
    expect(checks.get('infra:lint')).toMatchObject({ ok: false, exit_code: 2, output_file: 'infra/lint.json' });
    const lint = JSON.parse(await artifact('infra/lint.json')) as { issues: { rule: { name: string } }[] };
    expect(lint.issues.map((i) => i.rule.name)).toEqual(['terraform_unused_declarations']);
  });

  /**
   * A root module nested in another, with its own lock file, is one infra's
   * validate never reads (#20). Discovery proposes it as a target that only
   * validates, and the config's rules let the two nest.
   */
  test('a nested root module is validated by a target of its own, which the outer one doesn’t do', async () => {
    await put('infra/registry/.terraform.lock.hcl', '# lock\n');
    // It calls the outer root's local module, so init installs one, as validate needs.
    const call = 'module "greet" {\n  source = "../modules/greet"\n  name   = "registry"\n}\n\n';
    await put('infra/registry/main.tf', `${call}output "bad" {\n  description = "A reference to nothing."\n  value       = terraform_data.missing.output\n}\n`);
    // A root module of its own, so it's initialized on its own.
    const init = spawnSync('tofu', ['init', '-backend=false', '-input=false'], { cwd: join(dir, 'infra', 'registry'), encoding: 'utf8', timeout: 60_000 });
    expect(init.status, init.stderr).toBe(0);
    const config = JSON.parse(FILES['checkride.config.json'] ?? '{}') as { targets: Record<string, unknown> };
    const registry = { lang: 'terraform', root: 'infra/registry', checks: { format: false, lint: false, security: false } };
    await put('checkride.config.json', JSON.stringify({ targets: { ...config.targets, registry } }));
    const { code, checks, stderr } = await run('--only', 'infra:types,registry');
    expect(code, stderr).toBe(1);
    expect(checks.get('infra:types')).toMatchObject({ ok: true });
    expect(checks.get('registry:types')).toMatchObject({ ok: false, exit_code: 1, output_file: 'registry/types.json' });
    expect(await artifact('registry/types.json')).toContain('Reference to undeclared resource');
    expect(checks.get('registry:lint')).toMatchObject({ skipped: true });
  });

  test('an undeclared reference fails infra:types, its diagnostic captured as JSON', async () => {
    await put('infra/bad.tf', 'output "bad" {\n  description = "A reference to nothing."\n  value       = terraform_data.missing.output\n}\n');
    const { code, checks } = await run('--only', 'infra:types');
    expect(code).toBe(1);
    expect(checks.get('infra:types')).toMatchObject({ ok: false, exit_code: 1, output_file: 'infra/types.json' });
    expect(await artifact('infra/types.json')).toContain('Reference to undeclared resource');
  });

  test('an open security group fails infra:security, trivy’s findings captured as JSON', async () => {
    await put('infra/sg.tf', [
      'resource "aws_security_group" "open" {',
      '  name        = "open"',
      '  description = "Open to the world."',
      '  ingress {',
      '    description = "ssh"',
      '    from_port   = 22',
      '    to_port     = 22',
      '    protocol    = "tcp"',
      '    cidr_blocks = ["0.0.0.0/0"]',
      '  }',
      '}',
      '',
    ].join('\n'));
    const { code, checks } = await run('--only', 'infra:security');
    expect(code).toBe(1);
    expect(checks.get('infra:security')).toMatchObject({ ok: false, exit_code: 1, output_file: 'infra/security.json' });
    expect(await artifact('infra/security.json')).toContain('"ID": "AWS-0107"');
  });

  // F42: validate never runs before init, and never runs init itself.
  test('without .terraform/, infra:types fails naming tofu init -backend=false, and nothing spawns', async () => {
    await rm(join(dir, 'infra', '.terraform'), { recursive: true });
    const { code, checks } = await run('--only', 'infra:types');
    expect(code).toBe(1);
    expect(checks.get('infra:types')).toMatchObject({ ok: false, exit_code: 1 });
    expect(checks.get('infra:types')).not.toHaveProperty('argv');
    expect(await artifact('infra/types.stderr.txt')).toContain('`tofu init -backend=false`');
  });

  test('a module with no lock file stands its types slot down, and lints only where .tflint.hcl or a pin says to', async () => {
    const { code, checks, stderr } = await run('--only', 'shared');
    expect(code, stderr).toBe(0);
    expect(checks.get('shared:types')).toMatchObject({ skipped: true, reason: 'no .terraform.lock.hcl marks a root module here' });
    expect(checks.get('shared:lint')).toMatchObject({ skipped: true });
  });

  // F43: a .tf directory no terraform target claims is code no check reads.
  test('a .tf directory outside every terraform target fails unclaimed, which suggests one', async () => {
    await put('extra/main.tf', 'locals {}\n');
    const { code, checks } = await run('--only', 'unclaimed');
    expect(code).toBe(1);
    expect(checks.get('unclaimed')).toMatchObject({ ok: false, exit_code: 1 });
    const report = JSON.parse(await artifact('unclaimed.json')) as { unclaimed: unknown[] };
    expect(report.unclaimed).toEqual([{ path: 'extra/main.tf', kind: 'terraform', suggest: { name: 'extra', lang: 'terraform', root: 'extra' } }]);
  });

  test('--static-only keeps infra:lint under a terraform-only .tflint.hcl with no .tflint.d/', async () => {
    const { code, checks, stderr } = await run('--static-only', '--only', 'infra:lint');
    expect(code, stderr).toBe(0);
    expect(checks.get('infra:lint')).toMatchObject({ ok: true, adapter: 'tflint', output_file: 'infra/lint.json' });
    expect(checks.get('infra:lint')).not.toHaveProperty('skipped');
  });

  // tflint 0.64.0 runs .tflint.d/plugins/tflint-ruleset-terraform in place of its bundled ruleset.
  test('--static-only skips infra:lint where .tflint.d/ ships the terraform ruleset’s binary, which never runs', async () => {
    const plant = 'infra/.tflint.d/plugins/tflint-ruleset-terraform';
    const marker = join(dir, 'plant-ran');
    await put(plant, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(join(dir, plant), 0o755);
    const statically = await run('--static-only', '--only', 'infra:lint');
    expect(statically.code, statically.stderr).toBe(0);
    expect(statically.checks.get('infra:lint')).toMatchObject({ skipped: true, reason: `static-only: ${plant} is code tflint would run` });
    expect(existsSync(marker)).toBe(false);
    // Without the flag tflint runs the plant, which fails its plugin handshake.
    const fully = await run('--only', 'infra:lint');
    expect(fully.checks.get('infra:lint')).toMatchObject({ ok: false, exit_code: 1 });
    expect(existsSync(marker)).toBe(true);
  });

  test('--discover proposes the root module its lock file marks and the module beside it', async () => {
    await rm(join(dir, 'checkride.config.json'));
    const { code, checks, stderr } = await run('--discover', '--only', 'infra:types,shared:types');
    expect(code, stderr).toBe(0);
    expect(checks.get('infra:types')).toMatchObject({ ok: true, adapter: 'terraform-validate' });
    expect(checks.get('shared:types')).toMatchObject({ skipped: true });
  });
});
