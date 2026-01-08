import { useRef, useEffect } from 'react';
import type { Token } from '../../types';

export interface TokenPopupProps {
  token: Token;
  position: { x: number; y: number };
  onClose: () => void;
}

function InfoRow({
  label,
  value,
  rtl,
  accent,
  small,
  tall,
}: {
  label: string;
  value?: string;
  rtl?: boolean;
  accent?: boolean;
  small?: boolean;
  tall?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-app-text-secondary w-16 flex-shrink-0">
        {label}:
      </span>
      <span
        dir={rtl ? 'rtl' : 'ltr'}
        className={`
          ${small ? 'text-sm' : 'text-xl'}
          ${accent ? 'text-app-accent font-medium' : 'text-app-text-primary'}
          ${rtl ? 'font-arabic text-right' : ''}
          ${tall ? 'leading-loose' : ''}
          flex-1 truncate
        `}
      >
        {value || '—'}
      </span>
    </div>
  );
}

export function TokenPopup({ token, position, onClose }: TokenPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Popup dimensions
  const popupWidth = 256; // w-64 = 16rem = 256px
  const popupHeight = 280; // approximate height
  const padding = 10;

  // Adjust position to keep popup in viewport
  let left = position.x;
  let top = position.y + padding;

  // Clamp horizontal position
  if (left + popupWidth > window.innerWidth - padding) {
    left = window.innerWidth - popupWidth - padding;
  }
  if (left < padding) {
    left = padding;
  }

  // Clamp vertical position - prefer below click, but flip above if no room
  if (top + popupHeight > window.innerHeight - padding) {
    // Try placing above the click point
    top = position.y - popupHeight - padding;
    if (top < padding) {
      // No room above either, just clamp to bottom
      top = window.innerHeight - popupHeight - padding;
    }
  }
  if (top < padding) {
    top = padding;
  }

  return (
    <div
      ref={popupRef}
      className="fixed bg-white border border-app-border-medium rounded-lg shadow-app-lg
                 w-64 z-50"
      style={{
        left: `${left}px`,
        top: `${top}px`,
      }}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-app-text-primary">
            Token Information
          </h3>
          <button
            onClick={onClose}
            className="w-5 h-5 bg-app-surface-variant rounded text-xs text-app-text-secondary
                     hover:bg-app-border-light flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="h-px bg-app-border-light" />

        <InfoRow label="Surface" value={token.surface} rtl tall />
        <InfoRow label="Lemma" value={token.lemma} rtl tall />
        <InfoRow label="Root" value={token.root} rtl tall />
        <InfoRow label="POS" value={token.pos} rtl />
        <InfoRow label="Features" value={token.features.join(', ')} small rtl />
        <InfoRow label="Clitics" value={token.clitics.map(c => c.display).join(', ')} rtl />
      </div>
    </div>
  );
}
