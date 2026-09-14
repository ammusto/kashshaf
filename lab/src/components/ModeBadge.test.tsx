import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModeBadge, UnavailableNotice } from './ModeBadge';
import type { LabStatus } from '../api/lab';

/**
 * Spec §2.4 and ground rule 5: the badge says which mode Lab is in, and a mode
 * that was not chosen carries its reason rather than disappearing.
 */

function status(over: Partial<LabStatus> = {}): LabStatus {
  return {
    mode: 'local',
    corpus_version: '4.1.0',
    corpus_dir: 'C:/Users/x/AppData/Roaming/Kashshaf',
    api_base: null,
    bulk_tokens: true,
    lab_dir: 'C:/Users/x/AppData/Roaming/KashshafLab',
    lab_version: '0.1.0',
    local_error: null,
    api_error: null,
    ...over,
  };
}

describe('ModeBadge', () => {
  it('names the corpus version in local mode and offers no recheck', () => {
    render(<ModeBadge status={status()} onRetry={vi.fn()} />);
    expect(screen.getByTestId('mode-badge')).toHaveTextContent('Local corpus 4.1.0');
    expect(screen.queryByRole('button', { name: 'Recheck' })).toBeNull();
  });

  it('says Online in api mode and keeps the reason local mode was skipped', () => {
    render(
      <ModeBadge
        status={status({
          mode: 'api',
          api_base: 'https://api.kashshaf.com',
          local_error: 'corpus.db is missing from C:/…/Kashshaf',
          bulk_tokens: false,
        })}
        onRetry={vi.fn()}
      />
    );
    const badge = screen.getByTestId('mode-badge');
    expect(badge).toHaveTextContent('Online 4.1.0');
    expect(badge).toHaveAttribute('title', 'corpus.db is missing from C:/…/Kashshaf');
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeEnabled();
  });

  it('says so when neither mode is available', () => {
    render(
      <ModeBadge
        status={status({
          mode: 'unavailable',
          corpus_version: null,
          local_error: 'no corpus',
          api_error: 'connection refused',
        })}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByTestId('mode-badge')).toHaveTextContent('No corpus');
    expect(screen.getByTestId('mode-badge')).toHaveAttribute(
      'title',
      'no corpus · connection refused'
    );
  });

  it('shows Checking before the first status arrives', () => {
    render(<ModeBadge status={null} onRetry={vi.fn()} />);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });
});

describe('UnavailableNotice', () => {
  it('gives both reasons and where it looked', () => {
    render(
      <UnavailableNotice
        status={status({
          mode: 'unavailable',
          corpus_version: null,
          api_base: 'https://api.kashshaf.com',
          local_error: 'corpus.db is missing from C:/Kashshaf',
          api_error: 'error sending request',
        })}
      />
    );
    expect(screen.getByText('corpus.db is missing from C:/Kashshaf')).toBeInTheDocument();
    expect(screen.getByText('error sending request')).toBeInTheDocument();
    expect(screen.getByText(/Looked in C:\/Users/)).toBeInTheDocument();
    expect(screen.getByText('https://api.kashshaf.com')).toBeInTheDocument();
  });
});
