export function extractSelectors(spec: string): string[] {
  const out: string[] = [];

  const stringPatterns: RegExp[] = [
    /getByRole\([^)]*?\bname:\s*["'`]([^"'`]+)["'`]/g,
    /getByText\(\s*["'`]([^"'`]+)["'`]/g,
    /getByLabel\(\s*["'`]([^"'`]+)["'`]/g,
    /getByPlaceholder\(\s*["'`]([^"'`]+)["'`]/g,
    /getByTitle\(\s*["'`]([^"'`]+)["'`]/g,
    /getByAltText\(\s*["'`]([^"'`]+)["'`]/g,
    /\[data-testid=["']([^"']+)["']\]/g,
    /\[aria-label=["']([^"']+)["']\]/g,
    /:has-text\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    // Attribute substring/exact selectors that ground on real values, e.g.
    //   page.locator('a[href$="/issues/SUB-1"]') → "/issues/SUB-1"
    //   page.locator('a[href*="TRE-3"]')         → "TRE-3"
    //   page.locator('[role="dialog"]')          → "dialog"
    /\[(?:href|title|alt|name|value|placeholder|aria-[a-z]+|role|class)[*^$~|]?=["']([^"']+)["']\]/gi,
    // toContainText / toHaveText literal arguments — content the assertion expects.
    /\.toContainText\(\s*["'`]([^"'`]+)["'`]/g,
    /\.toHaveText\(\s*["'`]([^"'`]+)["'`]/g,
  ];

  for (const re of stringPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(spec)) !== null) {
      const value = m[1].trim();
      if (value.length > 0) out.push(value);
    }
  }

  const regexPatterns: RegExp[] = [
    /getByRole\([^)]*?\bname:\s*\/([^/]+)\/[gimsuy]*/g,
    /getByText\(\s*\/([^/]+)\/[gimsuy]*/g,
    /getByLabel\(\s*\/([^/]+)\/[gimsuy]*/g,
  ];

  for (const re of regexPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(spec)) !== null) {
      const literal = longestLiteralRun(m[1]);
      if (literal.length >= 3) out.push(literal);
    }
  }

  return Array.from(new Set(out));
}

export function findUngroundedSelectors(selectors: string[], sourceContext: string): string[] {
  const haystack = sourceContext.toLowerCase();
  const ungrounded: string[] = [];
  for (const sel of selectors) {
    const needle = normalizeForGrounding(sel);
    if (needle.length < 3) continue;
    if (!haystack.includes(needle)) ungrounded.push(sel);
  }
  return ungrounded;
}

function normalizeForGrounding(s: string): string {
  return s.toLowerCase().trim().replace(/^[.,!?:;…\s]+|[.,!?:;…\s]+$/g, "");
}

/**
 * Pull the longest run of plain literal characters from a regex source.
 * Strips backslashed metas, character classes, quantifiers, anchors, alternation.
 * Conservative: returns "" if nothing useful remains so the caller can skip the probe.
 */
function longestLiteralRun(source: string): string {
  const split = source.split(
    /\\.|\.|\?|\*|\+|\{[^}]*\}|\[[^\]]*\]|\([^)]*\)|\||\^|\$|\\d|\\w|\\s|\\b/g,
  );
  let best = "";
  for (const piece of split) {
    if (piece.length > best.length) best = piece;
  }
  return best;
}
