export interface TextChange {
  text: string;
  range: { start: { line: number; character?: number }; end: { line: number; character?: number } };
  rangeLength: number;
}

/** VS Code offsets and JavaScript lengths use UTF-16 code units, not graphemes. */
export function countCharacterChanges(changes: readonly TextChange[]) {
  return changes.reduce((total, change) => ({ charactersAdded: total.charactersAdded + change.text.length,
    charactersRemoved: total.charactersRemoved + change.rangeLength }), { charactersAdded: 0, charactersRemoved: 0 });
}

/** Editor-observed line boundaries, not Git diff lines or lines of authored code.
 * Inline edits add/remove zero boundaries. Replacements and undo/redo count the
 * operations observed, even if they later cancel out. Source text is never retained.
 */
export function countLineChanges(changes: readonly TextChange[]) {
  let linesAdded = 0;
  let linesRemoved = 0;
  let editCount = 0;
  for (const change of changes) {
    if (change.rangeLength === 0 && change.text.length === 0) continue;
    for (let i = 0; i < change.text.length; i++) {
      if (change.text[i] === "\n" || (change.text[i] === "\r" && change.text[i + 1] !== "\n")) linesAdded++;
    }
    linesRemoved += change.range.end.line - change.range.start.line;
    editCount++;
  }
  return { linesAdded, linesRemoved, editCount };
}

export interface DiffLineCounts { linesAdded: number; linesRemoved: number }
const splitLines = (text: string) => text === "" ? [] : text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");

/** Whole-line additions/removals between two in-memory snapshots (Myers edit
 * distance, like a Git diff without rename detection). Returns null instead of an
 * estimate when the edit distance or work budget is exceeded, so a hook can never
 * stall on a huge rewrite. Inputs are never retained. */
export function countDiffLines(before: string, after: string, maxDistance = 20_000, budget = 4_000_000): DiffLineCounts | null {
  const a = splitLines(before), b = splitLines(after);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (!n || !m) return { linesAdded: m, linesRemoved: n };
  const max = Math.min(n + m, maxDistance), offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!) ? frontier[offset + k + 1]! : frontier[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++; budget--; }
      if (--budget < 0) return null;
      frontier[offset + k] = x;
      if (x >= n && y >= m) {
        const common = (n + m - d) / 2;
        return { linesAdded: m - common, linesRemoved: n - common };
      }
    }
  }
  return null;
}

/** Diff lines implied by VS Code's own disk-reload edits for an open document.
 * Reloads were observed to replace whole lines; a partially covered line (the
 * final line without a newline) counts as one replaced line. */
export function countReloadDiffLines(changes: readonly TextChange[]): DiffLineCounts {
  let linesAdded = 0, linesRemoved = 0;
  for (const change of changes) {
    if (change.rangeLength === 0 && change.text.length === 0) continue;
    const { start, end } = change.range;
    const newlines = (change.text.match(/\r\n|\r|\n/g) ?? []).length;
    const aligned = (start.character ?? 0) === 0 && (end.character ?? 0) === 0 && (change.text === "" || /\n$|\r$/.test(change.text));
    if (aligned) { linesRemoved += end.line - start.line; linesAdded += newlines; }
    else { linesRemoved += change.rangeLength ? end.line - start.line + 1 : 0; linesAdded += change.text ? newlines + 1 : 0; }
  }
  return { linesAdded, linesRemoved };
}
