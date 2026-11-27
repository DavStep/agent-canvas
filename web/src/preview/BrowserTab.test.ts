import { describe, expect, it } from 'vitest';
import { loadFailure } from './loadFailure.ts';
import { addressToUrl, errorText } from './BrowserTab.tsx';

describe('addressToUrl', () => {
  it('gives loopback hosts http and other bare hosts https', () => {
    expect(addressToUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(addressToUrl(' 127.0.0.1:4747/x ')).toBe('http://127.0.0.1:4747/x');
    expect(addressToUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(addressToUrl('example.com:8080/')).toBe('https://example.com:8080/');
  });

  it('keeps a scheme the owner wrote (the main process refuses what it does not open)', () => {
    expect(addressToUrl('http://example.com/')).toBe('http://example.com/');
    expect(addressToUrl('file:///etc/passwd')).toBe('file:///etc/passwd');
    expect(addressToUrl('')).toBeNull();
  });
});

describe('errorText', () => {
  it("drops Electron's wrapping of a refusal from the main process", () => {
    expect(errorText(new Error("Error invoking remote method 'canvas:preview': Error: file: addresses are not opened here")))
      .toBe('file: addresses are not opened here');
  });
});

describe('loadFailure', () => {
  it('identifies the local host and port that refused the connection', () => {
    const note = loadFailure('ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/game');
    expect(note.title).toBe('Connection refused');
    expect(note.detail).toContain('127.0.0.1:5173');
    expect(note.detail).toContain('running on that port');
  });

  it('distinguishes a blocked port from a stopped server and preserves unknown diagnostics', () => {
    expect(loadFailure('ERR_UNSAFE_PORT', 'http://localhost:6000/').title).toBe('Port blocked');
    expect(loadFailure('ERR_UNEXPECTED', null).code).toBe('ERR_UNEXPECTED');
  });
});
