import { useEffect, useMemo, useState } from 'react';
import { BUG_EMAIL, BUG_SUBJECT, githubIssueUrl } from '../../utils/bugReport';
import { openExternal } from '../../utils/openExternal';

interface BugReportModalProps {
  onClose: () => void;
  /** The details block, built by `buildDetails` from the running app. */
  details: string;
}

/**
 * Report a problem: two routes, nothing sent by itself. A GitHub issue with
 * the title and details prefilled (an account is needed), or an e-mail to
 * the address shown, with the same details block to paste. The block is
 * visible, monospace, and one button copies it.
 */
export function BugReportModal({ onClose, details }: BugReportModalProps) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const issue = useMemo(() => githubIssueUrl(details), [details]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(details);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose} data-testid="bug-report-backdrop">
      <div className="bg-white rounded-xl shadow-2xl w-[560px] max-w-[95vw] flex flex-col" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="bug-report-title">
        <div className="px-6 py-4 border-b border-app-border-light flex items-center justify-between">
          <h2 id="bug-report-title" className="text-lg font-semibold text-app-text-primary">Report a problem</h2>
          <button onClick={onClose} aria-label="Close" className="text-app-text-tertiary hover:text-app-text-primary text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-5 text-sm text-app-text-primary">
          <div className="flex items-center gap-3">
            <button
              onClick={() => openExternal(issue.url)}
              className="px-4 py-2 rounded-lg bg-app-accent text-white hover:opacity-90 transition-opacity font-medium"
            >
              Open a GitHub issue
            </button>
            <span className="text-xs text-app-text-tertiary">GitHub requires an account.</span>
          </div>

          <p className="leading-relaxed">
            Or email{' '}
            <span className="select-all font-medium" data-testid="bug-email">{BUG_EMAIL}</span>
            {' '}with the subject{' '}
            <span className="select-all font-medium" data-testid="bug-subject">{BUG_SUBJECT}</span>
            {' '}and describe what happened and what you expected.
          </p>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs uppercase tracking-wide text-app-text-tertiary">Please include these details</span>
              <button
                onClick={copy}
                className="px-2 py-1 text-xs rounded border border-app-border-medium text-app-text-secondary hover:text-app-accent hover:border-app-accent transition-colors"
              >
                {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Select and copy' : 'Copy'}
              </button>
            </div>
            <pre className="font-mono text-xs bg-app-surface-variant rounded-lg p-3 whitespace-pre-wrap break-words select-all" data-testid="bug-details" dir="auto">
              {details}
            </pre>
            {issue.truncated && (
              <p className="text-xs text-app-text-tertiary mt-1">The GitHub link carries a shortened copy; paste the full block from here.</p>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-app-border-light flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-app-surface-variant text-app-text-primary hover:bg-app-accent-light transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
