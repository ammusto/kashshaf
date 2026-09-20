interface AddRowButtonProps {
  label: string;
  onClick: () => void;
  testId?: string;
}

/** The dashed "+ Add …" button at the foot of a search form, one style for every form. */
export function AddRowButton({ label, onClick, testId }: AddRowButtonProps) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="w-full h-9 border-2 border-dashed border-app-border-medium rounded-lg
               text-app-text-secondary text-sm font-medium
               hover:border-app-accent hover:text-app-accent transition-colors flex-shrink-0"
    >
      {label}
    </button>
  );
}
