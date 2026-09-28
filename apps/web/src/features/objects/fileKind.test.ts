import { describe, expect, it } from 'vitest';
import { fileKind } from './fileKind';

/**
 * Which preview an object gets. The SVG case is the one that matters: an SVG is
 * markup that can carry scripts and external references, not a picture, and the
 * API now hands it back as an `application/octet-stream` attachment for exactly
 * that reason — so rendering it in an `<img>` would show a broken image at best.
 * It belongs in the read-only code view, as source.
 */
describe('fileKind', () => {
  it('previews an SVG as text, not as an image', () => {
    expect(fileKind('logo.svg')).toBe('text');
    expect(fileKind('logo.svg', 'image/svg+xml')).toBe('text');
    expect(fileKind('anything', 'IMAGE/SVG+XML')).toBe('text');
  });

  it('previews HTML and other markup as text, so nothing is rendered', () => {
    expect(fileKind('page.html', 'text/html')).toBe('text');
    expect(fileKind('feed.xml', 'application/xml')).toBe('text');
    expect(fileKind('app.js', 'text/javascript')).toBe('text');
    expect(fileKind('data.json', 'application/json')).toBe('text');
  });

  it('still previews the inert raster types as images', () => {
    expect(fileKind('photo.png', 'image/png')).toBe('image');
    expect(fileKind('photo.jpg')).toBe('image');
    expect(fileKind('anim.gif', 'image/gif')).toBe('image');
  });

  it('keeps the other kinds it always had', () => {
    expect(fileKind('folder/')).toBe('folder');
    expect(fileKind('clip.mp4')).toBe('video');
    expect(fileKind('song.mp3')).toBe('audio');
    expect(fileKind('report.pdf')).toBe('pdf');
    expect(fileKind('bundle.zip')).toBe('archive');
    expect(fileKind('mystery.bin')).toBe('other');
  });
});
