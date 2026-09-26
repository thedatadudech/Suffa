import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { InlineMarkdown } from './InlineMarkdown';

const html = (text: string) =>
  render(<InlineMarkdown>{text}</InlineMarkdown>).container.innerHTML;

describe('InlineMarkdown', () => {
  it('turns bold and italic into real emphasis', () => {
    expect(html('Das Wort **كِتَابٌ** (*kitābun*) heißt Buch.')).toBe(
      'Das Wort <strong>كِتَابٌ</strong> (<em>kitābun</em>) heißt Buch.'
    );
    expect(html('__fett__ und _kursiv_')).toBe(
      '<strong>fett</strong> und <em>kursiv</em>'
    );
  });

  it('leaves lone stars, underscores inside words and HTML as plain text', () => {
    expect(html('3 * 4 = 12, snake_case_name')).toBe('3 * 4 = 12, snake_case_name');
    expect(html('<b>nein</b> **<i>x</i>**')).toBe(
      '&lt;b&gt;nein&lt;/b&gt; <strong>&lt;i&gt;x&lt;/i&gt;</strong>'
    );
  });
});
