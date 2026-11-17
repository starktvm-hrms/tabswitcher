import { describe, expect, it } from 'vitest';
import { markdownToHtml } from './markdown';

describe('markdownToHtml', () => {
  it('renders the minutes structure', () => {
    const html = markdownToHtml([
      '# Minutes of Meeting — Weekly sync',
      '**Date:** 17 Nov  ·  **Duration:** 30 min',
      '',
      '## Decisions',
      '- Ship the **new** portal',
      '- Use `v2` API',
      '',
      '## Action items',
      '| # | Action | Owner | Due |',
      '|---|--------|-------|-----|',
      '| 1 | Send deck | Priya | Friday |',
      '',
      '1. First',
      '2. Second',
    ].join('\n'));
    expect(html).toContain('<h1>Minutes of Meeting — Weekly sync</h1>');
    expect(html).toContain('<p><strong>Date:</strong> 17 Nov  ·  <strong>Duration:</strong> 30 min</p>');
    expect(html).toContain('<ul><li>Ship the <strong>new</strong> portal</li><li>Use <code>v2</code> API</li></ul>');
    expect(html).toContain('<th>Owner</th>');
    expect(html).toContain('<td>Priya</td>');
    expect(html).toContain('<ol><li>First</li><li>Second</li></ol>');
  });

  it('escapes HTML so model output cannot inject scripts', () => {
    const html = markdownToHtml('# <img src=x onerror=alert(1)>\n- <script>alert(1)</script>\n| a | b |\n|---|---|\n| <b>x</b> | "y" |');
    expect(html).not.toMatch(/<img|<script|<b>/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;y&quot;');
  });
});
