import { useState } from 'react';
import { KunyaGroup, NasabGroup, NisbaGroup } from './NameInputGroup';
import type { NameFormData } from '../../utils/namePatterns';
import { createEmptyNameForm, generateDisplayPatterns, hasValidForm } from '../../utils/namePatterns';

interface NameSearchFormProps {
  forms: NameFormData[];
  onFormsChange: (forms: NameFormData[]) => void;
  onSearch: () => void;
  loading: boolean;
  generatedPatterns: string[][]; // Used for display after search is triggered
}

function SingleNameForm({
  form,
  formIndex,
  canDelete,
  onChange,
  onDelete,
}: {
  form: NameFormData;
  formIndex: number;
  canDelete: boolean;
  onChange: (updated: NameFormData) => void;
  onDelete: () => void;
}) {
  const [showShuhra, setShowShuhra] = useState(form.shuhra.length > 0);

  const handleKunyaChange = (index: number, value: string) => {
    const newKunyas = [...form.kunyas];
    newKunyas[index] = value;
    onChange({ ...form, kunyas: newKunyas });
  };

  const handleAddKunya = () => {
    if (form.kunyas.length < 2) {
      onChange({ ...form, kunyas: [...form.kunyas, ''] });
    }
  };

  const handleRemoveKunya = (index: number) => {
    if (form.kunyas.length > 1) {
      onChange({ ...form, kunyas: form.kunyas.filter((_, i) => i !== index) });
    }
  };

  const handleNisbaChange = (index: number, value: string) => {
    const newNisbas = [...form.nisbas];
    newNisbas[index] = value;
    onChange({ ...form, nisbas: newNisbas });
  };

  const handleAddNisba = () => {
    onChange({ ...form, nisbas: [...form.nisbas, ''] });
  };

  const handleRemoveNisba = (index: number) => {
    if (form.nisbas.length > 1) {
      onChange({ ...form, nisbas: form.nisbas.filter((_, i) => i !== index) });
    }
  };

  const handleToggleShuhra = () => {
    if (showShuhra) {
      onChange({ ...form, shuhra: '' });
    }
    setShowShuhra(!showShuhra);
  };

  const handleResetForm = () => {
    onChange(createEmptyNameForm(form.id));
    setShowShuhra(false);
  };

  return (
    <div className={`p-4 space-y-3 ${formIndex < 3 ? 'border-b border-app-border-light' : ''}`}>
      {/* Input groups - flex with wrapping */}
      <div className="flex flex-wrap gap-4" dir="rtl">
        <KunyaGroup
          kunyas={form.kunyas}
          allowRareKunyaNisba={form.allowRareKunyaNisba}
          allowKunyaNasab={form.allowKunyaNasab}
          onKunyaChange={handleKunyaChange}
          onAddKunya={handleAddKunya}
          onRemoveKunya={handleRemoveKunya}
          onAllowRareKunyaNisbaChange={(v) => onChange({ ...form, allowRareKunyaNisba: v })}
          onAllowKunyaNasabChange={(v) => onChange({ ...form, allowKunyaNasab: v })}
        />

        <NasabGroup
          nasab={form.nasab}
          allowOneNasab={form.allowOneNasab}
          allowOneNasabNisba={form.allowOneNasabNisba}
          allowTwoNasab={form.allowTwoNasab}
          onNasabChange={(v) => onChange({ ...form, nasab: v })}
          onAllowOneNasabChange={(v) => onChange({ ...form, allowOneNasab: v })}
          onAllowOneNasabNisbaChange={(v) => onChange({ ...form, allowOneNasabNisba: v })}
          onAllowTwoNasabChange={(v) => onChange({ ...form, allowTwoNasab: v })}
        />

        <NisbaGroup
          nisbas={form.nisbas}
          shuhra={form.shuhra}
          showShuhra={showShuhra}
          onNisbaChange={handleNisbaChange}
          onAddNisba={handleAddNisba}
          onRemoveNisba={handleRemoveNisba}
          onShuhraChange={(v) => onChange({ ...form, shuhra: v })}
          onToggleShuhra={handleToggleShuhra}
        />
      </div>

      {/* Form action buttons */}
      <div className="flex gap-2 pt-2">
        <button
          onClick={handleResetForm}
          className="px-3 py-1.5 text-xs font-medium rounded bg-app-surface-variant
                   hover:bg-app-accent-light text-app-text-secondary transition-colors"
        >
          Reset Form
        </button>

        {canDelete && (
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-xs font-medium rounded bg-red-50
                     hover:bg-red-100 text-red-600 transition-colors"
          >
            Delete Name
          </button>
        )}
      </div>
    </div>
  );
}

