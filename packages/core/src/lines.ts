export interface TextChange {
  text: string;
  range: { start: { line: number }; end: { line: number } };
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
