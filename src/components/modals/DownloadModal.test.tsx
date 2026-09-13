import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CorpusStatus, DataDirInfo } from '../../types';

// The Tauri bridge is mocked: no desktop runtime in unit tests.
const bridge = vi.hoisted(() => ({
  startCorpusDownload: vi.fn(async () => undefined),
  cancelCorpusDownload: vi.fn(async () => undefined),
  getDataDirectoryInfo: vi.fn(),
  openDataDirectory: vi.fn(async () => undefined),
  deleteLocalData: vi.fn(async () => 0),
}));
vi.mock('../../api/tauri', () => bridge);
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

import { DownloadModal, describeState } from './DownloadModal';

const GB = 1024 ** 3;
const dirInfo: DataDirInfo = {
  path: 'C:\\Users\\me\\AppData\\Roaming\\Kashshaf',
  source: 'user',
  writable: true,
  free_bytes: 200 * GB,
  total_bytes: 500 * GB,
  required_bytes: 8.5 * GB,
  margin_bytes: GB,
  enough_space: true,
};

const base: CorpusStatus = {
  ready: false,
  local_version: null,
  remote_version: '4.1.0',
  update_available: false,
  update_required: false,
  missing_files: ['corpus.db', 'metadata.db', 'triples.bin', 'tantivy_index/meta.json'],
  total_download_size: 8.5 * GB,
  remote_notes: null,
  error: null,
};

/** 1. Fresh install: nothing local, everything to fetch. */
const noCorpus: CorpusStatus = { ...base };
/** 2. 4.0.0 installed and readable, 4.1.0 published. */
const updateAvailable: CorpusStatus = {
  ...base,
  ready: true,
  local_version: '4.0.0',
  update_available: true,
  remote_notes: '23 texts added; cleaner display text (footnote markers, stray markup removed).',
};
/** 3. Schema changed: the local corpus cannot be read by this app version. */
const updateRequired: CorpusStatus = {
  ...base,
  ready: false,
  local_version: '4.0.0',
  remote_version: '5.0.0',
  update_required: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  bridge.getDataDirectoryInfo.mockResolvedValue(dirInfo);
});

async function renderModal(status: CorpusStatus, props: Partial<Parameters<typeof DownloadModal>[0]> = {}) {
  const onDownloadComplete = vi.fn();
  const utils = render(<DownloadModal status={status} onDownloadComplete={onDownloadComplete} {...props} />);
  // Preflight resolves before the primary button is enabled.
  await waitFor(() => expect(bridge.getDataDirectoryInfo).toHaveBeenCalled());
  await screen.findByText(dirInfo.path);
  return { ...utils, onDownloadComplete };
}

function footer() {
  // The last flex row in the dialog holds the buttons.
  const buttons = screen.getAllByRole('button').filter((b) => !['Close', 'Open folder'].includes(b.getAttribute('aria-label') ?? b.textContent ?? ''));
  return buttons.map((b) => b.textContent?.trim());
}

describe('describeState', () => {
  it('never says "must" for an optional update', () => {
    const copy = describeState(updateAvailable, { isAppTooOld: false, onlineOffered: false });
    expect(copy.kind).toBe('update_available');
    expect(copy.message.toLowerCase()).not.toContain('must');
    expect(copy.showLater).toBe(true);
    expect(copy.showOnline).toBe(false);
  });

  it('maps the three CorpusStatus shapes to three kinds', () => {
    expect(describeState(noCorpus, { isAppTooOld: false, onlineOffered: true }).kind).toBe('no_corpus');
    expect(describeState(updateAvailable, { isAppTooOld: false, onlineOffered: true }).kind).toBe('update_available');
    expect(describeState(updateRequired, { isAppTooOld: false, onlineOffered: true }).kind).toBe('update_required');
    // update_required wins over update_available if both were ever set
    expect(describeState({ ...updateAvailable, update_required: true }, { isAppTooOld: false, onlineOffered: true }).kind).toBe('update_required');
  });
});

