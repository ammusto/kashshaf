//! The Stats panel's commands (Lab spec §4.1, §7.3).
//!
//! Every command here is thin: it fetches the current book (loading it if it
//! is not the one asked for), builds or reuses the layer's `BookText`,
//! applies the stop list and an optional section scope, and calls one pure
//! function in `analysis/`. The numbers come from there and nowhere else.
//!
//! Batch work — loading a book, building a reference set, building the
//! frequency snapshot — runs on the blocking pool, reports progress through
//! `stats-progress`, and polls the cancel flag (ground rule 6).

use crate::analysis::concordance::{self, ConcordanceQuery, SortBy};
use crate::analysis::dispersion::{self, Dispersion};
use crate::analysis::freq::{self, FreqList};
use crate::analysis::keyness::{self, Counts, KeyItem, KeynessOptions};
use crate::analysis::ngrams::{self, CollocationOptions, Collocations, NgramOptions, NgramRow};
use crate::analysis::sections::{self, Section};
use crate::analysis::text::{BookText, StopList};
use crate::error::LabError;
use crate::source::{BookSource, FreqLayer, Layer, Page};
use crate::state::{handles, Handles, LoadedBook, ManagedLabState};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, State, Window};

const PROGRESS_EVENT: &str = "stats-progress";

/// What a batch operation reports as it goes.
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub stage: &'static str,
    pub done: u64,
    pub total: u64,
    /// Wall-clock estimate for the whole stage, once enough has run to make one.
    pub estimate_ms: Option<u64>,
}

fn emit(window: &Window, stage: &'static str, done: u64, total: u64, started: std::time::Instant) {
    let elapsed = started.elapsed().as_millis() as u64;
    let estimate_ms = if done >= 10.min(total.max(1)) && done > 0 { Some(elapsed * total / done) } else { None };
    let _ = window.emit(PROGRESS_EVENT, Progress { stage, done, total, estimate_ms });
}

fn cancelled(h: &Handles) -> bool {
    h.cancel.load(Ordering::SeqCst)
}

fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, LabError> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, LabError>> {
    async move {
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| LabError::Other(format!("task failed: {}", e)))?
    }
}

// ------------------------------------------------------------- loading ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadSummary {
    pub book_id: u64,
    pub pages: usize,
    pub tokens: usize,
    pub sections: usize,
    pub load_ms: u64,
    /// True when the book was already loaded and nothing was read.
    pub cached: bool,
}

/// Load (or reuse) the current book; shared with the isnād commands.
pub(crate) fn load_book(h: &Handles, window: Option<&Window>, book_id: u64) -> Result<Arc<LoadedBook>, LabError> {
    load_book_blocking(h, window, book_id)
}

fn load_book_blocking(h: &Handles, window: Option<&Window>, book_id: u64) -> Result<Arc<LoadedBook>, LabError> {
    if let Some(b) = h.loaded.lock().unwrap().as_ref() {
        if b.id == book_id {
            return Ok(Arc::clone(b));
        }
    }
    h.cancel.store(false, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let cancel = Arc::clone(&h.cancel);
    let progress = |done: u64, total: u64| {
        if let Some(w) = window {
            emit(w, "load", done, total, started);
        }
        // `book_pages` cannot stop midway; the flag is honoured before the
        // heavier steps that follow.
        let _ = &cancel;
    };
    let pages = h.source.book_pages(book_id, &progress)?;
    if pages.is_empty() {
        return Err(LabError::NotFound(format!("book {} has no pages in this corpus", book_id)));
    }
    if cancelled(h) {
        return Err(LabError::Other("cancelled".into()));
    }
    let loaded = Arc::new(LoadedBook::new(book_id, pages, started.elapsed().as_millis() as u64));
    *h.loaded.lock().unwrap() = Some(Arc::clone(&loaded));
    Ok(loaded)
}

/// Load a book for analysis (or confirm it is loaded), with progress.
#[tauri::command]
pub async fn stats_load_book(window: Window, state: State<'_, ManagedLabState>, book_id: u64) -> Result<LoadSummary, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let already = h.loaded.lock().unwrap().as_ref().map(|b| b.id == book_id).unwrap_or(false);
        let b = load_book_blocking(&h, Some(&window), book_id)?;
        Ok(LoadSummary {
            book_id,
            pages: b.pages.len(),
            tokens: b.tokens(),
            sections: b.sections.len(),
            load_ms: b.load_ms,
            cached: already,
        })
    })
    .await
}

