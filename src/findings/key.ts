/**
 * The baseline key form every diagnostic parser shares, `<file>:<rule>:<message>`
 * (fallow keeps its own forms).
 *
 * A key names a finding by what it is rather than where it sits, so a finding
 * keeps its key when unrelated edits shift its line and column. That is what
 * lets the baseline subtract already-known findings without re-flagging them
 * every time surrounding code moves.
 */

/**
 * Build a finding's key from its identity. Line and column are intentionally
 * excluded so the key survives edits that only move the code; the message is
 * whitespace-collapsed so cosmetic wrapping differences don't split one finding
 * into two. `rule` is empty for tools (cspell) that don't name a rule.
 */
export function findingKey(file: string, rule: string, message: string): string {
  return `${file}:${rule}:${message.replace(/\s+/g, ' ').trim()}`;
}
