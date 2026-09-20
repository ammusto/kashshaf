import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SearchInput } from '../types/search';
import type { ProximityInput } from '../components/sidebar/ProximityInputRow';
import type { AppSearchMode } from '../types/search';
import type { NameFormData } from '../utils/namePatterns';
import { createEmptyNameForm } from '../utils/namePatterns';

/**
 * The search form's state, held above the sidebar.
 *
 * The sidebar folds when a search runs, and a folded sidebar is unmounted.
 * State kept inside it — the terms typed, which of AND/OR was open, boolean
 * or proximity, terms or names — went with it, so reopening showed an empty
 * form. Everything the form shows lives here instead and survives the fold.
 */

export type TermSearchMode = 'boolean' | 'proximity';

export interface SearchFormState {
  appSearchMode: AppSearchMode;
  setAppSearchMode: (m: AppSearchMode) => void;
  termSearchMode: TermSearchMode;
  setTermSearchMode: (m: TermSearchMode) => void;

  // boolean
  activeTab: 'and' | 'or';
  setActiveTab: (t: 'and' | 'or') => void;
  andInputs: SearchInput[];
  setAndInputs: (v: SearchInput[]) => void;
  orInputs: SearchInput[];
  setOrInputs: (v: SearchInput[]) => void;
  /** A fresh id for a new input row. */
  nextInputId: () => number;

  // proximity: a chain of two or three terms, a distance per link, the
  // ordering switch, and up to two terms the page must also carry.
  proximityTerms: ProximityInput[];
  setProximityTerms: (v: ProximityInput[]) => void;
  proximityDistances: number[];
  setProximityDistances: (v: number[]) => void;
  proximityOrdered: boolean;
  setProximityOrdered: (v: boolean) => void;
  proximityPageTerms: ProximityInput[];
  setProximityPageTerms: (v: ProximityInput[]) => void;

  // names
  nameFormData: NameFormData[];
  setNameFormData: (v: NameFormData[]) => void;
  generatedPatterns: string[][];
  setGeneratedPatterns: (v: string[][]) => void;
}

const emptyInput = (id: number): SearchInput => ({ id, query: '', mode: 'surface', cliticToggle: false });
const emptyProximity = (): ProximityInput => ({ term: '', field: 'surface' });

const SearchFormContext = createContext<SearchFormState | null>(null);

export function SearchFormProvider({ children }: { children: ReactNode }) {
  const [appSearchMode, setAppSearchMode] = useState<AppSearchMode>('terms');
  const [termSearchMode, setTermSearchMode] = useState<TermSearchMode>('boolean');
  const [activeTab, setActiveTab] = useState<'and' | 'or'>('and');
  const [andInputs, setAndInputs] = useState<SearchInput[]>([emptyInput(1)]);
  const [orInputs, setOrInputs] = useState<SearchInput[]>([emptyInput(1)]);
  const nextId = useRef(2);
  const nextInputId = useCallback(() => nextId.current++, []);
  const [proximityTerms, setProximityTerms] = useState<ProximityInput[]>([emptyProximity(), emptyProximity()]);
  const [proximityDistances, setProximityDistances] = useState<number[]>([10]);
  const [proximityOrdered, setProximityOrdered] = useState(false);
  const [proximityPageTerms, setProximityPageTerms] = useState<ProximityInput[]>([]);
  const [nameFormData, setNameFormData] = useState<NameFormData[]>([createEmptyNameForm('form-0')]);
  const [generatedPatterns, setGeneratedPatterns] = useState<string[][]>([]);

  const value = useMemo<SearchFormState>(
    () => ({
      appSearchMode,
      setAppSearchMode,
      termSearchMode,
      setTermSearchMode,
      activeTab,
      setActiveTab,
      andInputs,
      setAndInputs,
      orInputs,
      setOrInputs,
      nextInputId,
      proximityTerms,
      setProximityTerms,
      proximityDistances,
      setProximityDistances,
      proximityOrdered,
      setProximityOrdered,
      proximityPageTerms,
      setProximityPageTerms,
      nameFormData,
      setNameFormData,
      generatedPatterns,
      setGeneratedPatterns,
    }),
    [
      appSearchMode,
      termSearchMode,
      activeTab,
      andInputs,
      orInputs,
      nextInputId,
      proximityTerms,
      proximityDistances,
      proximityOrdered,
      proximityPageTerms,
      nameFormData,
      generatedPatterns,
    ]
  );

  return <SearchFormContext.Provider value={value}>{children}</SearchFormContext.Provider>;
}

export function useSearchForm(): SearchFormState {
  const ctx = useContext(SearchFormContext);
  if (!ctx) throw new Error('useSearchForm must be used within SearchFormProvider');
  return ctx;
}
