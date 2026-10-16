/**
 * The token grammar (R5.2): how `--only`, `--skip`, `--include`, `gate.only`
 * and `gate.skip` name the checks they select.
 *
 * ```text
 * token := <slot> | <custom> | <target> | <target> ':' ( <slot> | <custom> )
 * ```
 *
 * A bare slot or custom-check name selects that check in every target that has
 * it, and the one repo-scope or top-level check of that name. A target name
 * selects every check of that target, and `<target>:<slot>` selects one check.
 * In implicit mode no check has a target, so a token is a slot or custom-check
 * name, as it always was. V2 keeps a target from sharing a name with a slot or
 * a top-level custom check, so each token means one thing.
 *
 * Only what the checks themselves carry is matched: a token is valid when it
 * selects at least one resolved check, and the vocabulary an error lists is
 * built from the same checks.
 */

/** What a token is matched against: a check's slot, and its target in multi-target mode. */
export type Selectable = {
  readonly slot: string;
  readonly target?: string | undefined;
};

/** The name a check runs and reports under: `<target>:<slot>` in a target, the bare slot otherwise. */
export function checkName(check: Selectable): string {
  return check.target === undefined ? check.slot : `${check.target}:${check.slot}`;
}

/** True when `token` selects `check`, through its slot, its target or its full name. */
function selects(token: string, check: Selectable): boolean {
  return token === check.slot || token === check.target || token === checkName(check);
}

/** True when some token in `tokens` selects `check`. */
export function selectedBy(tokens: readonly string[], check: Selectable): boolean {
  return tokens.some((token) => selects(token, check));
}

/**
 * True when some token in `tokens` names `check` itself, by its slot or its
 * full name, rather than its whole target. Naming a check opts it in, the way
 * naming a slot in `checks` does; a target token leaves the target's opt-in
 * slots out, so `--only web` runs what a full run would run for `web`.
 */
export function namedBy(tokens: readonly string[], check: Selectable): boolean {
  return tokens.some((token) => token === check.slot || token === checkName(check));
}

/**
 * Every token that selects at least one of `checks`, each once: the bare slot
 * and custom-check names in check order, then the target names, then each
 * `<target>:<slot>`. In implicit mode that's the slot and custom-check names
 * alone, in the order they resolve.
 */
export function validTokens(checks: readonly Selectable[]): string[] {
  const targets = checks.flatMap((c) => (c.target === undefined ? [] : [c.target]));
  const qualified = checks.filter((c) => c.target !== undefined).map(checkName);
  return [...new Set([...checks.map((c) => c.slot), ...targets, ...qualified])];
}

/**
 * Why `tokens`, given as `label` (`--only`, `gate.skip`), can't select from
 * `checks`, or `null` when every token selects something. An absent list is
 * fine; an empty one is a problem, because a filter that names nothing selects
 * nothing, which a gate would read as a pass. An unknown token is a problem for
 * the same reason: a typo like `--only lints` must never quietly disable the
 * gate. Both messages list the valid tokens.
 */
export function tokenProblem(
  checks: readonly Selectable[],
  label: string,
  tokens: readonly string[] | null | undefined,
): string | null {
  if (tokens === undefined || tokens === null) return null;
  const valid = validTokens(checks);
  if (tokens.length === 0) {
    return `${label} was given an empty list, which selects nothing. Valid tokens: ${valid.join(', ')}.`;
  }
  const unknown = tokens.filter((token) => !valid.includes(token));
  if (unknown.length === 0) return null;
  const named = unknown.map((token) => `'${token}'`).join(', ');
  const noun = unknown.length > 1 ? 'tokens' : 'token';
  return `unknown ${noun} ${named} in ${label}. Valid tokens: ${valid.join(', ')}.`;
}
