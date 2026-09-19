import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import type { SearchHistoryEntry, SavedSearchEntry, CorpusStatus, Announcement, PageEntry } from './types';
import type { CombinedSearchQuery, ProximitySearchQuery } from './types/search';
import type { Collection } from './types/collections';
import { MAX_RESULTS } from './constants/search';
import { useSearchTabsContext } from './contexts/SearchTabsContext';
import { useOperatingMode, saveOnlineModePreference } from './contexts/OperatingModeContext';
import { BooksProvider } from './contexts/BooksContext';
import { useSearch } from './hooks/useSearch';
import { useReaderNavigation } from './hooks/useReaderNavigation';
import { usePageHighlights } from './hooks/usePageHighlights';
import { useSidebarForSearch } from './hooks/useSidebarForSearch';
import { useSearchForm } from './contexts/SearchFormContext';
import { Sidebar } from './components/Sidebar';
import { ReaderPanel, ResultsPanel, HelpPanel } from './components/panels';
import { DraggableSplitter, UpdateBanner } from './components/ui';
import {
  TextSelectionModal,
  MetadataBrowser,
  SavedSearchesModal,
  SearchHistoryModal,
  AnnouncementsModal,
  CollectionsModal,
  SaveCollectionModal,
  type TextSelectionMode,
} from './components/modals';
import { Toolbar } from './components/Toolbar';
import { SearchTabs, type TabData } from './components/SearchTabs';
import { isWebTarget } from './utils/platform';
import { getEligibleAnnouncements } from './utils/announcements';
import { markMultipleAnnouncementsDismissed, setSkipAnnouncementPopups } from './utils/storage';
import {
  getCollections,
  createCollection,
  updateCollectionBooks,
} from './utils/collections';

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

  // Announcements state
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [showAnnouncementsModal, setShowAnnouncementsModal] = useState(false);
  const [announcementsChecked, setAnnouncementsChecked] = useState(false);

  // Open by default; every search folds it so the results and the reader
  // take the width. The toggle or Ctrl/Cmd+B opens it again.
  const sidebar = useSidebarForSearch();
  const sidebarOpen = sidebar.open;

  // Tab-based state from context
  const {
    tabs,
    activeTabId,
    activeTab,
    setActiveTabId,
    closeTab,
    updateTab,
  } = useSearchTabsContext();

  // The reader tells us where it has scrolled to; reading it from a ref keeps
  // that callback stable, so the reader is not re-wired on every tab update.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // The search form's state — terms/names, the name forms, the patterns —
  // lives in the store (SearchFormContext), so it survives the sidebar
  // folding away for a search.
  const { appSearchMode, setAppSearchMode, nameFormData, setNameFormData, generatedPatterns, setGeneratedPatterns } = useSearchForm();

  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());

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

  // Collections state
  const [collectionsModalOpen, setCollectionsModalOpen] = useState(false);
  const [saveCollectionModalOpen, setSaveCollectionModalOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [textSelectionMode, setTextSelectionMode] = useState<TextSelectionMode>('select');
  const [editingCollection, setEditingCollection] = useState<Collection | undefined>(undefined);

  // Reader navigation hook
  const { handleNavigateToLabel, loadResultIntoTab } = useReaderNavigation({ api });

  // Where the reader should be. Only the coordinates: the reader loads the
  // pages around them itself.
  const readerAnchor = useMemo(
    () =>
      activeTab?.currentBookId != null
        ? { part_index: activeTab.currentPartIndex, page_id: activeTab.currentPageId }
        : null,
    [activeTab?.currentBookId, activeTab?.currentPartIndex, activeTab?.currentPageId]
  );

  // Highlights for whatever page scrolls into view, for the search this tab
  // is running: reading on from a hit marks the hits on the pages after it.
  const highlights = usePageHighlights({
    api,
    bookId: activeTab?.currentBookId ?? null,
    searchContext: activeTab?.searchContext ?? null,
  });

  // The reader scrolled onto another page: remember it, so the tab comes back
  // where it was left and the citation follows the page in view.
  const handleActivePage = useCallback(
    (entry: PageEntry) => {
      const tab = activeTabRef.current;
      if (!tab || tab.currentBookId === null) return;
      if (tab.currentPartIndex === entry.part_index && tab.currentPageId === entry.page_id) return;
      updateTab(tab.id, {
        currentPartIndex: entry.part_index,
        currentPageId: entry.page_id,
        currentPage: { bookId: tab.currentBookId, meta: `${entry.part_label}:${entry.page_number}` },
      });
    },
    [updateTab]
  );

  // Use search hook with selected book IDs and loadResultIntoTab
  const {
    handleSearch,
    handleProximitySearch,
    handleNameSearch: handleNameSearchFromHook,
    handleLoadMore,
    handleExportResults,
    handleResultClick,
  } = useSearch({ selectedBookIds, loadResultIntoTab, api });

  // Variants: only available for single-input lemma/root searches. Returns
  // undefined when the active search doesn't qualify, which hides the button.
  const variantsContext = useMemo(() => {
    const ctx = activeTab?.searchContext;
    if (!ctx || ctx.type !== 'combined' || !ctx.combinedQuery) return null;
    const { andInputs = [], orInputs = [] } = ctx.combinedQuery;
    if (orInputs.length > 0) return null;
    if (andInputs.length !== 1) return null;
    const input = andInputs[0];
    if (input.mode !== 'lemma' && input.mode !== 'root') return null;
    if (!input.query.trim()) return null;
    return { query: input.query, mode: input.mode };
  }, [activeTab?.searchContext]);

  const handleLoadVariants = useCallback(async () => {
    if (!variantsContext) {
      throw new Error('Variants are only available for single lemma or root searches.');
    }
    const filters = selectedBookIds.size > 0 ? { book_ids: Array.from(selectedBookIds) } : {};
    return api.getVariants(variantsContext.query, variantsContext.mode, filters);
  }, [api, variantsContext, selectedBookIds]);

  const handleVariantClick = useCallback(
    (tuple: string[]) => {
      // Re-run as a single-input surface phrase search. Joining with spaces
      // turns the tuple into a phrase the way the existing search builder
      // expects (multi-word query in one input → PhraseQuery).
      const combined: CombinedSearchQuery = {
        andInputs: [
          {
            id: Date.now(),
            query: tuple.join(' '),
            mode: 'surface',
            cliticToggle: false,
          },
        ],
        orInputs: [],
      };
      setAppSearchMode('terms');
      handleSearch(combined);
    },
    [handleSearch]
  );

  // Wrap name search to update generated patterns
  const handleNameSearch = useCallback(async () => {
    const { displayPatterns } = await handleNameSearchFromHook(nameFormData);
    setGeneratedPatterns(displayPatterns);
  }, [handleNameSearchFromHook, nameFormData]);

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
            remote_notes: null,
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

  // Check and show announcements after download phase completes
  const checkAndShowAnnouncements = useCallback(async () => {
    if (announcementsChecked) return;

    try {
      // Get app version - use a default for web or if not available
      let appVersion = '1.0.0';
      if (!isWebTarget()) {
        try {
          const { getVersion } = await import('@tauri-apps/api/app');
          appVersion = await getVersion();
        } catch {
          // Fallback if version API not available
        }
      }

      const eligible = await getEligibleAnnouncements(appVersion);
      setAnnouncementsChecked(true);

      if (eligible.length > 0) {
        setAnnouncements(eligible);
        setShowAnnouncementsModal(true);
      }
    } catch (err) {
      console.error('Failed to check announcements:', err);
      setAnnouncementsChecked(true);
    }
  }, [announcementsChecked]);

  // Handle announcements modal dismiss
  const handleAnnouncementsDismiss = useCallback(async (skipFuturePopups: boolean, dismissedIds: string[]) => {
    try {
      // Save skip preference
      if (skipFuturePopups) {
        await setSkipAnnouncementPopups(true);
      }

      // Mark announcements as dismissed
      if (dismissedIds.length > 0) {
        await markMultipleAnnouncementsDismissed(dismissedIds);
      }
    } catch (err) {
      console.error('Failed to save announcement preferences:', err);
    }

    setShowAnnouncementsModal(false);
    setAnnouncements([]);
  }, []);

  // Check for announcements when download modal is not needed
  // This covers: web target, corpus already ready, or online mode already selected
  useEffect(() => {
    // Skip if still loading or checking
    if (modeLoading || checkingCorpus) return;
    // Skip if download modal is showing (announcements checked after modal closes)
    if (showDownloadModal) return;
    // Skip if already checked
    if (announcementsChecked) return;

    // For web target: always check announcements (no download modal)
    if (isWebTarget()) {
      checkAndShowAnnouncements();
      return;
    }

    // For desktop: check if we're in a ready state without download modal
    if (mode === 'online' || (mode === 'offline' && corpusStatus?.ready)) {
      checkAndShowAnnouncements();
    }
  }, [modeLoading, checkingCorpus, showDownloadModal, announcementsChecked, mode, corpusStatus?.ready, checkAndShowAnnouncements]);

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
        // Check for announcements after download completes
        checkAndShowAnnouncements();
      }
    } catch (err) {
      console.error('Failed to reload app state:', err);
    }
  }, [setMode, refreshCorpusStatus, checkAndShowAnnouncements]);

  // Handle online use selection from download modal
  const handleOnlineUse = useCallback(async (skipPromptNextTime: boolean) => {
    // Save preference if user chose to skip prompt next time
    if (skipPromptNextTime) {
      await saveOnlineModePreference(true);
    }
    // Switch to online mode
    setMode('online');
    setShowDownloadModal(false);
    // Check for announcements after choosing online mode
    checkAndShowAnnouncements();
  }, [setMode, checkAndShowAnnouncements]);

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
        remote_notes: null,
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

  const loadCollections = useCallback(async () => {
    try {
      const loaded = await getCollections();
      setCollections(loaded);
    } catch (err) {
      console.error('Failed to load collections:', err);
    }
  }, []);

  // Load collections on mount
  useEffect(() => {
    loadCollections();
  }, [loadCollections]);

  // Handle opening save collection modal
  const handleOpenSaveCollectionModal = useCallback(() => {
    setSaveCollectionModalOpen(true);
  }, []);

  // Handle saving a new collection
  const handleSaveCollection = useCallback(async (name: string, description: string | null) => {
    await createCollection(name, Array.from(selectedBookIds), description ?? undefined);
    await loadCollections();
  }, [selectedBookIds, loadCollections]);

  // Handle opening collections modal
  const handleOpenCollectionsModal = useCallback(() => {
    setCollectionsModalOpen(true);
  }, []);

  // Handle editing a collection (opens TextSelectionModal in edit mode)
  const handleEditCollection = useCallback((collection: Collection) => {
    setEditingCollection(collection);
    setSelectedBookIds(new Set(collection.book_ids));
    setTextSelectionMode('edit-collection');
    setTextSelectionModalOpen(true);
  }, []);

  // Handle creating a new collection from CollectionsModal
  const handleCreateCollectionFromModal = useCallback(() => {
    setTextSelectionMode('create-collection');
    setSelectedBookIds(new Set());
    setTextSelectionModalOpen(true);
  }, []);

  // Handle updating collection books
  const handleUpdateCollectionBooks = useCallback(async (id: number, bookIds: number[]) => {
    await updateCollectionBooks(id, bookIds);
    await loadCollections();
  }, [loadCollections]);

  // Handle closing TextSelectionModal - reset mode
  const handleCloseTextSelectionModal = useCallback(() => {
    setTextSelectionModalOpen(false);
    setTextSelectionMode('select');
    setEditingCollection(undefined);
  }, []);

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
          onDismiss={
            corpusStatus.update_available && !corpusStatus.update_required
              ? () => {
                  setShowDownloadModal(false);
                  setShowUpdateBanner(true);
                }
              : mode === 'online'
                ? () => setShowDownloadModal(false)
                : undefined
          }
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
          onCollections={handleOpenCollectionsModal}
          onHelp={() => setHelpOpen(!helpOpen)}
          helpActive={helpOpen}
          isOnlineMode={mode === 'online'}
          onDownloadCorpus={isWebTarget() ? undefined : handleDownloadCorpus}
          isWebTarget={isWebTarget()}
        />

        <div className="flex-1 flex overflow-hidden">
        <Sidebar
          isOpen={sidebarOpen}
          onToggle={sidebar.toggle}
          onSearch={(q) => {
            sidebar.collapseForSearch();
            return handleSearch(q);
          }}
          onProximitySearch={(q) => {
            sidebar.collapseForSearch();
            return handleProximitySearch(q);
          }}
          onNameSearch={() => {
            sidebar.collapseForSearch();
            void handleNameSearch();
          }}
          onOpenTextSelection={() => {
            setTextSelectionMode('select');
            setTextSelectionModalOpen(true);
          }}
          onSaveCollection={selectedBookIds.size > 0 ? handleOpenSaveCollectionModal : undefined}
          loading={activeTab?.loading ?? false}
          indexedPages={stats?.indexed_pages ?? 0}
          selectedTextsCount={selectedBookIds.size}
          appSearchMode={appSearchMode}
          onAppSearchModeChange={setAppSearchMode}
          nameFormData={nameFormData}
          onNameFormDataChange={setNameFormData}
          generatedPatterns={generatedPatterns}
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
                  api={api}
                  bookId={activeTab?.currentBookId ?? null}
                  anchor={readerAnchor}
                  clickedMatches={activeTab?.clickedMatches ?? null}
                  matchesFor={highlights.matchesFor}
                  onMountedPages={highlights.onMountedPages}
                  onActivePage={handleActivePage}
                  onNavigateToLabel={handleNavigateToLabel}
                />
              </div>

              <DraggableSplitter ratio={splitterRatio} onDrag={setSplitterRatio} />

              <div style={{ flex: 1 - splitterRatio }} className="overflow-hidden rounded-xl shadow-app-md">
                <ResultsPanel
                  results={activeTab?.searchResults ?? null}
                  onResultClick={handleResultClick}
                  onLoadMore={handleLoadMore}
                  onExport={handleExportResults}
                  loading={activeTab?.loading ?? false}
                  loadingMore={activeTab?.loadingMore ?? false}
                  errorMessage={activeTab?.errorMessage ?? ''}
                  maxResults={MAX_RESULTS}
                  onLoadVariants={variantsContext ? handleLoadVariants : undefined}
                  onVariantClick={variantsContext ? handleVariantClick : undefined}
                />
              </div>
            </>
          )}
        </div>
        </div>

        {textSelectionModalOpen && (
          <TextSelectionModal
            onClose={handleCloseTextSelectionModal}
            selectedBookIds={selectedBookIds}
            onSelectionChange={setSelectedBookIds}
            mode={textSelectionMode}
            editingCollection={editingCollection}
            collections={collections}
            onSaveCollection={handleOpenSaveCollectionModal}
            onUpdateCollection={handleUpdateCollectionBooks}
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

        {showAnnouncementsModal && announcements.length > 0 && (
          <AnnouncementsModal
            announcements={announcements}
            onDismiss={handleAnnouncementsDismiss}
          />
        )}

        {/* Collections Modal */}
        <CollectionsModal
          isOpen={collectionsModalOpen}
          onClose={() => setCollectionsModalOpen(false)}
          onEditCollection={handleEditCollection}
          onCreateCollection={handleCreateCollectionFromModal}
        />

        {/* Save Collection Modal */}
        <SaveCollectionModal
          isOpen={saveCollectionModalOpen}
          onClose={() => setSaveCollectionModalOpen(false)}
          onSave={handleSaveCollection}
          existingNames={collections.map(c => c.name)}
        />
      </div>
    </BooksProvider>
  );
}

export default App;