/// Ask the running batch operation to stop.
#[tauri::command]
pub fn stats_cancel(state: State<'_, ManagedLabState>) -> Result<(), LabError> {
    let guard = state.read().map_err(|_| LabError::Other("Lab state lock poisoned".into()))?;
    guard.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

// ----------------------------------------------------------- stop list ---

const STOPWORDS_KEY: &str = "stopwords";

/// The user's list from `lab_setting`, else the shipped default.
fn stop_list(h: &Handles) -> StopList {
    if let Some(store) = &h.store {
        if let Ok(conn) = store.connect() {
            if let Ok(Some(json)) = kashshaf_common::get_kv(&conn, "lab_setting", STOPWORDS_KEY) {
                if let Ok(words) = serde_json::from_str::<Vec<String>>(&json) {
                    return StopList::new(words);
                }
            }
        }
    }
    StopList::shipped()
}

#[tauri::command]
pub fn get_stopwords(state: State<'_, ManagedLabState>) -> Result<Vec<String>, LabError> {
    let h = handles(&state)?;
    let mut v: Vec<String> = stop_list(&h).iter().map(String::from).collect();
    v.sort();
    Ok(v)
}

/// Replace the user's list. An empty list is a valid list (stop words off
/// for good); "reset to default" is `reset_stopwords`.
#[tauri::command]
pub fn set_stopwords(state: State<'_, ManagedLabState>, words: Vec<String>) -> Result<usize, LabError> {
    let h = handles(&state)?;
    let store = h.store.as_ref().ok_or_else(|| LabError::Database("analysis.db is not available".into()))?;
    let conn = store.connect().map_err(|e| LabError::Database(e.to_string()))?;
    let cleaned: Vec<String> = words.into_iter().map(|w| w.trim().to_string()).filter(|w| !w.is_empty()).collect();
    kashshaf_common::set_kv(&conn, "lab_setting", STOPWORDS_KEY, &serde_json::to_string(&cleaned).unwrap())
        .map_err(|e| LabError::Database(e.to_string()))?;
    Ok(cleaned.len())
}

#[tauri::command]
pub fn reset_stopwords(state: State<'_, ManagedLabState>) -> Result<Vec<String>, LabError> {
    let h = handles(&state)?;
    if let Some(store) = &h.store {
        let conn = store.connect().map_err(|e| LabError::Database(e.to_string()))?;
        conn.execute("DELETE FROM lab_setting WHERE key = ?1", [STOPWORDS_KEY])
            .map_err(|e| LabError::Database(e.to_string()))?;
    }
    let mut v: Vec<String> = StopList::shipped().iter().map(String::from).collect();
    v.sort();
    Ok(v)
}

// --------------------------------------------------------------- scope ---

/// The common arguments of every statistic.
#[derive(Debug, Clone, Deserialize)]
pub struct Scope {
    pub book_id: u64,
    pub layer: Layer,
    /// Apply the stop list.
    #[serde(default)]
    pub stop: bool,
    /// Restrict to one section (its `id`), when given.
    #[serde(default)]
    pub section: Option<u64>,
}

struct Scoped {
    book: Arc<LoadedBook>,
    text: Arc<BookText>,
    stop: Option<StopList>,
}

fn scoped(h: &Handles, s: &Scope) -> Result<Scoped, LabError> {
    let book = load_book_blocking(h, None, s.book_id)?;
    let mut text = book.text(s.layer);
    if let Some(id) = s.section {
        let sec = book
            .sections
            .iter()
            .find(|x| x.id == id)
            .ok_or_else(|| LabError::NotFound(format!("section {} in book {}", id, s.book_id)))?;
        text = Arc::new(text.masked(sec.start, sec.end));
    }
    let stop = if s.stop { Some(stop_list(h)) } else { None };
    Ok(Scoped { book, text, stop })
}

/// Page coordinates and labels, in reading order — the axis of the strip
/// plot and the click-through of every row.
#[derive(Debug, Clone, Serialize)]
pub struct PageLabel {
    pub index: usize,
    pub part_index: u32,
    pub page_id: u64,
    pub part_label: String,
    pub page_number: String,
    pub tokens: usize,
}

fn labels(pages: &[Page]) -> Vec<PageLabel> {
    pages
        .iter()
        .enumerate()
        .map(|(i, p)| PageLabel {
            index: i,
            part_index: p.part_index,
            page_id: p.page_id,
            part_label: p.part_label.clone(),
            page_number: p.page_number.clone(),
            tokens: p.tokens.len(),
        })
        .collect()
}

#[tauri::command]
pub async fn stats_page_labels(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Vec<PageLabel>, LabError> {
    let h = handles(&state)?;
    blocking(move || Ok(labels(&load_book_blocking(&h, None, book_id)?.pages))).await
}

// --------------------------------------------------------- frequencies ---

#[derive(Debug, Clone, Serialize)]
pub struct FreqResponse {
    pub list: FreqList,
    /// Why the corpus columns are empty, when they are.
    pub corpus_note: Option<String>,
}

fn freq_layer(layer: Layer) -> Option<FreqLayer> {
    match layer {
        Layer::Lemma => Some(FreqLayer::Lemma),
        Layer::Root => Some(FreqLayer::Root),
        Layer::Surface => None,
    }
}

#[tauri::command]
pub async fn stats_frequencies(state: State<'_, ManagedLabState>, scope: Scope) -> Result<FreqResponse, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let sc = scoped(&h, &scope)?;
        let (table, corpus_note) = match freq_layer(scope.layer) {
            None => (None, Some("corpus frequencies are shipped for lemma and root only (spec §3.4)".to_string())),
            Some(fl) => match h.source.freq_table(fl) {
                Ok(t) => (Some(t), None),
                Err(e) => (None, Some(e.to_string())),
            },
        };
        let list = freq::frequency_list(&sc.text, sc.stop.as_ref(), table.as_deref());
        Ok(FreqResponse { list, corpus_note })
    })
    .await
}

