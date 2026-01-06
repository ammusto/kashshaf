import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import type { SearchAPI, OperatingMode } from '../api';
import { getOnlineAPI } from '../api/online';
import { isWebTarget } from '../utils/platform';
import { getUserSetting, setUserSetting } from '../utils/storage';

interface OperatingModeContextValue {
  /** Current operating mode */
  mode: OperatingMode;
  /** Whether corpus files exist locally */
  corpusDownloaded: boolean;
  /** Loading state during initialization */
  loading: boolean;
  /** The API instance to use for data access */
  api: SearchAPI;
  /** Set the operating mode (only allowed when corpus doesn't exist) */
  setMode: (mode: 'online' | 'offline') => void;
  /** Check and update corpus existence status */
  refreshCorpusStatus: () => Promise<void>;
}

const OperatingModeContext = createContext<OperatingModeContextValue | null>(null);

interface OperatingModeProviderProps {
  children: ReactNode;
}

// User settings keys
const SETTING_SKIP_DOWNLOAD_PROMPT = 'skip_download_prompt';
const SETTING_MODE = 'mode';

export function OperatingModeProvider({ children }: OperatingModeProviderProps) {
  const [mode, setModeState] = useState<OperatingMode>('pending');
  const [corpusDownloaded, setCorpusDownloaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [api, setApi] = useState<SearchAPI>(getOnlineAPI());

  // Initialize mode based on corpus existence and user settings
  useEffect(() => {
    async function initialize() {
      try {
        setLoading(true);

        // Web target: always use online mode
        if (isWebTarget()) {
          setModeState('online');
          setApi(getOnlineAPI());
          setCorpusDownloaded(false);
          setLoading(false);
          return;
        }

        // Desktop target: dynamic import to avoid bundling Tauri for web
        const { corpusExists } = await import('../api/tauri');
        const { getOfflineAPI } = await import('../api/offline');

        // Check if corpus exists locally
        const exists = await corpusExists();
        setCorpusDownloaded(exists);

        if (exists) {
          // Corpus exists: always use offline mode
          setModeState('offline');
          setApi(getOfflineAPI());
        } else {
          // Corpus doesn't exist: check user settings
          const skipPrompt = await getUserSetting(SETTING_SKIP_DOWNLOAD_PROMPT);
          const savedMode = await getUserSetting(SETTING_MODE);

          if (skipPrompt === 'true' && savedMode === 'online') {
            // User previously chose to skip prompt and use online mode
            setModeState('online');
            setApi(getOnlineAPI());
          } else {
            // Show download prompt (pending state)
            setModeState('pending');
          }
        }
      } catch (err) {
        console.error('Failed to initialize operating mode:', err);
        // Default to pending state on error (or online for web)
        if (isWebTarget()) {
          setModeState('online');
          setApi(getOnlineAPI());
        } else {
          setModeState('pending');
        }
      } finally {
        setLoading(false);
      }
    }

    initialize();
  }, []);

  // Update API instance when mode changes
  useEffect(() => {
    async function updateApi() {
      if (mode === 'online') {
        setApi(getOnlineAPI());
      } else if (mode === 'offline' && !isWebTarget()) {
        const { getOfflineAPI } = await import('../api/offline');
        setApi(getOfflineAPI());
      }
    }
    updateApi();
  }, [mode]);

  const setMode = useCallback((newMode: 'online' | 'offline') => {
    setModeState(newMode);
  }, []);

  const refreshCorpusStatus = useCallback(async () => {
    // No-op for web target
    if (isWebTarget()) {
      return;
    }

    try {
      const { corpusExists } = await import('../api/tauri');
      const { getOfflineAPI } = await import('../api/offline');

      const exists = await corpusExists();
      setCorpusDownloaded(exists);

      if (exists) {
        // If corpus now exists, switch to offline mode
        setModeState('offline');
        setApi(getOfflineAPI());
      }
    } catch (err) {
      console.error('Failed to refresh corpus status:', err);
    }
  }, []);

  const value: OperatingModeContextValue = {
    mode,
    corpusDownloaded,
    loading,
    api,
    setMode,
    refreshCorpusStatus,
  };

  return (
    <OperatingModeContext.Provider value={value}>
      {children}
    </OperatingModeContext.Provider>
  );
}

export function useOperatingMode(): OperatingModeContextValue {
  const context = useContext(OperatingModeContext);
  if (!context) {
    throw new Error('useOperatingMode must be used within an OperatingModeProvider');
  }
  return context;
}

// Re-export helper functions for saving user preferences
export async function saveOnlineModePreference(skipPrompt: boolean): Promise<void> {
  // No-op for web target (always online)
  if (isWebTarget()) {
    return;
  }
  await setUserSetting(SETTING_SKIP_DOWNLOAD_PROMPT, skipPrompt ? 'true' : 'false');
  if (skipPrompt) {
    await setUserSetting(SETTING_MODE, 'online');
  }
}

export async function clearModePreference(): Promise<void> {
  // No-op for web target (always online)
  if (isWebTarget()) {
    return;
  }
  await setUserSetting(SETTING_SKIP_DOWNLOAD_PROMPT, 'false');
  await setUserSetting(SETTING_MODE, '');
}
