/**
 * Bold (`**x**`, `__x__`) and italic (`*x*`, `_x_`) in model-written text as real <strong> and
 * <em>. Everything else stays plain text: React escapes it, no HTML is ever interpreted.
 */
import { Fragment, type ReactNode } from 'react';

const EMPHASIS =
  /\*\*(.+?)\*\*|__(.+?)__|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_(?![\p{L}\p{N}])/gu;

/** Splits text into plain parts, <strong> and <em>. */
export function inlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    const [whole, bold1, bold2, em1, em2] = match;
    const at = match.index;
    if (at > last) nodes.push(text.slice(last, at));
    const bold = bold1 ?? bold2;
    nodes.push(
      bold !== undefined ? (
        <strong key={at}>{bold}</strong>
      ) : (
        <em key={at}>{em1 ?? em2}</em>
      )
    );
    last = at + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function InlineMarkdown({ children }: { children: string }) {
  return <Fragment>{inlineMarkdown(children)}</Fragment>;
}
