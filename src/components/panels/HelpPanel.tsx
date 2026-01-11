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
          al-Kashshāf is a research environment for exploring medieval Arabic texts. It provides powerful
          search capabilities across a large corpus of classical Arabic literature, with morphological
          analysis and flexible query options.
        </p>
      </Section>

      <Section title="Getting Started">
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li>Use the <strong>sidebar</strong> on the left to enter search queries</li>
          <li>Switch between <strong>Terms</strong> and <strong>Names</strong> modes using the tabs</li>
          <li>Results appear in the bottom panel; click any result to view the full page above</li>
          <li>Use <strong>Browse Texts</strong> in the toolbar to explore the corpus metadata</li>
          <li>Filter searches to specific texts using <strong>Select Texts</strong></li>
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
          Term search finds pages containing your query terms. You can search by surface form,
          lemma, or root, and combine multiple terms with Boolean operators.
        </p>
      </Section>

      <Section title="Boolean Search (AND/OR)">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Combine multiple search terms using AND and OR logic:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li><strong>AND terms:</strong> All AND terms must appear on the same page</li>
          <li><strong>OR terms:</strong> At least one OR term must match (in addition to all AND terms)</li>
          <li>Click <strong>+ Add Term</strong> to add more search inputs</li>
          <li>Use the dropdown to switch between AND and OR for each term</li>
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
          Find two terms that appear near each other within a specified distance:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li>Enter two terms and the maximum token distance between them</li>
          <li>Distance is measured in tokens (words), not characters</li>
          <li>Each term can use a different search mode (surface, lemma, root)</li>
          <li>Useful for finding phrases or related concepts</li>
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
          <li><strong>Kunya (كنية):</strong> Patronymic like "أبو منصور" - can add multiple</li>
          <li><strong>Nasab (نسب):</strong> Lineage chain like "معمر بن أحمد بن زياد"</li>
          <li><strong>Nisba (نسبة):</strong> Attributive names like "الأصبهاني" or "الصوفي" - can add multiple</li>
        </ul>
      </Section>

      <Section title="How It Works">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          The name search automatically generates variants including:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li>Different grammatical cases for kunya (أبو/أبا/أبي)</li>
          <li>Combinations with and without "ابن" connectors</li>
          <li>Various orderings of nasab and nisba elements</li>
          <li>Proclitic variants (و، ف، etc.) on the first word</li>
        </ul>
        <p className="text-app-text-secondary leading-relaxed mt-2">
          The generated patterns are shown below the form so you can see exactly what will be searched.
        </p>
      </Section>

      <Section title="Multiple Name Forms">
        <p className="text-app-text-secondary leading-relaxed">
          Click <strong>+ Add Name Form</strong> to search for multiple different people in the same query.
          Results will include pages mentioning any of the specified names.
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
          Wildcards allow you to search for words matching a pattern. Use the asterisk (*) character
          to match any sequence of characters.
        </p>
      </Section>

      <Section title="Wildcard Rules">
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li><strong>Surface mode only:</strong> Wildcards only work in Surface search mode</li>
          <li><strong>One wildcard per term:</strong> Each search term can have at most one *</li>
          <li><strong>No leading wildcard:</strong> The * cannot be at the start of a word (*كتاب is invalid)</li>
          <li><strong>Internal wildcards need 2+ chars:</strong> For wildcards in the middle of a word, at least 2 characters must precede the *</li>
        </ul>
      </Section>

      <Section title="Wildcard Types">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-app-text-primary">Prefix Wildcard (word ending)</p>
            <p className="text-app-text-secondary">
              <code className="bg-app-surface-variant px-1 rounded">كتا*</code> matches "كتاب", "كتابة", "كتابه", etc.
            </p>
          </div>
          <div>
            <p className="font-medium text-app-text-primary">Internal Wildcard</p>
            <p className="text-app-text-secondary">
              <code className="bg-app-surface-variant px-1 rounded">مع*ة</code> matches "معرفة", "معاملة", "معاينة", etc.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Performance Considerations">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Some wildcard patterns are more "expensive" (slower) than others:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-2">
          <li><strong>Faster:</strong> Longer prefixes before the * (e.g., "استكت*" is faster than "كت*")</li>
          <li><strong>Slower:</strong> Short prefixes match many more terms and take longer</li>
          <li><strong>Phrase wildcards:</strong> Multi-word wildcard searches (e.g., "معر*فة الله") require additional verification and may be slower</li>
        </ul>
        <p className="text-app-text-secondary leading-relaxed mt-2">
          For best performance, use the longest prefix you can while still matching your target words.
        </p>
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
          <li>Export filtered or complete metadata to CSV</li>
          <li>See token and page counts for each text</li>
        </ul>
      </Section>

      <Section title="Text Selection">
        <p className="text-app-text-secondary leading-relaxed">
          Click <strong>Select Texts</strong> in the sidebar to limit your searches to specific texts.
          This is useful for focused research on particular authors, time periods, or genres.
          The filter persists across searches until you clear it.
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
          <li><strong>Term/Name search:</strong> Click the export button in the results panel header</li>
          <li>Exports include metadata, page references, and matched text</li>
          <li>Results are saved as CSV files you can open in Excel or other tools</li>
        </ul>
      </Section>

      <Section title="Search History">
        <p className="text-app-text-secondary leading-relaxed mb-2">
          Your searches are automatically saved for quick access later:
        </p>
        <ul className="list-disc list-inside text-app-text-secondary space-y-1">
          <li>Click <strong>Search History</strong> in the toolbar to view history</li>
          <li>Searches are saved with their text filters</li>
          <li>Click any saved search to re-run it instantly</li>
          <li>Delete searches you no longer need</li>
        </ul>
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
          <li>Use <strong>Prev/Next</strong> buttons or navigate between pages in the reader</li>
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
