import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BugReportModal } from './BugReportModal';
import { AboutModal } from './AboutModal';

const details = 'Kashshaf 0.8.1 desktop · offline · corpus 4.3.0 · Windows 11\nLast search: proximity, الله ~15 قال, ordered, page term النبي';

let written: string[];
beforeEach(() => {
  written = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (t: string) => { written.push(t); }) },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the bug report dialog', () => {
  it('shows both routes and the details block, and Copy puts the block on the clipboard', async () => {
    render(<BugReportModal onClose={() => {}} details={details} />);
    expect(screen.getByRole('heading', { name: 'Report a problem' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open a GitHub issue' })).toBeInTheDocument();
    expect(screen.getByText(/GitHub requires an account/)).toBeInTheDocument();
    expect(screen.getByTestId('bug-email')).toHaveTextContent('antonio@kashshaf.com');
    expect(screen.getByTestId('bug-subject')).toHaveTextContent('[Bug] Kashshāf Issue');
    expect(screen.getByTestId('bug-details')).toHaveTextContent('Kashshaf 0.8.1 desktop');
    expect(screen.getByTestId('bug-details').textContent).toBe(details);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(written).toEqual([details]));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('closes on Escape and on the backdrop', () => {
    const onClose = vi.fn();
    render(<BugReportModal onClose={onClose} details={details} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('bug-report-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('the About dialog', () => {
  it('names the version, the target and the corpus, or that none is installed', () => {
    const { rerender } = render(<AboutModal onClose={() => {}} version="0.8.1" target="desktop" corpusVersion="4.3.0" />);
    expect(screen.getByTestId('about-version')).toHaveTextContent('Version 0.8.1, desktop app');
    expect(screen.getByTestId('about-corpus')).toHaveTextContent('Corpus 4.3.0');
    expect(screen.getByText('github.com/ammusto/kashshaf')).toBeInTheDocument();
    expect(screen.getByText('© Antonio Musto 2026')).toBeInTheDocument();
    expect(screen.getByText('antonio@kashshaf.com')).toBeInTheDocument();
    rerender(<AboutModal onClose={() => {}} version="0.8.1" target="web" corpusVersion={null} />);
    expect(screen.getByTestId('about-version')).toHaveTextContent('web app');
    expect(screen.getByTestId('about-corpus')).toHaveTextContent('Corpus not installed');
  });
});
