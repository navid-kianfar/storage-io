import { describe, expect, it } from 'vitest';
import {
  DOWNLOAD_SECURITY_HEADERS,
  downloadPresentation,
  zipEntryName,
} from '../../src/modules/objects/object-stream.service';

/**
 * What a browser is allowed to do with an object's bytes.
 *
 * The object store holds whatever was uploaded and the console is served from the
 * same origin as the API, so a stored `text/html` handed back as `text/html` with
 * an inline disposition is cross-site scripting against the console's own
 * session. These cases are that rule, stated as the caller sees it.
 */

describe('downloadPresentation', () => {
  it('renders the inert image types inline when asked', () => {
    for (const type of [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/avif',
      'image/bmp',
    ]) {
      expect(downloadPresentation(type, true)).toEqual({ contentType: type, inline: true });
    }
  });

  it('renders PDF, video and audio inline', () => {
    expect(downloadPresentation('application/pdf', true)).toEqual({
      contentType: 'application/pdf',
      inline: true,
    });
    expect(downloadPresentation('video/mp4', true)).toEqual({
      contentType: 'video/mp4',
      inline: true,
    });
    expect(downloadPresentation('audio/mpeg', true)).toEqual({
      contentType: 'audio/mpeg',
      inline: true,
    });
  });

  it('serves every text subtype as plain text with an explicit charset', () => {
    for (const type of ['text/plain', 'text/html', 'text/markdown', 'text/csv', 'text/css']) {
      expect(downloadPresentation(type, true)).toEqual({
        contentType: 'text/plain; charset=utf-8',
        inline: true,
      });
    }
  });

  it('never renders HTML as HTML, whatever the provider said', () => {
    expect(downloadPresentation('text/html; charset=utf-8', true).contentType).not.toContain(
      'html',
    );
  });

  it('forces an attachment for the scriptable types', () => {
    for (const type of [
      'image/svg+xml',
      'application/xml',
      'application/xhtml+xml',
      'application/javascript',
      'text/javascript;charset=utf-8',
      'application/json',
    ]) {
      const presentation = downloadPresentation(type, true);
      if (type.startsWith('text/')) {
        // text/javascript is still text, so it is shown as source rather than run.
        expect(presentation.contentType).toBe('text/plain; charset=utf-8');
        continue;
      }
      expect(presentation).toEqual({ contentType: 'application/octet-stream', inline: false });
    }
  });

  it('is an attachment when inline was not asked for', () => {
    expect(downloadPresentation('image/png', false)).toEqual({
      contentType: 'image/png',
      inline: false,
    });
  });

  it('falls back to octet-stream when the provider declared nothing', () => {
    expect(downloadPresentation(null, true)).toEqual({
      contentType: 'application/octet-stream',
      inline: false,
    });
    expect(downloadPresentation(undefined, true).inline).toBe(false);
  });

  it('ignores the parameters and the case the provider used', () => {
    expect(downloadPresentation('IMAGE/PNG; name="x.png"', true)).toEqual({
      contentType: 'image/png',
      inline: true,
    });
  });
});

describe('the headers every object response carries', () => {
  it('turns sniffing off and forbids the document loading anything', () => {
    expect(DOWNLOAD_SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    const policy = DOWNLOAD_SECURITY_HEADERS['Content-Security-Policy'] ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain('sandbox');
  });

  it('still lets the built-in PDF and media viewers read the bytes', () => {
    const policy = DOWNLOAD_SECURITY_HEADERS['Content-Security-Policy'] ?? '';
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("media-src 'self' blob:");
    expect(policy).toContain("frame-src 'self' blob:");
  });
});

/**
 * An object key is not a path. S3 stores `../../etc/passwd` without complaint,
 * and several extractors still resolve a ZIP entry name against the destination
 * directory.
 */
describe('zipEntryName', () => {
  it('leaves an ordinary key alone', () => {
    expect(zipEntryName('photos/2024/beach.jpg')).toBe('photos/2024/beach.jpg');
  });

  it('drops parent-directory segments rather than resolving them', () => {
    expect(zipEntryName('../../etc/passwd')).toBe('etc/passwd');
    expect(zipEntryName('a/../../b.txt')).toBe('a/b.txt');
  });

  it('drops leading slashes so the entry cannot be absolute', () => {
    expect(zipEntryName('/etc/passwd')).toBe('etc/passwd');
    expect(zipEntryName('///a/b')).toBe('a/b');
  });

  it('treats a backslash as a separator, as a Windows extractor does', () => {
    expect(zipEntryName('..\\..\\windows\\system32\\x.dll')).toBe('windows/system32/x.dll');
  });

  it('drops single-dot segments and collapses empty ones', () => {
    expect(zipEntryName('./a//./b')).toBe('a/b');
  });

  it('is null when nothing safe is left, so the caller can skip and report', () => {
    expect(zipEntryName('..')).toBeNull();
    expect(zipEntryName('../..')).toBeNull();
    expect(zipEntryName('/')).toBeNull();
    expect(zipEntryName('')).toBeNull();
  });
});