// --------------------------------------------------------- concordance ---

#[derive(Debug, Clone, Deserialize)]
pub struct ConcordanceArgs {
    pub scope: Scope,
    pub query: String,
    #[serde(default)]
    pub clitics: bool,
    /// Tokens of context either side, 3–25 (spec §4.1); default 8.
    #[serde(default)]
    pub context: Option<usize>,
    #[serde(default)]
    pub sort: Option<SortBy>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConcordanceLine {
    pub page: usize,
    pub part_index: u32,
    pub page_id: u64,
    pub part_label: String,
    pub page_number: String,
    pub tok_start: usize,
    pub tok_end: usize,
    pub global: usize,
    pub left: Vec<String>,
    pub node: Vec<String>,
    pub right: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConcordanceResponse {
    pub total: usize,
    pub offset: usize,
    pub lines: Vec<ConcordanceLine>,
}

#[tauri::command]
pub async fn stats_concordance(state: State<'_, ManagedLabState>, args: ConcordanceArgs) -> Result<ConcordanceResponse, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let sc = scoped(&h, &args.scope)?;
        let q = ConcordanceQuery { layer: args.scope.layer, query: args.query.clone(), clitics: args.clitics };
        let hits = concordance::find_hits(&sc.text, &q);
        let context = args.context.unwrap_or(8).clamp(3, 25);
        let mut lines = concordance::kwic(&sc.text, &sc.book.pages, &hits, context);
        concordance::sort_lines(&mut lines, args.sort.unwrap_or(SortBy::Position));
        let total = lines.len();
        let limit = args.limit.unwrap_or(200).clamp(1, 1000);
        let pages = &sc.book.pages;
        let out = lines
            .into_iter()
            .skip(args.offset)
            .take(limit)
            .map(|l| {
                let p = &pages[l.hit.page];
                ConcordanceLine {
                    page: l.hit.page,
                    part_index: p.part_index,
                    page_id: p.page_id,
                    part_label: p.part_label.clone(),
                    page_number: p.page_number.clone(),
                    tok_start: l.hit.tok_start,
                    tok_end: l.hit.tok_end,
                    global: l.hit.global,
                    left: l.left,
                    node: l.node,
                    right: l.right,
                }
            })
            .collect();
        Ok(ConcordanceResponse { total, offset: args.offset, lines: out })
    })
    .await
}

