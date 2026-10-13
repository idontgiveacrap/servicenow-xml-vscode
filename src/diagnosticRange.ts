/**
 * Exclusive end column for a diagnostic that only reported a start.
 *
 * Structure checks store the start of a tag or element value and leave the
 * end unset. Stopping one character later underlines only the first character
 * of that text. On the same line, cover the tag or the element text instead.
 */
export function inferXmlDiagnosticEnd(lineText: string, character: number): number {
  const len = lineText.length;
  const start = Math.min(Math.max(0, character), len);
  if (start >= len) {
    return len;
  }

  let scan = 0;
  while (scan < len) {
    const tag = findTag(lineText, scan);
    if (!tag) {
      break;
    }
    if (start >= tag.start && start < tag.end) {
      return tag.end;
    }
    scan = tag.end;
  }

  const next = findTag(lineText, start);
  if (next && next.start > start) {
    const text = lineText.slice(start, next.start).trimEnd();
    if (text.length > 0) {
      return start + text.length;
    }
    return next.end;
  }

  const trimmed = lineText.trimEnd().length;
  return Math.max(trimmed, Math.min(start + 1, len));
}

interface TagSpan {
  start: number;
  end: number;
}

/**
 * Next `<tag`, comment, or declaration at or after `from`.
 * `<=` and a bare `<` are comparisons, not tags.
 */
function findTag(lineText: string, from: number): TagSpan | undefined {
  for (let i = from; i < lineText.length; i++) {
    if (lineText.charCodeAt(i) !== 60) {
      continue;
    }
    const rest = lineText.slice(i);
    const opens =
      /^<\/?[A-Za-z_][\w.:-]*/.test(rest) ||
      rest.startsWith('<?') ||
      rest.startsWith('<!');
    if (!opens) {
      continue;
    }
    const gt = lineText.indexOf('>', i);
    const end = gt === -1 ? lineText.trimEnd().length : gt + 1;
    if (end <= i) {
      continue;
    }
    return { start: i, end };
  }
  return undefined;
}