function PatternPreview({
  patterns,
  isExpanded,
  onToggle,
}: {
  patterns: string[][];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const allPatterns = patterns.flat();
  const patternCount = allPatterns.length;

  if (patternCount === 0) return null;

  return (
    <div className="border-t border-app-border-light">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2 flex items-center gap-2 text-xs text-app-text-secondary hover:bg-app-surface-variant transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span>Generated Patterns ({patternCount})</span>
      </button>

      {isExpanded && (
        <div className="px-4 pb-3 max-h-40 overflow-y-auto">
          <div className="bg-app-surface-variant rounded-lg p-3 space-y-1" dir="rtl">
            {allPatterns.map((pattern, index) => (
              <div key={index} className="text-sm font-arabic text-app-text-primary">
                {pattern}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function NameSearchForm({
  forms,
  onFormsChange,
  onSearch,
  loading,
  generatedPatterns: _generatedPatterns, // eslint-disable-line @typescript-eslint/no-unused-vars
}: NameSearchFormProps) {
  const [showPatternPreview, setShowPatternPreview] = useState(false);
  const [nextFormId, setNextFormId] = useState(1);

  const handleFormChange = (index: number, updated: NameFormData) => {
    const newForms = [...forms];
    newForms[index] = updated;
    onFormsChange(newForms);
  };

  const handleAddForm = () => {
    if (forms.length < 4) {
      const newForm = createEmptyNameForm(`form-${nextFormId}`);
      setNextFormId(nextFormId + 1);
      onFormsChange([...forms, newForm]);
    }
  };

  const handleDeleteForm = (index: number) => {
    if (forms.length > 1) {
      onFormsChange(forms.filter((_, i) => i !== index));
    }
  };

  const isValid = hasValidForm(forms);

  // Calculate display patterns for preview
  const displayPatterns = forms.map(form => generateDisplayPatterns(form));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValid && !loading) {
      onSearch();
    }
  };

  return (
    <div className="flex flex-col h-full" onKeyDown={handleKeyDown}>
      {/* Scrollable forms container */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {forms.map((form, index) => (
          <SingleNameForm
            key={form.id}
            form={form}
            formIndex={index}
            canDelete={forms.length > 1}
            onChange={(updated) => handleFormChange(index, updated)}
            onDelete={() => handleDeleteForm(index)}
          />
        ))}
      </div>

      {/* Add Name button */}
      {forms.length < 4 && (
        <div className="px-4 py-2 border-t border-app-border-light flex-shrink-0">
          <button
            onClick={handleAddForm}
            className="w-full h-9 border-2 border-dashed border-app-border-medium rounded-lg
                     text-app-text-secondary text-sm font-medium
                     hover:border-app-accent hover:text-app-accent transition-colors"
          >
            + Add Name
          </button>
        </div>
      )}

      {/* Pattern preview */}
      <PatternPreview
        patterns={displayPatterns}
        isExpanded={showPatternPreview}
        onToggle={() => setShowPatternPreview(!showPatternPreview)}
      />

      {/* Search button */}
      <div className="px-4 py-3 border-t border-app-border-light flex-shrink-0">
        <button
          onClick={onSearch}
          disabled={loading || !isValid}
          className="w-full h-11 bg-app-accent hover:bg-app-accent-hover
                   text-white rounded-lg font-semibold text-sm
                   disabled:opacity-50 disabled:cursor-not-allowed transition-colors
                   shadow-sm"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>
    </div>
  );
}