// ------------------------------------------------------------- keyness ---

/// The reference set (spec §4.1 "Keyness").
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RefSpec {
    /// The whole corpus minus this book, from the shipped snapshot.
    Corpus,
    /// Every other book by the same author.
    Author,
    Genre,
    Century,
    /// A user selection: Lab's picker, or a Kashshaf collection's `book_ids`.
    Books { ids: Vec<u64> },
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeynessArgs {
    pub scope: Scope,
    pub reference: RefSpec,
    #[serde(default)]
    pub min_freq: Option<u64>,
    #[serde(default)]
    pub min_bic: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeynessResponse {
    pub book_total: u64,
    pub ref_total: u64,
    /// How many books the reference was built from (0 for the corpus snapshot).
    pub ref_books: usize,
    pub reference: RefSpec,
    pub items: Vec<KeyItem>,
}

/// In api mode a reference set is fetched book by book under the server's
/// bulk caps (spec §5.1: 30 per hour), so only a small selection is allowed.
const API_MAX_REF_BOOKS: usize = 8;

fn reference_books(source: &dyn BookSource, book_id: u64, spec: &RefSpec) -> Result<Vec<u64>, LabError> {
    let all = source.books()?;
    let me = all.iter().find(|b| b.id == book_id).ok_or_else(|| LabError::NotFound(format!("book {}", book_id)))?;
    let ids: Vec<u64> = match spec {
        RefSpec::Corpus => vec![],
        RefSpec::Books { ids } => ids.iter().copied().filter(|&id| id != book_id).collect(),
        RefSpec::Author => {
            let a = me.author_id.ok_or_else(|| LabError::Other("this book has no author id".into()))?;
            all.iter().filter(|b| b.author_id == Some(a) && b.id != book_id).map(|b| b.id).collect()
        }
        RefSpec::Genre => {
            let g = me.genre_id.ok_or_else(|| LabError::Other("this book has no genre id".into()))?;
            all.iter().filter(|b| b.genre_id == Some(g) && b.id != book_id).map(|b| b.id).collect()
        }
        RefSpec::Century => {
            let c = me.century_ah.ok_or_else(|| LabError::Other("this book has no century".into()))?;
            all.iter().filter(|b| b.century_ah == Some(c) && b.id != book_id).map(|b| b.id).collect()
        }
    };
    Ok(ids)
}

/// Counts over a set of books, read one at a time with progress and cancel.
fn counts_over_books(
    h: &Handles,
    window: &Window,
    ids: &[u64],
    layer: Layer,
    stop: Option<&StopList>,
) -> Result<Counts, LabError> {
    h.cancel.store(false, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let total = ids.len() as u64;
    let mut acc = Counts::default();
    for (i, &id) in ids.iter().enumerate() {
        if cancelled(h) {
            return Err(LabError::Other(format!("cancelled after {} of {} books", i, total)));
        }
        let pages = h.source.book_pages(id, &|_, _| {})?;
        let text = BookText::build(&pages, layer);
        acc = Counts::sum([&acc, &Counts::from_text(&text, stop)]);
        emit(window, "reference", i as u64 + 1, total, started);
    }
    Ok(acc)
}

#[tauri::command]
pub async fn stats_keyness(window: Window, state: State<'_, ManagedLabState>, args: KeynessArgs) -> Result<KeynessResponse, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let sc = scoped(&h, &args.scope)?;
        let book = Counts::from_text(&sc.text, sc.stop.as_ref());
        let (reference, ref_books) = match &args.reference {
            RefSpec::Corpus => {
                let fl = freq_layer(args.scope.layer).ok_or_else(|| {
                    LabError::Other("keyness against the corpus runs on the lemma or root layer (spec §3.4)".into())
                })?;
                let table = h.source.freq_table(fl)?;
                // The whole corpus includes this book; compare with the rest.
                let whole = Counts::from_table(&table);
                let unscoped = Counts::from_text(&sc.book.text(args.scope.layer), sc.stop.as_ref());
                (whole.minus(&unscoped), 0)
            }
            spec => {
                let ids = reference_books(h.source.as_ref(), args.scope.book_id, spec)?;
                if ids.is_empty() {
                    return Err(LabError::Other("the reference set has no other books".into()));
                }
                if !h.source.is_local() && ids.len() > API_MAX_REF_BOOKS {
                    return Err(LabError::Other(format!(
                        "online, a reference set is fetched book by book under the server's bulk limits; \
                         this one has {} books and the limit is {}. Use the corpus reference, pick fewer books, \
                         or download the corpus for local mode.",
                        ids.len(),
                        API_MAX_REF_BOOKS
                    )));
                }
                let n = ids.len();
                (counts_over_books(&h, &window, &ids, args.scope.layer, sc.stop.as_ref())?, n)
            }
        };
        let opts = KeynessOptions {
            min_freq: args.min_freq.unwrap_or(3),
            min_bic: args.min_bic.unwrap_or(2.0),
        };
        let items = keyness::keyness(&book, &reference, &opts);
        Ok(KeynessResponse { book_total: book.total, ref_total: reference.total, ref_books, reference: args.reference, items })
    })
    .await
}

// ---------------------------------------------------------- dispersion ---

#[derive(Debug, Clone, Deserialize)]
pub struct DispersionArgs {
    pub scope: Scope,
    pub key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DispersionResponse {
    pub dispersion: Dispersion,
    pub pages: Vec<PageLabel>,
    /// Per section: occurrences and the section, for the per-section table.
    pub by_section: Vec<(Section, u64)>,
}

#[tauri::command]
pub async fn stats_dispersion(state: State<'_, ManagedLabState>, args: DispersionArgs) -> Result<DispersionResponse, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let sc = scoped(&h, &args.scope)?;
        let d = dispersion::dispersion(&sc.text, &args.key);
        let by_section = sc
            .book
            .sections
            .iter()
            .map(|s| {
                let n = d.positions.iter().filter(|p| {
                    let g = sc.text.global(**p);
                    g >= s.start && g < s.end
                }).count() as u64;
                (s.clone(), n)
            })
            .collect();
        Ok(DispersionResponse { dispersion: d, pages: labels(&sc.book.pages), by_section })
    })
    .await
}

