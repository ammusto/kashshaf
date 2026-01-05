import { InfoTooltip } from '../ui/InfoTooltip';

interface KunyaGroupProps {
  kunyas: string[];
  allowRareKunyaNisba: boolean;
  allowKunyaNasab: boolean;
  onKunyaChange: (index: number, value: string) => void;
  onAddKunya: () => void;
  onRemoveKunya: (index: number) => void;
  onAllowRareKunyaNisbaChange: (value: boolean) => void;
  onAllowKunyaNasabChange: (value: boolean) => void;
}

export function KunyaGroup({
  kunyas,
  allowRareKunyaNisba,
  allowKunyaNasab,
  onKunyaChange,
  onAddKunya,
  onRemoveKunya,
  onAllowRareKunyaNisbaChange,
  onAllowKunyaNasabChange,
}: KunyaGroupProps) {
  return (
    <div className="flex-[2.5] min-w-[180px] space-y-2">
      <div className="space-y-1.5">
        {kunyas.map((kunya, index) => (
          <div key={index} className="flex gap-1.5 items-center">
            <input
              type="text"
              dir="rtl"
              value={kunya}
              onChange={(e) => onKunyaChange(index, e.target.value)}
              placeholder="كنية/لقب"
              className="flex-1 min-w-0 h-10 px-3 rounded-md border border-app-border-medium
                       focus:outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent-light
                       text-right font-arabic bg-white text-lg"
            />
            {index > 0 && (
              <button
                onClick={() => onRemoveKunya(index)}
                className="w-7 h-7 flex items-center justify-center rounded-md
                         bg-red-50 text-red-500 hover:bg-red-100 transition-colors flex-shrink-0"
                title="Remove"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      {kunyas.length < 2 && (
        <button
          onClick={onAddKunya}
          className="px-2.5 py-1 text-xs font-medium rounded bg-app-surface-variant
                   hover:bg-app-accent-light text-app-text-secondary transition-colors"
        >
          + Add Laqab
        </button>
      )}

      <div className="space-y-1.5 pt-1">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={allowRareKunyaNisba}
            onChange={(e) => onAllowRareKunyaNisbaChange(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
          />
          <span className="text-xs text-app-text-primary">Include kunya + nisba</span>
          <InfoTooltip content="This will include a search for just the kunya and nisba, e.g. أبو منصور الأصبهاني" />
        </label>

        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={allowKunyaNasab}
            onChange={(e) => onAllowKunyaNasabChange(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
          />
          <span className="text-xs text-app-text-primary">Include kunya + 1st nasab</span>
          <InfoTooltip content="This will include a search for just the kunya and first name in the nasab, e.g. أبو محمد أحمد" />
        </label>
      </div>
    </div>
  );
}

interface NasabGroupProps {
  nasab: string;
  allowOneNasab: boolean;
  allowOneNasabNisba: boolean;
  allowTwoNasab: boolean;
  onNasabChange: (value: string) => void;
  onAllowOneNasabChange: (value: boolean) => void;
  onAllowOneNasabNisbaChange: (value: boolean) => void;
  onAllowTwoNasabChange: (value: boolean) => void;
}

export function NasabGroup({
  nasab,
  allowOneNasab,
  allowOneNasabNisba,
  allowTwoNasab,
  onNasabChange,
  onAllowOneNasabChange,
  onAllowOneNasabNisbaChange,
  onAllowTwoNasabChange,
}: NasabGroupProps) {
  return (
    <div className="flex-[4] min-w-[200px] space-y-2">
      <div className="flex gap-1.5 items-center">
        <input
          type="text"
          dir="rtl"
          value={nasab}
          onChange={(e) => onNasabChange(e.target.value)}
          placeholder="نَسَب"
          className="flex-1 min-w-0 h-10 px-3 rounded-md border border-app-border-medium
                   focus:outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent-light
                   text-right font-arabic bg-white text-lg"
        />
        <InfoTooltip content="Enter nasab with at least two names, e.g. معمر بن أحمد" />
      </div>

      <div className="space-y-1.5 pt-1">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={allowOneNasab}
            onChange={(e) => onAllowOneNasabChange(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
          />
          <span className="text-xs text-app-text-primary">Include 1-part nasab</span>
          <InfoTooltip content="This will include a search for just the first name in the nasab, e.g. محمد" />
        </label>

        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={allowOneNasabNisba}
            onChange={(e) => onAllowOneNasabNisbaChange(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
          />
          <span className="text-xs text-app-text-primary">Include 1-part nasab + nisba</span>
          <InfoTooltip content="This will include a search for just the first name in the nasab and the nisba, e.g. محمد الدمشقي" />
        </label>

        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={allowTwoNasab}
            onChange={(e) => onAllowTwoNasabChange(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-app-accent cursor-pointer"
          />
          <span className="text-xs text-app-text-primary">Include 2-part nasab</span>
          <InfoTooltip content="This will include a search for just the two first names in the nasab, e.g. محمد بن أحمد" />
        </label>
      </div>
    </div>
  );
}

interface NisbaGroupProps {
  nisbas: string[];
  shuhra: string;
  showShuhra: boolean;
  onNisbaChange: (index: number, value: string) => void;
  onAddNisba: () => void;
  onRemoveNisba: (index: number) => void;
  onShuhraChange: (value: string) => void;
  onToggleShuhra: () => void;
}

export function NisbaGroup({
  nisbas,
  shuhra,
  showShuhra,
  onNisbaChange,
  onAddNisba,
  onRemoveNisba,
  onShuhraChange,
  onToggleShuhra,
}: NisbaGroupProps) {
  return (
    <div className="flex-[2.5] min-w-[180px] space-y-2">
      <div className="space-y-1.5">
        {nisbas.map((nisba, index) => (
          <div key={index} className="flex gap-1.5 items-center">
            <input
              type="text"
              dir="rtl"
              value={nisba}
              onChange={(e) => onNisbaChange(index, e.target.value)}
              placeholder="نسبة"
              className="flex-1 min-w-0 h-10 px-3 rounded-md border border-app-border-medium
                       focus:outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent-light
                       text-right font-arabic bg-white text-lg"
            />
            {index === 0 && (
              <InfoTooltip content="Enter a nisba, e.g. الأصبهاني" />
            )}
            {index > 0 && (
              <button
                onClick={() => onRemoveNisba(index)}
                className="w-7 h-7 flex items-center justify-center rounded-md
                         bg-red-50 text-red-500 hover:bg-red-100 transition-colors flex-shrink-0"
                title="Remove"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={onAddNisba}
          className="px-2.5 py-1 text-xs font-medium rounded bg-app-surface-variant
                   hover:bg-app-accent-light text-app-text-secondary transition-colors"
        >
          + Add Nisba
        </button>

        {!showShuhra && (
          <button
            onClick={onToggleShuhra}
            className="px-2.5 py-1 text-xs font-medium rounded bg-app-surface-variant
                     hover:bg-app-accent-light text-app-text-secondary transition-colors"
          >
            + Add Shuhra
          </button>
        )}
      </div>

      {showShuhra && (
        <div className="flex gap-1.5 items-center pt-1">
          <input
            type="text"
            dir="rtl"
            value={shuhra}
            onChange={(e) => onShuhraChange(e.target.value)}
            placeholder="شهرة"
            className="flex-1 min-w-0 h-10 px-3 rounded-md border border-app-border-medium
                     focus:outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent-light
                     text-right font-arabic bg-white text-sm"
          />
          <InfoTooltip content="Enter a shuhra, e.g. أبو زرعة" />
          <button
            onClick={onToggleShuhra}
            className="w-7 h-7 flex items-center justify-center rounded-md
                     bg-red-50 text-red-500 hover:bg-red-100 transition-colors flex-shrink-0"
            title="Remove shuhra"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
