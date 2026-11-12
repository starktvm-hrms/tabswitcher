import { describe, expect, it } from 'vitest';
import { baseName, fileKind, move, toEmbed } from './present';

const src = (url: string) => {
  const r = toEmbed(url);
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('toEmbed', () => {
  it('converts Google Slides edit and published links', () => {
    expect(src('https://docs.google.com/presentation/d/1AbC-d_9/edit#slide=id.p').src)
      .toBe('https://docs.google.com/presentation/d/1AbC-d_9/embed?start=false&loop=false&delayms=3000');
    expect(src('https://docs.google.com/presentation/d/e/2PACX-xyz/pub?start=false').src)
      .toBe('https://docs.google.com/presentation/d/e/2PACX-xyz/embed?start=false&loop=false&delayms=3000');
    expect(src('https://docs.google.com/presentation/d/1AbC/edit').source).toBe('Google Slides');
  });
  it('converts Canva, Pitch and Figma links', () => {
    expect(src('https://www.canva.com/design/DAF1/abc_2/view?utm_content=x').src).toBe('https://www.canva.com/design/DAF1/abc_2/view?embed');
    expect(src('https://www.canva.com/design/DAF1/abc_2/edit').src).toBe('https://www.canva.com/design/DAF1/abc_2/view?embed');
    expect(src('https://pitch.com/public/1234-abcd').src).toBe('https://pitch.com/embed/1234-abcd');
    expect(src('https://www.figma.com/proto/KEY/Deck?node-id=1').src)
      .toBe(`https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent('https://www.figma.com/proto/KEY/Deck?node-id=1')}`);
  });
  it('converts YouTube and Vimeo links', () => {
    expect(src('https://www.youtube.com/watch?v=abc123&t=4').src).toBe('https://www.youtube.com/embed/abc123?rel=0&enablejsapi=1');
    expect(src('https://youtu.be/abc123').src).toBe('https://www.youtube.com/embed/abc123?rel=0&enablejsapi=1');
    expect(src('https://vimeo.com/76979871').src).toBe('https://player.vimeo.com/video/76979871?api=1');
  });
  it('forces the embed view for PowerPoint on SharePoint, and explains OneDrive share links', () => {
    expect(src('https://acme.sharepoint.com/:p:/r/sites/x/_layouts/15/Doc.aspx?sourcedoc=%7B1%7D&action=edit').src)
      .toContain('action=embedview');
    expect(toEmbed('https://1drv.ms/p/s!abc')).toHaveProperty('error');
    expect(src('https://onedrive.live.com/embed?resid=1&authkey=2').source).toBe('PowerPoint');
  });
  it('passes other links through and names PDFs by file name', () => {
    expect(src('https://example.com/deck/index.html').src).toBe('https://example.com/deck/index.html');
    expect(src('https://example.com/files/Q3%20Review.pdf').name).toBe('Q3 Review.pdf');
  });
  it('rejects things that are not http(s) links', () => {
    expect(toEmbed('not a url')).toHaveProperty('error');
    expect(toEmbed('javascript:alert(1)')).toHaveProperty('error');
    expect(toEmbed('file:///C:/deck.pdf')).toHaveProperty('error');
  });
});

describe('fileKind', () => {
  it('accepts PDFs, images, videos and audio by type or extension', () => {
    expect(fileKind('deck.pdf', '')).toEqual({ kind: 'pdf', source: 'PDF' });
    expect(fileKind('cover.PNG', 'image/png')).toEqual({ kind: 'image', source: 'Image' });
    expect(fileKind('reel.mov', '')).toEqual({ kind: 'video', source: 'Video' });
    expect(fileKind('intro.mp3', 'audio/mpeg')).toEqual({ kind: 'audio', source: 'Audio' });
    expect(fileKind('speech.m4a', '')).toEqual({ kind: 'audio', source: 'Audio' });
  });
  it('explains how to handle PowerPoint/Keynote files', () => {
    const r = fileKind('Pitch.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect('error' in r && r.error).toMatch(/Export it as PDF/);
    expect(fileKind('notes.docx', '')).toHaveProperty('error');
  });
});

describe('helpers', () => {
  it('baseName strips the extension', () => {
    expect(baseName('Q3 Review.final.pdf')).toBe('Q3 Review.final');
  });
  it('move reorders without mutating, and ignores out-of-range moves', () => {
    const list = ['a', 'b', 'c'];
    expect(move(list, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(list, 2, 1)).toEqual(['a', 'c', 'b']);
    expect(move(list, 0, -1)).toEqual(list);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});
