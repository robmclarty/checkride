/**
 * What the repo *declared* it checks — as opposed to what a given run selected.
 *
 * The summary records the slots a run selected; it says nothing about the ones
 * the repo opted into and did not run. Both readers need that difference:
 * triage uses it to name the slots a narrow run left uncovered, and the quality
 * extractor uses it to tell "opted in but not run this time" apart from "never
 * opted in at all" — three of its four artifacts come from opt-in slots, so the
 * distinction decides whether a gap is a finding or the repo's normal state.
 *
 * `null` throughout means *unknowable*, never *empty*: a repo with no
 * `checkride.config.json` runs the default catalogue, and neither reader will
 * guess at it.
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

import { resolve } from 'node:path';

import { loadConfig } from '../config.js';

/**
 * Slots the repo names in `checkride.config.json` and has not switched off
 * (`false` disables one), sorted. `null` when the repo has no config file, or
 * when the config is unparseable — that is the gate's problem to report, not
 * the reader's to crash on.
 *
 * `cwd` is resolved first because `loadConfig` throws outright on a relative
 * one, and both readers take their `cwd` from a command-line argument. Left
 * unresolved, `dist/<reader>/cli.js .` would land in the catch below and report
 * the repo's slots as *unknowable* — a silently degraded answer, which is the
 * failure mode these readers exist to prevent.
 */
export function configuredSlots(cwd: string): string[] | null {
  try {
    const checks = loadConfig(resolve(cwd))?.checks;
    if (!checks) return null;
    return Object.entries(checks)
      .filter(([, value]) => value !== false)
      .map(([slot]) => slot)
      .toSorted();
  } catch {
    return null;
  }
}