// ------------------------------------------------- n-grams, collocations ---

#[derive(Debug, Clone, Deserialize)]
pub struct NgramArgs {
    pub scope: Scope,
    pub n: usize,
    #[serde(default = "default_true")]
    pub span_aware: bool,
    #[serde(default)]
    pub min_count: Option<u64>,
}

fn default_true() -> bool {
    true
}

#[tauri::command]
pub async fn stats_ngrams(state: State<'_, ManagedLabState>, args: NgramArgs) -> Result<Vec<NgramRow>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let sc = scoped(&h, &args.scope)?;
        let bounds = sections::boundaries(&sc.book.sections);
        let opts = NgramOptions { n: args.n, span_aware: args.span_aware, min_count: args.min_count.unwrap_or(2) };
        Ok(ngrams::ngrams(&sc.text, &opts, sc.stop.as_ref(), &bounds))
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
pub struct CollocationArgs {
    pub scope: Scope,
    pub node: String,
    #[serde(default)]
    pub left: Option<usize>,
    #[serde(default)]
    pub right: Option<usize>,
    #[serde(default = "default_true")]
    pub span_aware: bool,
    #[serde(default)]
    pub min_freq: Option<u64>,
}

#[tauri::command]
pub async fn stats_collocations(state: State<'_, ManagedLabState>, args: CollocationArgs) -> Result<Collocations, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let sc = scoped(&h, &args.scope)?;
        let bounds = sections::boundaries(&sc.book.sections);
        let opts = CollocationOptions {
            left: args.left.unwrap_or(5).min(50),
            right: args.right.unwrap_or(5).min(50),
            span_aware: args.span_aware,
            min_freq: args.min_freq.unwrap_or(3),
        };
        Ok(ngrams::collocations(&sc.text, &args.node, &opts, sc.stop.as_ref(), &bounds))
    })
    .await
}

