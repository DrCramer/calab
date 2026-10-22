/**
 * Pictures inside a task's description (CBF-59). A picture is an ordinary attachment of the task
 * (one file mechanism); the text refers to it with a line `![name](calaba-file:<id>)` placed where
 * the author pasted it. Outside the description the line is plain text, so older clients and the
 * bot API just show it.
 */
export type DescSeg = { k: 'text'; v: string } | { k: 'img'; id: string; name: string };

const LINE = /^!\[([^\]\n]*)\]\(calaba-file:([A-Za-z0-9-]{1,64})\)$/;

/** The reference line for an attached file; brackets and newlines are dropped from the name. */
export function imageToken(id: string, name: string): string {
  return `![${name.replace(/[[\]\n\r]/g, ' ').trim()}](calaba-file:${id})`;
}

/** Splits a description into text runs and picture lines (a picture is a line of its own). */
export function splitDescription(text: string): DescSeg[] {
  const out: DescSeg[] = [];
  let run: string[] = [];
  const flush = (): void => {
    const v = run.join('\n');
    if (v) out.push({ k: 'text', v });
    run = [];
  };
  for (const line of text.split('\n')) {
    const m = LINE.exec(line.trim());
    if (m) {
      flush();
      out.push({ k: 'img', id: m[2] ?? '', name: m[1] ?? '' });
    } else run.push(line);
  }
  flush();
  return out;
}

/** Inserts the token at `pos` on lines of its own; returns the new text and the caret after it. */
export function insertImage(text: string, pos: number, token: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(pos, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const head = before && !before.endsWith('\n') ? '\n' : '';
  const tail = after && !after.startsWith('\n') ? '\n' : '';
  return { text: `${before}${head}${token}${tail}${after}`, caret: before.length + head.length + token.length + tail.length };
}
