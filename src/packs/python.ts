/**
 * The python pack: Python projects, checked from the directory that holds a
 * `pyproject.toml`, `setup.cfg` or `setup.py`.
 *
 * A tool the nearest `uv.lock` lists runs from the project's environment, the
 * `.venv` beside the lock or the one `UV_PROJECT_ENVIRONMENT` names, so a
 * check runs the copy the lock pins, and fails naming `uv sync` where that
 * environment lacks it (R6.1). Otherwise a tool resolves through a
 * `mise.toml` pin, then `PATH`. Every check of the pack, a target's custom
 * checks included, runs with Python's downloads switched off (R6.4):
 * `PIP_NO_INDEX` keeps pip off every index and `UV_OFFLINE` keeps uv off the
 * network, so a repo runs `uv sync` first, and `PYTHONDONTWRITEBYTECODE`
 * keeps the interpreter from writing `__pycache__` into the checkout.
 *
 * A tool configured in `pyproject.toml` is detected by its `[tool.<name>]`
 * table, a sub-table such as `[tool.ruff.lint]` included, as well as by its
 * own config file. Each row was run against ruff 0.17.1, mypy 2.4.0,
 * basedpyright 1.40.2 and pytest 9.1.1.
 */

import type { Pack } from './types.js';

/** ruff's config files, and the `pyproject.toml` table that configures it there. */
const RUFF_CONFIG = ['ruff.toml', '.ruff.toml'];
const RUFF_TABLE = [{ file: 'pyproject.toml', table: 'tool.ruff' }];

export const PYTHON_PACK: Pack = {
  name: 'python',
  markers: ['pyproject.toml', 'setup.cfg', 'setup.py'],
  pins: ['uv-lock', 'mise', 'path'],
  env: { PYTHONDONTWRITEBYTECODE: '1', PIP_NO_INDEX: '1', UV_OFFLINE: '1' },
  adapters: [
    {
      name: 'ruff',
      slot: 'lint',
      description: 'ruff: Python lint',
      detect: RUFF_CONFIG,
      detectTable: RUFF_TABLE,
      detectPin: 'ruff',
      command: 'pnpm',
      // `--no-cache`: ruff fails outright where it can't create `.ruff_cache`,
      // as in a checkout a static-only pass may not write to.
      args: ['exec', 'ruff', 'check', '--no-cache', '--output-format=json', '.'],
      outputFile: 'lint.json',
      fixArgs: ['exec', 'ruff', 'check', '--fix', '.'],
      static: true,
      devDeps: {},
    },
    {
      name: 'ruff-format',
      slot: 'format',
      description: 'ruff format: Python formatting',
      detect: RUFF_CONFIG,
      detectTable: RUFF_TABLE,
      detectPin: 'ruff',
      command: 'pnpm',
      // `--check` lists each file that would change and exits 1 when any would.
      args: ['exec', 'ruff', 'format', '--no-cache', '--check', '.'],
      outputFile: null,
      fixArgs: ['exec', 'ruff', 'format', '.'],
      static: true,
      devDeps: {},
    },
    {
      name: 'mypy',
      slot: 'types',
      description: 'mypy: Python type checking',
      detect: ['mypy.ini', '.mypy.ini'],
      detectTable: [{ file: 'pyproject.toml', table: 'tool.mypy' }],
      detectPin: 'mypy',
      command: 'pnpm',
      // One JSON object per line for each error (mypy 1.11 or later), and a
      // blank line when there are none. It reads the installed packages'
      // types, so it needs the synced environment.
      args: ['exec', 'mypy', '--output', 'json', '.'],
      outputFile: 'types.jsonl',
      devDeps: {},
    },
    {
      name: 'basedpyright',
      slot: 'types',
      description: 'basedpyright: Python type checking',
      detect: ['pyrightconfig.json'],
      detectTable: [
        { file: 'pyproject.toml', table: 'tool.basedpyright' },
        { file: 'pyproject.toml', table: 'tool.pyright' },
      ],
      detectPin: 'basedpyright',
      command: 'pnpm',
      // basedpyright's wheel bundles the Node it runs on. The PyPI `pyright`
      // wrapper is never run: it downloads Node the first time.
      args: ['exec', 'basedpyright', '--outputjson'],
      outputFile: 'types.json',
      devDeps: {},
    },
    {
      name: 'pytest',
      slot: 'test',
      description: 'pytest: Python tests',
      // pytest 9 also reads `pytest.toml` and a `[tool.pytest]` table, whose
      // match covers `[tool.pytest.ini_options]`.
      detect: ['pytest.toml', '.pytest.toml', 'pytest.ini', '.pytest.ini', 'conftest.py'],
      detectTable: [{ file: 'pyproject.toml', table: 'tool.pytest' }],
      detectPin: 'pytest',
      command: 'pnpm',
      // A run that collects no tests exits 5, which fails the check as any
      // nonzero exit does: a test slot with nothing to run is a vacuous green.
      args: ['exec', 'pytest', '-q'],
      outputFile: null,
      devDeps: {},
    },
  ],
};
