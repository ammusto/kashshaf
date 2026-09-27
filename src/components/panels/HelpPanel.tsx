import { useState } from 'react';

type HelpTab = 'overview' | 'term-search' | 'name-search' | 'search-modes' | 'wildcards' | 'features';

interface TabButtonProps {
  id: HelpTab;
  label: string;
  active: boolean;
  onClick: (id: HelpTab) => void;
}

function TabButton({ id, label, active, onClick }: TabButtonProps) {
  return (
    <button
      onClick={() => onClick(id)}
      className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors
        ${active
          ? 'bg-white text-app-accent border-t border-l border-r border-app-border-light'
          : 'bg-app-surface-variant text-app-text-secondary hover:bg-app-accent-light'
        }`}
    >
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold text-app-accent mb-2">{title}</h3>
      {children}
    </div>
  );
}

function OverviewTab() {
  return (
    <div className="space-y-4">
      <Section title="al-Kashshāf Overview">
        <p className="text-app-text-secondary leading-relaxed">
          al-Kashshāf is a research environment for exploring Arabic texts. It provides powerful
          search capabilities across a large corpus of classical Arabic literature, with morphological
          analysis and flexible query options.
        </p>
      </Section>

      <Section title="Getting Started">
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li>Use the <strong>sidebar</strong> on the left to enter search queries</li>
          <li>Switch between <strong>Terms</strong> and <strong>Names</strong> modes using the tabs</li>
          <li>Results appear in the bottom panel; click any result to view the full page above</li>
          <li>The sidebar folds away when you search; <strong>Ctrl+B</strong> brings it back with your query intact (Settings can turn the folding off)</li>
          <li><strong>Browse Texts</strong> in the top bar opens the corpus metadata</li>
          <li><strong>Select Texts</strong> in the top bar limits every search to chosen texts; "Searching:" beside it shows how many</li>
          <li><strong>Bug?</strong> reports a problem, <strong>About</strong> shows the version and corpus</li>
        </ul>
      </Section>

      <Section title="Search Tabs">
        <p className="text-app-text-secondary leading-relaxed">
          Each search creates a new tab, allowing you to compare results from different queries.
          Click a tab to switch between searches, or close tabs you no longer need.
        </p>
      </Section>
    </div>
  );
}

function TermSearchTab() {
  return (
    <div className="space-y-4">
      <Section title="Term Search">
        <p className="text-app-text-secondary leading-relaxed">
          Term search finds pages containing your terms. Each term has its own mode (surface, lemma, or root)
          and its own "Ignore clitics" switch, and terms can be combined with AND and OR.
        </p>
      </Section>

      <Section title="Phrases">
        <p className="text-app-text-secondary leading-relaxed">
          Several words in one box are a phrase: the words must be adjacent, in that order. Phrases work in
          every mode, so the lemma phrase "ولي الله" also matches "أولياء الله". A phrase split by a page turn
          is still found and is highlighted on both pages.
        </p>
      </Section>

      <Section title="Boolean Search (AND/OR)">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          The <strong>AND</strong> and <strong>OR</strong> tabs hold two lists of terms, up to three each:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li><strong>AND terms:</strong> All AND terms must appear on the same page</li>
          <li><strong>OR terms:</strong> At least one OR term must match (in addition to all AND terms)</li>
          <li><strong>+ Add search term</strong> adds a row to the current tab; <strong>Reset Search</strong> clears the form</li>
        </ul>
        <div className="mt-3 p-3 bg-app-surface-variant rounded-lg">
          <p className="text-sm font-medium text-app-text-primary mb-2">Example:</p>
          <p className="text-lg text-app-text-secondary mb-1">
            AND: <code className="bg-white px-1 rounded">الفقه</code>, <code className="bg-white px-1 rounded">الشافعي</code>
          </p>
          <p className="text-lg text-app-text-secondary mb-2">
            OR: <code className="bg-white px-1 rounded">المذهب</code>, <code className="bg-white px-1 rounded">الاجتهاد</code>
          </p>
          <p className="text-lg text-app-text-tertiary italic">
            Logic: (الفقه AND الشافعي) AND (المذهب OR الاجتهاد)
          </p>
          <p className="text-lg text-app-text-tertiary mt-1">
            Matches pages containing both "الفقه" and "الشافعي", plus at least one of "المذهب" or "الاجتهاد".
          </p>
        </div>
      </Section>

      <Section title="Proximity Search">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Find two or three terms that appear near each other, each within a distance of the next:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li>Enter two terms and the maximum token distance between them (1 to 100); <strong>+ Add Proximity Term</strong> chains a third, with its own distance</li>
          <li>Distance is measured in tokens (words), not characters</li>
          <li><strong>Ordered</strong> requires the terms in the order written; otherwise any order counts</li>
          <li><strong>+ Add AND Term</strong> names a term (up to two, under "Also on the page") the page must also contain, anywhere; the reader shows it in a second colour</li>
          <li>Each term can use a different search mode (surface, lemma, root)</li>
          <li>A chain split across a page break is found, and attributed to the page holding more of it</li>
        </ul>
      </Section>

      <Section title="Ignore Clitics">
        <p className="text-app-text-secondary leading-relaxed">
          When enabled, the search will also match words with common Arabic proclitics
          (و، ف، ب، ل، ك) attached. For example, searching for "الكتاب" will also find "والكتاب" and "بالكتاب".
        </p>
      </Section>
    </div>
  );
}

function NameSearchTab() {
  return (
    <div className="space-y-4">
      <Section title="Name Search">
        <p className="text-app-text-secondary leading-relaxed">
          Name search is designed specifically for finding Arabic personal names in their various
          traditional forms. It generates multiple pattern variants to match how names appear in classical texts.
        </p>
      </Section>

      <Section title="Name Components">
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li><strong>Kunya / laqab (كنية/لقب):</strong> "أبو منصور", "شمس الدين"; <strong>+ Add Laqab</strong> for more than one</li>
          <li><strong>Nasab (نسب):</strong> Lineage chain like "معمر بن أحمد بن زياد"</li>
          <li><strong>Nisba (نسبة):</strong> Attributive names like "الأصبهاني" or "الصوفي"; <strong>+ Add Nisba</strong> for more than one</li>
          <li><strong>Shuhra (شهرة):</strong> The name a person is known by, via <strong>+ Add Shuhra</strong></li>
        </ul>
      </Section>

      <Section title="How It Works">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          The name search automatically generates variants including:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li>Different grammatical cases for kunya (أبو/أبا/أبي)</li>
          <li>Nasab with and without "ابن" connectors, in one- and two-part lengths</li>
          <li>Combinations of kunya, nasab and nisba, chosen with the "Include" switches (kunya + nisba, kunya + 1st nasab, 1-part nasab, 1-part nasab + nisba, 2-part nasab)</li>
          <li>Proclitic variants (و، ف، etc.) on the first word</li>
        </ul>
        <p className="text-app-text-secondary leading-relaxed mt-2">
          The generated patterns are shown below the form so you can see exactly what will be searched. One name
          is searched at a time; the results panel can list the variants found and re-run any one of them.
        </p>
      </Section>
    </div>
  );
}

function SearchModesTab() {
  return (
    <div className="space-y-4">
      <Section title="Search Modes">
        <p className="text-app-text-secondary leading-relaxed">
          Kashshaf offers three search modes that determine how your query is matched against the text.
          Understanding these modes is key to effective searching.
        </p>
      </Section>

      <Section title="Surface Form">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Matches the exact surface form of words as they appear in the text (without diacritics).
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-1">
          <li>Most precise matching</li>
          <li>Diacritics (tashkil) are normalized away</li>
          <li>Supports wildcards (*)</li>
          <li>Best for finding specific word forms</li>
        </ul>
      </Section>

      <Section title="Lemma">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Matches the dictionary form (lemma) of words, finding all inflected forms.
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-1">
          <li>Searching "كتب" (kataba) finds "يكتب", "كتاب", "مكتوب", etc.</li>
          <li>Morphologically aware - understands Arabic word patterns</li>
          <li>Does NOT support wildcards</li>
          <li>Best for conceptual searches where form doesn't matter</li>
        </ul>
      </Section>

      <Section title="Root">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Matches the triliteral (or quadriliteral) root of words.
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-1">
          <li>Broadest matching - finds all words from the same root</li>
          <li>Searching root "ك.ت.ب" finds "كتاب", "مكتبة", "كاتب", "استكتب", etc.</li>
          <li>Does NOT support wildcards</li>
          <li>Best for exploring semantic fields</li>
        </ul>
      </Section>
    </div>
  );
}

function WildcardsTab() {
  return (
    <div className="space-y-4">
      <Section title="Wildcard Search">
        <p className="text-app-text-secondary leading-relaxed">
          Wildcards allow you to search for words matching a pattern. Use the asterisk (*) to match
          any sequence of letters, anywhere in the word and as often as you need.
        </p>
      </Section>

      <Section title="Wildcard Rules">
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li><strong>Surface mode only:</strong> Wildcards only work in Surface search mode</li>
          <li><strong>At least 2 letters:</strong> Every word with a * must contain at least two ordinary letters (ا* is too short, اب* is fine)</li>
          <li><strong>Any position, any number:</strong> The * may start, end or sit inside a word, and a word may contain several (مع*رف*)</li>
          <li><strong>Phrases:</strong> Any word of a phrase may carry wildcards; each word is expanded on its own</li>
        </ul>
      </Section>

      <Section title="Wildcard Types">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-app-text-primary">Prefix (word beginning)</p>
            <p className="text-app-text-secondary">
              <code className="bg-app-surface-variant px-1 rounded">كتا*</code> matches "كتاب", "كتابة", "كتابه", etc.
            </p>
          </div>
          <div>
            <p className="font-medium text-app-text-primary">Suffix (word ending)</p>
            <p className="text-app-text-secondary">
              <code className="bg-app-surface-variant px-1 rounded">*ية</code> matches "عربية", "إسلامية", "الشافعية", etc.
            </p>
          </div>
          <div>
            <p className="font-medium text-app-text-primary">Internal</p>
            <p className="text-app-text-secondary">
              <code className="bg-app-surface-variant px-1 rounded">أح*مد</code> matches "أحمد", "أحامد", etc.
            </p>
          </div>
          <div>
            <p className="font-medium text-app-text-primary">Contains</p>
            <p className="text-app-text-secondary">
              <code className="bg-app-surface-variant px-1 rounded">*قول*</code> matches "قول", "يقول", "مقولة", "الأقوال", etc.
            </p>
          </div>
          <div>
            <p className="font-medium text-app-text-primary">Several stars</p>
            <p className="text-app-text-secondary">
              <code className="bg-app-surface-variant px-1 rounded">مع*رف*</code> matches "معرف", "معارف", "معرفة", "معترفون", etc.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Counts and Performance">
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li><strong>Single words</strong> always return an exact count, however broad the pattern (ال* alone matches most of the corpus and takes under a second)</li>
          <li><strong>Phrases</strong> with a very broad wildcard word (e.g. "ابن ال*") are verified page by page in reading order. The search stops after 20,000 verified pages and shows the count with a "+" (a lower bound); scrolling continues through the verified pages without re-running the search</li>
          <li><strong>Exact counts:</strong> In offline mode, Menu → Settings → "Exact counts" makes these searches run to the end and report exact totals, at the cost of a few extra seconds on very common words</li>
          <li><strong>Faster patterns:</strong> A longer literal beginning (استكت*) is quicker to expand than a very short one; patterns starting with * scan the whole vocabulary but still finish in well under a second</li>
        </ul>
      </Section>
    </div>
  );
}

function FeaturesTab() {
  return (
    <div className="space-y-4">
      <Section title="Metadata Browser">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Access via <strong>Browse Texts</strong> in the toolbar. The metadata browser lets you:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-1">
          <li>View all texts in the corpus with their metadata</li>
          <li>Filter by author, death date, genre, and title</li>
          <li>Sort by any column</li>
          <li>Copy a citation in Chicago or MLA style</li>
          <li>Export filtered or complete metadata to CSV or Excel</li>
          <li>See token and page counts for each text</li>
        </ul>
      </Section>

      <Section title="Text Selection">
        <p className="text-app-text-secondary leading-relaxed">
          Click <strong>Select Texts</strong> in the top bar to limit your searches to specific texts,
          authors, time periods, or genres. "Searching:" beside it shows how many texts are selected.
          The selection persists across searches until you clear it; Cancel restores what you had.
        </p>
      </Section>

      <Section title="Collections">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Collections let you save named groups of texts (mini-corpora) that persist across sessions:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li><strong>Create a collection:</strong> Select texts, then click the save icon in the sidebar or "Save Collection" button in the text selection modal</li>
          <li><strong>Name and description:</strong> Give your collection a name (required) and optional description (up to 150 characters)</li>
          <li><strong>Manage collections:</strong> Click <strong>Collections</strong> in the toolbar to view, edit, or delete your saved collections</li>
          <li><strong>Edit texts:</strong> Click "Edit Texts" on any collection to add or remove texts from it</li>
          <li><strong>Filter by collection:</strong> In the text selection modal, use the Collection filter to quickly select texts from one or more saved collections</li>
        </ul>
        <div className="mt-3 p-3 bg-app-surface-variant rounded-lg">
          <p className="text-sm font-medium text-app-text-primary mb-1">Tip:</p>
          <p className="text-sm text-app-text-secondary">
            Use collections to organize research projects - for example, create collections for "Sufi texts",
            "4th century authors", or "Hadith commentaries" to quickly switch between different research contexts.
          </p>
        </div>
      </Section>

      <Section title="Exporting Search Results">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Export your search results for external analysis:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-1">
          <li>Click the export button in the results panel header</li>
          <li>Up to 2,000 rows, as CSV or Excel, with metadata, volume and page, and the matched text</li>
        </ul>
      </Section>

      <Section title="History and Saved Searches">
        <ul className="list-disc list-inside text-app-text-secondary space-y-1">
          <li><strong>History</strong> in the top bar lists past searches with their text selection; click one to run it again</li>
          <li><strong>Saved</strong> keeps the searches you have marked</li>
          <li>Delete entries you no longer need</li>
        </ul>
      </Section>

      <Section title="Settings">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Menu → Settings:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-1">
          <li><strong>Auto-collapse search sidebar on search</strong> and <strong>Auto-show table of contents</strong>, both on by default</li>
          <li><strong>Exact counts</strong> (local data only): searches that would stop at 20,000 verified hits run to the end</li>
          <li>Where the corpus lives on disk</li>
        </ul>
      </Section>

      <Section title="Reporting a Problem">
        <p className="text-app-text-secondary leading-relaxed">
          <strong>Bug?</strong> in the top bar opens a GitHub issue with the details prefilled, or shows the
          address to write to and a details block to copy. The application sends nothing unless you use it.
        </p>
      </Section>

      <Section title="Token Information">
        <p className="text-app-text-secondary leading-relaxed">
          Click on any word in the reader panel to see its morphological analysis, including
          lemma, root, part of speech, and grammatical features. This is powered by CAMeL Tools
          morphological analysis.
        </p>
      </Section>

      <Section title="Keyboard Navigation">
        <ul className="list-disc list-inside text-app-text-secondary space-y-1">
          <li>The reader scrolls: the wheel, the arrow keys and the scrollbar move through the book; type a volume and page and press <strong>Go</strong> to place a page</li>
          <li><strong>Ctrl+T</strong> shows or hides the table of contents beside the text; clicking a heading places its page. <strong>Ctrl+B</strong> shows or hides the search sidebar</li>
          <li>Results panel supports scrolling with keyboard</li>
          <li>Press Enter in search fields to execute the search</li>
        </ul>
      </Section>
    </div>
  );
}

interface HelpPanelProps {
  onClose: () => void;
}

export function HelpPanel({ onClose }: HelpPanelProps) {
  const [activeTab, setActiveTab] = useState<HelpTab>('overview');

  const tabs: { id: HelpTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'term-search', label: 'Term Search' },
    { id: 'search-modes', label: 'Surface/Lemma/Root' },
    { id: 'wildcards', label: 'Wildcards' },
    { id: 'name-search', label: 'Name Search' },
    { id: 'features', label: 'Features' },
  ];

  const renderContent = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab />;
      case 'term-search':
        return <TermSearchTab />;
      case 'name-search':
        return <NameSearchTab />;
      case 'search-modes':
        return <SearchModesTab />;
      case 'wildcards':
        return <WildcardsTab />;
      case 'features':
        return <FeaturesTab />;
    }
  };

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header */}
      <div className="h-14 border-b border-app-border-light px-6 flex items-center justify-between flex-shrink-0 bg-app-surface">
        <h2 className="font-semibold text-app-text-primary text-lg">Help & Documentation</h2>
        <button
          onClick={onClose}
          className="p-2 rounded-md hover:bg-app-accent-light transition-colors"
          title="Close Help"
        >
          <svg className="w-5 h-5 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-6 pt-4 bg-app-surface border-b border-app-border-light">
        {tabs.map(tab => (
          <TabButton
            key={tab.id}
            id={tab.id}
            label={tab.label}
            active={activeTab === tab.id}
            onClick={setActiveTab}
          />
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