// ------------------------------------------------------------ sections ---

#[derive(Debug, Clone, Serialize)]
pub struct SectionsResponse {
    pub sections: Vec<Section>,
    pub pages: Vec<PageLabel>,
    pub longest: Option<u64>,
    pub shortest: Option<u64>,
}

#[tauri::command]
pub async fn stats_sections(state: State<'_, ManagedLabState>, book_id: u64) -> Result<SectionsResponse, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let b = load_book_blocking(&h, None, book_id)?;
        let secs: Vec<Section> = (*b.sections).clone();
        let longest = secs.iter().max_by_key(|s| s.tokens).map(|s| s.id);
        let shortest = secs.iter().min_by_key(|s| s.tokens).map(|s| s.id);
        Ok(SectionsResponse { sections: secs, pages: labels(&b.pages), longest, shortest })
    })
    .await
}

// ----------------------------------------------- frequency snapshot build ---

#[derive(Debug, Clone, Serialize)]
pub struct FreqStatus {
    pub lemma: Result<usize, String>,
    pub root: Result<usize, String>,
}

/// Whether the corpus frequency tables can be read, per layer, with the
/// reason when not — the Settings panel shows this next to the build button.
#[tauri::command]
pub async fn stats_freq_status(state: State<'_, ManagedLabState>) -> Result<FreqStatus, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let probe = |l: FreqLayer| h.source.freq_table(l).map(|t| t.len()).map_err(|e| e.to_string());
        Ok(FreqStatus { lemma: probe(FreqLayer::Lemma), root: probe(FreqLayer::Root) })
    })
    .await
}

/// Local mode only: build `lemma_freq.bin` / `root_freq.bin` by scanning the
/// corpus, with progress and cancel, and install them in Lab's cache.
#[tauri::command]
pub async fn stats_build_freq_tables(window: Window, state: State<'_, ManagedLabState>) -> Result<FreqStatus, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let local = h
            .source
            .as_local()
            .ok_or_else(|| LabError::Other("building the frequency snapshot needs a local corpus".into()))?;
        h.cancel.store(false, Ordering::SeqCst);
        let started = std::time::Instant::now();
        let ids: Vec<u64> = local.books()?.into_iter().map(|b| b.id).collect();
        let built = crate::source::freq::build_from_corpus(
            local.token_cache(),
            &ids,
            local.corpus_version(),
            &|done, total| emit(&window, "freq", done, total, started),
            &|| h.cancel.load(Ordering::SeqCst),
        )?;
        let Some((lemma, root)) = built else {
            return Err(LabError::Other("cancelled; nothing was written".into()));
        };
        let (nl, nr) = (lemma.len(), root.len());
        local.install_freq_tables(lemma, root)?;
        Ok(FreqStatus { lemma: Ok(nl), root: Ok(nr) })
    })
    .await
}

// -------------------------------------------------------------- export ---

/// Write an export to `<lab dir>/exports/` (spec §6.6) and return its path.
/// The frontend builds the CSV/JSON text; this only names and places it.
#[tauri::command]
pub fn save_export(name: String, contents: String) -> Result<String, LabError> {
    let dir = kashshaf_common::lab_data_dir().map_err(|e| LabError::Other(e.to_string()))?.join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| LabError::Other(e.to_string()))?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("{}-{}", stamp, safe));
    std::fs::write(&path, contents.as_bytes()).map_err(|e| LabError::Other(e.to_string()))?;
    Ok(path.display().to_string())
}
