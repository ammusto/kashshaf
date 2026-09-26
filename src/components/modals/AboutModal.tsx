import { useEffect } from 'react';
import { BUG_EMAIL, REPO_URL } from '../../utils/bugReport';
import { openExternal } from '../../utils/openExternal';

interface AboutModalProps {
  onClose: () => void;
  version: string;
  target: 'desktop' | 'web';
  /** The installed corpus, or null (online mode, no corpus). */
  corpusVersion: string | null;
}

/** Kashshāf: what it is, what version, on what, and where it lives. */
export function AboutModal({ onClose, version, target, corpusVersion }: AboutModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[420px] max-w-[95vw] flex flex-col" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="about-title">
        <div className="px-6 py-4 border-b border-app-border-light flex items-center justify-between">
          <h2 id="about-title" className="text-lg font-semibold text-app-text-primary">About</h2>
          <button onClick={onClose} aria-label="Close" className="text-app-text-tertiary hover:text-app-text-primary text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-5 space-y-2 text-sm text-app-text-primary">
          <p className="text-base font-semibold">Kashshāf</p>
          <p data-testid="about-version">
            Version {version}, {target === 'web' ? 'web app' : 'desktop app'}
          </p>
          <p data-testid="about-corpus">Corpus {corpusVersion ?? 'not installed'}</p>
          <p>
            <button onClick={() => openExternal(REPO_URL)} className="text-app-accent hover:underline">
              github.com/ammusto/kashshaf
            </button>
          </p>
          <p className="text-app-text-secondary">© Antonio Musto 2026</p>
          <p className="select-all text-app-text-secondary">{BUG_EMAIL}</p>
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
