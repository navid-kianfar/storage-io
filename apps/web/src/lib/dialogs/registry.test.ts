import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIALOG_KEYS,
  DIALOG_OWNERS,
  DIALOG_PARAM_PREFIX,
  clearDialogRegistry,
  getDialog,
  isDialogKey,
  registerDialog,
  subscribeDialogs,
} from './registry';

afterEach(() => {
  clearDialogRegistry();
});

describe('dialog registry', () => {
  it('gives every dialog key an owning route', () => {
    // A key with no owner cannot be opened from the palette: `open()` would have
    // nowhere to navigate, and the dialog's module would never load.
    for (const key of DIALOG_KEYS) {
      expect(DIALOG_OWNERS[key], `"${key}" has no owning route`).toMatch(/^\//);
    }
  });

  it('has no owner pointing at a key that does not exist', () => {
    for (const key of Object.keys(DIALOG_OWNERS)) {
      expect(isDialogKey(key)).toBe(true);
    }
  });

  it('returns what was registered, and nothing for what was not', () => {
    const Example = () => null;
    expect(getDialog('add-server')).toBeUndefined();
    registerDialog('add-server', Example);
    expect(getDialog('add-server')).toBe(Example);
  });

  it('rejects a key that is not in the list', () => {
    expect(isDialogKey('not-a-dialog')).toBe(false);
    expect(getDialog('not-a-dialog')).toBeUndefined();
  });

  it('tells subscribers when a dialog registers', () => {
    // The owning module belongs to a lazily loaded route, so it registers *after*
    // the URL already names the dialog. Without this notification the host
    // concluded the key was unwired and stripped `?dialog=` — every command
    // palette action did nothing. Found in the browser.
    const listener = vi.fn();
    const unsubscribe = subscribeDialogs(listener);
    const Example = () => null;

    registerDialog('new-job', Example);
    expect(listener).toHaveBeenCalledTimes(1);

    // Registering the same component again is not a change.
    registerDialog('new-job', Example);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    registerDialog('create-policy', Example);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reserves the d_ prefix so a page filter cannot collide with a dialog param', () => {
    expect(DIALOG_PARAM_PREFIX).toBe('d_');
    // No dialog key may itself start with the param prefix, or clearing the
    // dialog params would also clear the key.
    for (const key of DIALOG_KEYS) {
      expect(key.startsWith(DIALOG_PARAM_PREFIX)).toBe(false);
    }
  });
});
