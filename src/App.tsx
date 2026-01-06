import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import type { SearchMode, SearchHistoryEntry, SavedSearchEntry, CorpusStatus } from './types';
import type { AppSearchMode, CombinedSearchQuery, ProximitySearchQuery } from './types/search';
import { MAX_RESULTS, CONCORDANCE_MAX_RESULTS } from './constants/search';
import { useSearchTabsContext } from './contexts/SearchTabsContext';
import { useOperatingMode, saveOnlineModePreference } from './contexts/OperatingModeContext';
import { BooksProvider } from './contexts/BooksContext';
import { useSearch } from './hooks/useSearch';
import { useReaderNavigation } from './hooks/useReaderNavigation';
import { Sidebar } from './components/Sidebar';
import { ReaderPanel, ResultsPanel, ConcordancePanel, HelpPanel } from './components/panels';
import { DraggableSplitter, UpdateBanner } from './components/ui';
import { TextSelectionModal, MetadataBrowser, SavedSearchesModal, SearchHistoryModal } from './components/modals';
import { Toolbar } from './components/Toolbar';
import { SearchTabs, type TabData } from './components/SearchTabs';
import type { NameFormData } from './utils/namePatterns';
import { createEmptyNameForm } from './utils/namePatterns';
import { isWebTarget } from './utils/platform';

// Lazy load DownloadModal only for desktop
const DownloadModal = lazy(() => import('./components/modals/DownloadModal').then(m => ({ default: m.DownloadModal })));

