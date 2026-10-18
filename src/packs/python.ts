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
 */

import type { Pack } from './types.js';

export const PYTHON_PACK: Pack = {
  name: 'python',
  markers: ['pyproject.toml', 'setup.cfg', 'setup.py'],
  pins: ['uv-lock', 'mise', 'path'],
  env: { PYTHONDONTWRITEBYTECODE: '1', PIP_NO_INDEX: '1', UV_OFFLINE: '1' },
  adapters: [],
};
