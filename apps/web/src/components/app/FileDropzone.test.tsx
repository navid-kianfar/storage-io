import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileDropzone, type DroppedFile, type FileRejection } from './FileDropzone';
import { renderWithProviders } from '@/test/render';

const ONE_KB = 1024;

function fileOf(name: string, bytes: number, type = 'application/json'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function Harness({
  accept,
  maxFiles,
  maxSizeBytes,
  multiple = true,
  allowFolders = false,
  onRejected,
}: {
  readonly accept?: string;
  readonly maxFiles?: number;
  readonly maxSizeBytes?: number;
  readonly multiple?: boolean;
  readonly allowFolders?: boolean;
  readonly onRejected?: (rejections: readonly FileRejection[]) => void;
}) {
  const [files, setFiles] = useState<readonly DroppedFile[]>([]);
  return (
    <FileDropzone
      files={files}
      onFilesChange={setFiles}
      accept={accept}
      maxFiles={maxFiles}
      maxSizeBytes={maxSizeBytes}
      multiple={multiple}
      allowFolders={allowFolders}
      onRejected={onRejected}
    />
  );
}

/** The dashed area is the drop target; it is the only element with this text. */
function dropZone(): Element {
  const zone = screen.getByText(/browse/i).closest('div[data-dragging]');
  if (zone === null) throw new Error('the dropzone is missing');
  return zone;
}

/**
 * A drop is asynchronous: a dropped *folder* only reaches its contents through
 * `webkitGetAsEntry()`, which is callback-based, so the component awaits the walk
 * before it reports anything. jsdom has no entry API, so these drops fall back to
 * `dataTransfer.files` — still after a microtask.
 */
function dropFiles(files: readonly File[]): void {
  fireEvent.drop(dropZone(), { dataTransfer: { files, items: [], types: ['Files'] } });
}

/** One dropped directory entry, as Chrome hands it over. */
function directoryEntry(path: string, children: readonly File[]) {
  const fileEntries = children.map((file) => ({
    isFile: true,
    isDirectory: false,
    name: file.name,
    fullPath: `/${path}/${file.name}`,
    file: (onSuccess: (value: File) => void) => onSuccess(file),
  }));
  let read = false;
  return {
    isFile: false,
    isDirectory: true,
    name: path,
    fullPath: `/${path}`,
    createReader: () => ({
      readEntries: (onSuccess: (entries: readonly unknown[]) => void) => {
        // `readEntries` is called until it answers empty, and the component calls it
        // again from inside the callback — so the flag flips before, not after.
        const batch = read ? [] : fileEntries;
        read = true;
        onSuccess(batch);
      },
    }),
  };
}

function hiddenInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('the file input is missing');
  return input;
}

describe('FileDropzone', () => {
  it('lists the files that were chosen, with their size', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.upload(hiddenInput(), [fileOf('policy.json', ONE_KB)]);

    expect(screen.getByText('policy.json')).toBeInTheDocument();
    // `Settings.region.sizeUnits` defaults to decimal, so 1024 bytes reads in kB.
    expect(screen.getByText('1 kB')).toBeInTheDocument();
  });

  it('removes one file without disturbing the others', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.upload(hiddenInput(), [fileOf('a.json', ONE_KB), fileOf('b.json', ONE_KB)]);
    expect(screen.getByText('a.json')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Remove file' })[0]!);

    expect(screen.queryByText('a.json')).not.toBeInTheDocument();
    expect(screen.getByText('b.json')).toBeInTheDocument();
  });

  it('rejects a file over the size limit and says which one', async () => {
    const user = userEvent.setup();
    const onRejected = vi.fn();
    renderWithProviders(<Harness maxSizeBytes={ONE_KB} onRejected={onRejected} />);

    await user.upload(hiddenInput(), [fileOf('huge.json', ONE_KB * 4)]);

    expect(screen.queryByText('huge.json')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('huge.json');
    expect(onRejected).toHaveBeenCalledWith([{ name: 'huge.json', reason: 'too-large' }]);
  });

  it('rejects a dropped file whose type is not accepted', async () => {
    // The browser already filters the file *picker* by `accept`; a drag-and-drop
    // does not, which is why the component checks it too. So this exercises a drop.
    const onRejected = vi.fn();
    renderWithProviders(<Harness accept=".json" onRejected={onRejected} />);

    dropFiles([fileOf('notes.txt', ONE_KB, 'text/plain')]);

    await waitFor(() =>
      expect(onRejected).toHaveBeenCalledWith([{ name: 'notes.txt', reason: 'wrong-type' }]),
    );
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  });

  it('accepts a dropped file that does match', async () => {
    renderWithProviders(<Harness accept=".json" />);
    dropFiles([fileOf('policy.json', ONE_KB)]);
    expect(await screen.findByText('policy.json')).toBeInTheDocument();
  });

  it('keeps the folder structure of a dropped directory', async () => {
    // Only with `allowFolders`: without it a dropped folder is not walked at all,
    // which is what a dialog that wants single files depends on.
    renderWithProviders(<Harness allowFolders />);

    const entry = directoryEntry('raw', [fileOf('a.json', ONE_KB), fileOf('b.json', ONE_KB)]);
    fireEvent.drop(dropZone(), {
      dataTransfer: {
        files: [],
        items: [{ kind: 'file', webkitGetAsEntry: () => entry }],
        types: ['Files'],
      },
    });

    // The relative path is what the upload uses as the key suffix, so a folder
    // lands as a folder rather than as two loose files.
    expect(await screen.findByText('raw/a.json')).toBeInTheDocument();
    expect(screen.getByText('raw/b.json')).toBeInTheDocument();
  });

  it('stops at maxFiles and reports the overflow', async () => {
    const user = userEvent.setup();
    const onRejected = vi.fn();
    renderWithProviders(<Harness maxFiles={1} onRejected={onRejected} />);

    await user.upload(hiddenInput(), [fileOf('a.json', ONE_KB), fileOf('b.json', ONE_KB)]);

    expect(screen.getByText('a.json')).toBeInTheDocument();
    expect(screen.queryByText('b.json')).not.toBeInTheDocument();
    expect(onRejected).toHaveBeenCalledWith([{ name: 'b.json', reason: 'too-many' }]);
  });

  it('keeps only the last file when multiple is off', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness multiple={false} />);

    await user.upload(hiddenInput(), [fileOf('first.json', ONE_KB)]);
    await user.upload(hiddenInput(), [fileOf('second.json', ONE_KB)]);

    expect(screen.queryByText('first.json')).not.toBeInTheDocument();
    expect(screen.getByText('second.json')).toBeInTheDocument();
  });
});