function App() {
  // Operating mode context
  const { mode, corpusDownloaded, loading: modeLoading, api, setMode, refreshCorpusStatus } = useOperatingMode();

  // Corpus status state (for download modal)
  const [corpusStatus, setCorpusStatus] = useState<CorpusStatus | null>(null);
  const [checkingCorpus, setCheckingCorpus] = useState(true);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Tab-based state from context
  const {
    tabs,
    activeTabId,
    activeTab,
    setActiveTabId,
    closeTab,
  } = useSearchTabsContext();

  // App-level search mode (terms, names, concordance)
  const [appSearchMode, setAppSearchMode] = useState<AppSearchMode>('terms');

  // Name search form state (kept in App for sidebar)
  const [nameFormData, setNameFormData] = useState<NameFormData[]>([createEmptyNameForm('form-0')]);
  const [generatedPatterns, setGeneratedPatterns] = useState<string[][]>([]);

  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());

  // Concordance sidebar state
  const [concordanceQuery, setConcordanceQuery] = useState('');
  const [concordanceMode, setConcordanceMode] = useState<SearchMode>('lemma');
  const [concordanceIgnoreClitics, setConcordanceIgnoreClitics] = useState(false);

  const [splitterRatio, setSplitterRatio] = useState(() => {
    const saved = localStorage.getItem('splitterRatio');
    return saved ? parseFloat(saved) : 0.6;
  });

  const [textSelectionModalOpen, setTextSelectionModalOpen] = useState(false);
  const [textBrowserOpen, setTextBrowserOpen] = useState(false);
  const [searchHistoryModalOpen, setSearchHistoryModalOpen] = useState(false);
  const [savedSearchesModalOpen, setSavedSearchesModalOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [stats, setStats] = useState<{ indexed_pages: number; total_books: number } | null>(null);

  // Reader navigation hook
  const { handleNavigatePage, loadResultIntoTab } = useReaderNavigation({ api });

  // Use search hook with selected book IDs and loadResultIntoTab
  const {
    handleSearch,
    handleProximitySearch,
    handleNameSearch: handleNameSearchFromHook,
    handleConcordanceSearch: handleConcordanceSearchFromHook,
    handleLoadMore,
    handleExportResults,
    handleConcordanceExport,
    handleResultClick,
  } = useSearch({ selectedBookIds, loadResultIntoTab, api });

  // Wrap name search to update generated patterns
  const handleNameSearch = useCallback(async () => {
    const { displayPatterns } = await handleNameSearchFromHook(nameFormData);
    setGeneratedPatterns(displayPatterns);
  }, [handleNameSearchFromHook, nameFormData]);

  // Wrap concordance search to use local state
  const handleConcordanceSearch = useCallback(async () => {
    await handleConcordanceSearchFromHook(concordanceQuery, concordanceMode, concordanceIgnoreClitics);
  }, [handleConcordanceSearchFromHook, concordanceQuery, concordanceMode, concordanceIgnoreClitics]);

  // Check corpus status on mount (only when mode is pending or offline)
  useEffect(() => {
    async function checkStatus() {
      // Skip for web target or online mode
      if (isWebTarget() || mode === 'online') {
        setCheckingCorpus(false);
        return;
      }

      try {
        setCheckingCorpus(true);
        // Dynamic import for desktop only
        const { checkCorpusStatus } = await import('./api/tauri');
        const status = await checkCorpusStatus();
        setCorpusStatus(status);

        // Show download modal if mode is pending (user needs to choose)
        if (mode === 'pending') {
          setShowDownloadModal(true);
        } else if (mode === 'offline') {
          // In offline mode, show modal only if data not ready or update required
          if (!status.ready || status.update_required) {
            setShowDownloadModal(true);
          } else if (status.update_available) {
            // Show banner for optional updates
            setShowUpdateBanner(true);
          }
        }
      } catch (err) {
        console.error('Failed to check corpus status:', err);
        // If check fails and mode is pending, show download modal
        if (mode === 'pending') {
          setShowDownloadModal(true);
          setCorpusStatus({
            ready: false,
            local_version: null,
            remote_version: null,
            update_available: false,
            update_required: false,
            missing_files: [],
            total_download_size: 0,
            error: `Failed to check status: ${err}`,
          });
        }
      } finally {
        setCheckingCorpus(false);
      }
    }

    if (!modeLoading) {
      checkStatus();
    }
  }, [mode, modeLoading]);

  // Load stats when corpus is ready and we're in offline mode
  useEffect(() => {
    if (mode === 'offline' && !checkingCorpus && corpusStatus?.ready && !showDownloadModal && !isWebTarget()) {
      loadStats();
    }
  }, [mode, checkingCorpus, corpusStatus?.ready, showDownloadModal]);

  useEffect(() => {
    localStorage.setItem('splitterRatio', splitterRatio.toString());
  }, [splitterRatio]);

  async function loadStats() {
    // Skip for web target
    if (isWebTarget()) return;

    try {
      const { getStats } = await import('./api/tauri');
      const appStats = await getStats();
      setStats(appStats);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  }

  // Prepare tab data for SearchTabs component
  const tabData: TabData[] = tabs.map(tab => ({
    id: tab.id,
    label: tab.label,
    fullQuery: tab.fullQuery,
  }));

  // Determine if current tab is concordance
  const isConcordanceTab = activeTab?.tabType === 'concordance';

  // Handle download complete - reload app state and recheck status (desktop only)
  const handleDownloadComplete = useCallback(async () => {
    // Skip for web target
    if (isWebTarget()) return;

    try {
      const { reloadAppState, checkCorpusStatus } = await import('./api/tauri');
      const success = await reloadAppState();
      if (success) {
        // Recheck status after reload
        const status = await checkCorpusStatus();
        setCorpusStatus(status);
        setShowDownloadModal(false);
        setShowUpdateBanner(false);
        // Update mode to offline
        setMode('offline');
        // Refresh corpus status in context
        await refreshCorpusStatus();
        // Reload stats with new data
        loadStats();
      }
    } catch (err) {
      console.error('Failed to reload app state:', err);
    }
  }, [setMode, refreshCorpusStatus]);

  // Handle online use selection from download modal
  const handleOnlineUse = useCallback(async (skipPromptNextTime: boolean) => {
    // Save preference if user chose to skip prompt next time
    if (skipPromptNextTime) {
      await saveOnlineModePreference(true);
    }
    // Switch to online mode
    setMode('online');
    setShowDownloadModal(false);
  }, [setMode]);

  // Handle download corpus from toolbar (when in online mode) - desktop only
  const handleDownloadCorpus = useCallback(async () => {
    // Skip for web target
    if (isWebTarget()) return;

    // Fetch corpus status before showing modal
    try {
      const { checkCorpusStatus } = await import('./api/tauri');
      const status = await checkCorpusStatus();
      setCorpusStatus(status);
    } catch (err) {
      // If status check fails, create a minimal status object
      setCorpusStatus({
        ready: false,
        local_version: null,
        remote_version: null,
        update_available: false,
        update_required: false,
        missing_files: [],
        total_download_size: 0,
        error: `Failed to check status: ${err}`,
      });
    }
    setShowDownloadModal(true);
  }, []);

  // Handle update click from banner
  const handleUpdateClick = useCallback(() => {
    setShowDownloadModal(true);
    setShowUpdateBanner(false);
  }, []);

  // Handle loading a search from history or saved searches
  const handleLoadSearch = useCallback(async (search: SearchHistoryEntry | SavedSearchEntry) => {
    try {
      // Parse query data
      const queryData = JSON.parse(search.query_data);

      // Restore book filter if present
      if (search.book_ids) {
        const bookIds = JSON.parse(search.book_ids) as number[];
        setSelectedBookIds(new Set(bookIds));
      } else {
        setSelectedBookIds(new Set());
      }

      // Execute the appropriate search based on type
      if (search.search_type === 'boolean' && queryData.type === 'boolean') {
        const combined: CombinedSearchQuery = {
          andInputs: queryData.andInputs || [],
          orInputs: queryData.orInputs || [],
        };
        setAppSearchMode('terms');
        handleSearch(combined);
      } else if (search.search_type === 'proximity' && queryData.type === 'proximity') {
        const query: ProximitySearchQuery = {
          term1: queryData.term1,
          field1: queryData.field1,
          term2: queryData.term2,
          field2: queryData.field2,
          distance: queryData.distance,
        };
        setAppSearchMode('terms');
        handleProximitySearch(query);
      } else if (search.search_type === 'name' && queryData.type === 'name') {
        if (queryData.forms && Array.isArray(queryData.forms)) {
          setNameFormData(queryData.forms);
          setAppSearchMode('names');
          // Wait a tick for state to update, then search
          setTimeout(() => {
            handleNameSearch();
          }, 0);
        }
      }
    } catch (err) {
      console.error('Failed to load search:', err);
    }
  }, [handleSearch, handleProximitySearch, handleNameSearch]);

  // Show loading screen while checking mode or corpus status
  if (modeLoading || (mode !== 'online' && checkingCorpus)) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-app-bg">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-app-accent mx-auto mb-4"></div>
          <p className="text-app-text-secondary">
            {modeLoading ? 'Loading...' : 'Checking corpus data...'}
          </p>
        </div>
      </div>
    );
  }

  // Show download modal if needed (desktop only)
  if (showDownloadModal && corpusStatus && !isWebTarget()) {
    return (
      <Suspense fallback={<div className="h-screen w-screen flex items-center justify-center bg-app-bg">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-app-accent"></div>
      </div>}>
        <DownloadModal
          status={corpusStatus}
          onDownloadComplete={handleDownloadComplete}
          onOnlineUse={handleOnlineUse}
          showOnlineOption={mode === 'pending' && !corpusDownloaded}
          onDismiss={corpusStatus.update_available && !corpusStatus.update_required ? () => {
            setShowDownloadModal(false);
            setShowUpdateBanner(true);
          } : undefined}
        />
      </Suspense>
    );
  }

  // Main app content wrapped in BooksProvider
  return (
    <BooksProvider api={api}>
      <div className="h-screen w-screen flex flex-col bg-app-bg overflow-hidden">
        {/* Update Banner - desktop only */}
        {!isWebTarget() && showUpdateBanner && corpusStatus?.update_available && (
          <UpdateBanner
            remoteVersion={corpusStatus.remote_version}
            onUpdate={handleUpdateClick}
            onDismiss={() => setShowUpdateBanner(false)}
          />
        )}

        {/* Top Menu Bar */}
        <Toolbar
          onBrowseTexts={() => setTextBrowserOpen(true)}
          onSearchHistory={() => setSearchHistoryModalOpen(true)}
          onSavedSearches={() => setSavedSearchesModalOpen(true)}
          onHelp={() => setHelpOpen(!helpOpen)}
          helpActive={helpOpen}
          isOnlineMode={mode === 'online'}
          onDownloadCorpus={isWebTarget() ? undefined : handleDownloadCorpus}
          isWebTarget={isWebTarget()}
        />

        <div className="flex-1 flex overflow-hidden">
        <Sidebar
          isOpen={sidebarOpen}
          onToggle={() => setSidebarOpen(!sidebarOpen)}
          onSearch={handleSearch}
          onProximitySearch={handleProximitySearch}
          onNameSearch={handleNameSearch}
          onOpenTextSelection={() => setTextSelectionModalOpen(true)}
          loading={activeTab?.loading ?? false}
          indexedPages={stats?.indexed_pages ?? 0}
          selectedTextsCount={selectedBookIds.size}
          appSearchMode={appSearchMode}
          onAppSearchModeChange={setAppSearchMode}
          nameFormData={nameFormData}
          onNameFormDataChange={setNameFormData}
          generatedPatterns={generatedPatterns}
          // Concordance props
          concordanceQuery={concordanceQuery}
          onConcordanceQueryChange={setConcordanceQuery}
          concordanceMode={concordanceMode}
          onConcordanceModeChange={setConcordanceMode}
          concordanceIgnoreClitics={concordanceIgnoreClitics}
          onConcordanceIgnoreCliticsChange={setConcordanceIgnoreClitics}
          onConcordanceSearch={handleConcordanceSearch}
          onConcordanceExport={handleConcordanceExport}
          concordanceLoading={activeTab?.loading ?? false}
          concordanceHasResults={isConcordanceTab && activeTab?.searchResults !== null && (activeTab?.searchResults?.results.length ?? 0) > 0}
          concordanceTotalHits={isConcordanceTab ? (activeTab?.searchResults?.total_hits ?? 0) : 0}
        />

        <div className="flex-1 flex flex-col overflow-hidden p-4">
          {helpOpen ? (
            /* Help Panel - replaces normal content when active */
            <div className="flex-1 overflow-hidden rounded-xl shadow-app-md">
              <HelpPanel onClose={() => setHelpOpen(false)} />
            </div>
          ) : (
            /* Normal Search Interface */
            <>
              {/* Tab Bar */}
              <SearchTabs
                tabs={tabData}
                activeTabId={activeTabId}
                onTabClick={setActiveTabId}
                onTabClose={closeTab}
              />

              <div style={{ flex: splitterRatio }} className="overflow-hidden shadow-app-md bg-white mb-3 rounded-b-xl">
                <ReaderPanel
                  currentPage={activeTab?.currentPage ?? null}
                  tokens={activeTab?.pageTokens ?? []}
                  onNavigate={handleNavigatePage}
                  matchedTokenIndices={activeTab?.matchedTokenIndices ?? []}
                />
              </div>

              <DraggableSplitter ratio={splitterRatio} onDrag={setSplitterRatio} />

              <div style={{ flex: 1 - splitterRatio }} className="overflow-hidden rounded-xl shadow-app-md">
                {isConcordanceTab ? (
                  <ConcordancePanel
                    results={activeTab?.searchResults ?? null}
                    onResultClick={handleResultClick}
                    onLoadMore={handleLoadMore}
                    loading={activeTab?.loading ?? false}
                    loadingMore={activeTab?.loadingMore ?? false}
                    errorMessage={activeTab?.errorMessage ?? ''}
                    maxResults={CONCORDANCE_MAX_RESULTS}
                  />
                ) : (
                  <ResultsPanel
                    results={activeTab?.searchResults ?? null}
                    onResultClick={handleResultClick}
                    onLoadMore={handleLoadMore}
                    onExport={handleExportResults}
                    loading={activeTab?.loading ?? false}
                    loadingMore={activeTab?.loadingMore ?? false}
                    errorMessage={activeTab?.errorMessage ?? ''}
                    maxResults={MAX_RESULTS}
                  />
                )}
              </div>
            </>
          )}
        </div>
        </div>

        {textSelectionModalOpen && (
          <TextSelectionModal
            onClose={() => setTextSelectionModalOpen(false)}
            selectedBookIds={selectedBookIds}
            onSelectionChange={setSelectedBookIds}
          />
        )}

        {textBrowserOpen && (
          <MetadataBrowser onClose={() => setTextBrowserOpen(false)} />
        )}

        <SearchHistoryModal
          isOpen={searchHistoryModalOpen}
          onClose={() => setSearchHistoryModalOpen(false)}
          onLoadSearch={handleLoadSearch}
        />

        <SavedSearchesModal
          isOpen={savedSearchesModalOpen}
          onClose={() => setSavedSearchesModalOpen(false)}
          onLoadSearch={handleLoadSearch}
        />
      </div>
    </BooksProvider>
  );
}

export default App;