describe('DownloadModal states', () => {
  it('1. no corpus: download copy, "Download N GB" and "Use online mode", no Later', async () => {
    const onOnlineUse = vi.fn();
    await renderModal(noCorpus, { onOnlineUse, showOnlineOption: true });
    expect(screen.getByTestId('corpus-dialog-no_corpus')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Download the corpus' })).toBeInTheDocument();
    expect(screen.getByText(/Offline use needs the corpus on this computer \(8\.5 GB\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download 8.5 GB' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Use online mode' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
    expect(screen.queryByText(/What changed/)).not.toBeInTheDocument();
  });

  it('2. update available: version copy, release notes, "Update now" and "Later"', async () => {
    const onDismiss = vi.fn();
    await renderModal(updateAvailable, { onDismiss, onOnlineUse: vi.fn(), showOnlineOption: true });
    expect(screen.getByTestId('corpus-dialog-update_available')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Corpus update available' })).toBeInTheDocument();
    const body = screen.getByText(/You have corpus 4\.0\.0\. Version 4\.1\.0 is available \(8\.5 GB\)\./);
    expect(body.textContent?.toLowerCase()).not.toContain('must');
    expect(screen.getByText('What changed')).toBeInTheDocument();
    expect(screen.getByText(updateAvailable.remote_notes!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
    // Online mode is not offered: the user already has a working corpus.
    expect(screen.queryByRole('button', { name: 'Use online mode' })).not.toBeInTheDocument();
    // The dialog can also be closed from the header.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('2. update available without notes degrades cleanly', async () => {
    await renderModal({ ...updateAvailable, remote_notes: null }, { onDismiss: vi.fn() });
    expect(screen.queryByText('What changed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
  });

  it('2. "Later" only dismisses: no download, no online switch, nothing deleted', async () => {
    const onDismiss = vi.fn();
    const onOnlineUse = vi.fn();
    const { onDownloadComplete } = await renderModal(updateAvailable, { onDismiss, onOnlineUse, showOnlineOption: true });
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(bridge.startCorpusDownload).not.toHaveBeenCalled();
    expect(bridge.cancelCorpusDownload).not.toHaveBeenCalled();
    expect(bridge.deleteLocalData).not.toHaveBeenCalled();
    expect(onOnlineUse).not.toHaveBeenCalled();
    expect(onDownloadComplete).not.toHaveBeenCalled();
  });

  it('3. update required: explains the format change, "Update now" and "Use online mode", no dismiss', async () => {
    const onOnlineUse = vi.fn();
    await renderModal(updateRequired, { onOnlineUse, showOnlineOption: true });
    expect(screen.getByTestId('corpus-dialog-update_required')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Corpus update required' })).toBeInTheDocument();
    expect(screen.getByText(/this version of the app cannot read corpus 4\.0\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Version 5\.0\.0 \(8\.5 GB\) uses the new format/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Use online mode' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(footer()).not.toContain('Later');
  });

  it('keeps the destination, free-space line and verify checkbox in every state', async () => {
    for (const status of [noCorpus, updateAvailable, updateRequired]) {
      const { unmount } = await renderModal(status, { onDismiss: vi.fn(), onOnlineUse: vi.fn() });
      expect(screen.getByText('Destination')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open folder' })).toBeInTheDocument();
      expect(screen.getByText(/8\.5 GB · 200\.0 GB free of 500\.0 GB/)).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: /Verify downloaded files/ })).not.toBeChecked();
      unmount();
    }
  });

  it('blocks the primary button when the volume is too small, in every state', async () => {
    bridge.getDataDirectoryInfo.mockResolvedValue({ ...dirInfo, free_bytes: 2 * GB, enough_space: false });
    for (const [status, label] of [[noCorpus, 'Download 8.5 GB'], [updateAvailable, 'Update now'], [updateRequired, 'Update now']] as const) {
      const { unmount } = await renderModal(status, { onDismiss: vi.fn() });
      expect(screen.getByText(/Not enough free space/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
      unmount();
    }
  });

  it('starts the download from state 2 with "Update now"', async () => {
    await renderModal(updateAvailable, { onDismiss: vi.fn() });
    await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(bridge.startCorpusDownload).toHaveBeenCalledWith(true); // verify off by default
  });

  it('app too old: no corpus buttons, link to the app download', async () => {
    const tooOld: CorpusStatus = { ...updateRequired, error: 'App version 0.5.0 is too old. Please update to at least 0.6.0' };
    render(<DownloadModal status={tooOld} onDownloadComplete={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'App update required' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download update' })).toHaveAttribute('href', 'https://kashshaf.com/download');
    expect(within(document.body).queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
  });
});
