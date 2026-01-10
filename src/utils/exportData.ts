import * as XLSX from 'xlsx';
import type { BookMetadata, SearchResult } from '../types';
import { isWebTarget } from './platform';

// BOM for UTF-8 Excel compatibility with Arabic
const UTF8_BOM = '\uFEFF';

interface AuthorInfo {
  author: string;
  author_id?: number;
  death_ah?: number;
  bookCount: number;
  totalPages: number;
  genres: Set<string>;
}

/**
 * Escape a value for CSV format
 */
function escapeCSV(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  // If contains comma, quote, or newline, wrap in quotes and escape existing quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate CSV content from books metadata
 */
export function generateBooksCSV(
  books: BookMetadata[],
  authorsMap?: Map<number, string>,
  genresMap?: Map<number, string>
): string {
  const headers = [
    'ID', 'Title', 'Author', 'Author ID', 'Death Year (AH)', 'Century (AH)',
    'Genre', 'Genre ID', 'Page Count', 'Token Count', 'Corpus', 'Original ID', 'Paginated'
  ];

  const rows = books.map(book => {
    const authorName = book.author_id !== undefined && authorsMap ? authorsMap.get(book.author_id) : undefined;
    const genreName = book.genre_id !== undefined && genresMap ? genresMap.get(book.genre_id) : undefined;
    return [
      escapeCSV(book.id),
      escapeCSV(book.title),
      escapeCSV(authorName),
      escapeCSV(book.author_id),
      escapeCSV(book.death_ah),
      escapeCSV(book.century_ah),
      escapeCSV(genreName),
      escapeCSV(book.genre_id),
      escapeCSV(book.page_count),
      escapeCSV(book.token_count),
      escapeCSV(book.corpus),
      escapeCSV(book.original_id),
      escapeCSV(book.paginated ? 'Yes' : 'No')
    ].join(',');
  });

  return UTF8_BOM + [headers.join(','), ...rows].join('\n');
}

/**
 * Generate CSV content from authors metadata
 */
export function generateAuthorsCSV(authors: AuthorInfo[]): string {
  const headers = [
    'Author', 'Author ID', 'Death Year (AH)', 'Book Count', 'Total Pages', 'Genres'
  ];

  const rows = authors.map(author => [
    escapeCSV(author.author),
    escapeCSV(author.author_id),
    escapeCSV(author.death_ah),
    escapeCSV(author.bookCount),
    escapeCSV(author.totalPages),
    escapeCSV(Array.from(author.genres).join('; '))
  ].join(','));

  return UTF8_BOM + [headers.join(','), ...rows].join('\n');
}

/**
 * Generate CSV content from search results
 */
export function generateSearchResultsCSV(
  results: SearchResult[],
  booksMap?: Map<number, BookMetadata>,
  authorsMap?: Map<number, string>,
  genresMap?: Map<number, string>
): string {
  const headers = [
    'Book ID', 'Title', 'Author', 'Death Year (AH)', 'Century (AH)', 'Genre',
    'Volume', 'Page', 'Score', 'Context'
  ];

  const rows = results.map(result => {
    const book = booksMap?.get(result.id);
    const authorName = book?.author_id !== undefined && authorsMap ? authorsMap.get(book.author_id) : undefined;
    const genreName = book?.genre_id !== undefined && genresMap ? genresMap.get(book.genre_id) : undefined;
    return [
      escapeCSV(result.id),
      escapeCSV(book?.title),
      escapeCSV(authorName),
      escapeCSV(result.death_ah),
      escapeCSV(result.century_ah),
      escapeCSV(genreName),
      escapeCSV(result.part_label),
      escapeCSV(result.page_number),
      escapeCSV(result.score.toFixed(2)),
      escapeCSV(stripHtmlForExport(result.body || '').slice(0, 500)) // Limit context to 500 chars
    ].join(',');
  });

  return UTF8_BOM + [headers.join(','), ...rows].join('\n');
}

/**
 * Strip HTML tags for plain text export
 */
function stripHtmlForExport(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Helper to convert workbook to Uint8Array
 */
function workbookToUint8Array(workbook: XLSX.WorkBook): Uint8Array {
  // Use 'array' type which returns ArrayLike<number> in browser
  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(output);
}

/**
 * Generate XLSX workbook from books metadata using SheetJS
 */
export function generateBooksXLSX(
  books: BookMetadata[],
  authorsMap?: Map<number, string>,
  genresMap?: Map<number, string>
): Uint8Array {
  const data = books.map(book => {
    const authorName = book.author_id !== undefined && authorsMap ? authorsMap.get(book.author_id) : undefined;
    const genreName = book.genre_id !== undefined && genresMap ? genresMap.get(book.genre_id) : undefined;
    return {
      'ID': book.id,
      'Title': book.title,
      'Author': authorName ?? '',
      'Author ID': book.author_id ?? '',
      'Death Year (AH)': book.death_ah ?? '',
      'Century (AH)': book.century_ah ?? '',
      'Genre': genreName ?? '',
      'Genre ID': book.genre_id ?? '',
      'Page Count': book.page_count ?? '',
      'Token Count': book.token_count ?? '',
      'Corpus': book.corpus ?? '',
      'Original ID': book.original_id ?? '',
      'Paginated': book.paginated ? 'Yes' : 'No'
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Books');

  return workbookToUint8Array(workbook);
}

/**
 * Generate XLSX workbook for authors using SheetJS
 */
export function generateAuthorsXLSX(authors: AuthorInfo[]): Uint8Array {
  const data = authors.map(author => ({
    'Author': author.author,
    'Author ID': author.author_id ?? '',
    'Death Year (AH)': author.death_ah ?? '',
    'Book Count': author.bookCount,
    'Total Pages': author.totalPages,
    'Genres': Array.from(author.genres).join('; ')
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Authors');

  return workbookToUint8Array(workbook);
}

/**
 * Generate XLSX workbook for search results using SheetJS
 */
export function generateSearchResultsXLSX(
  results: SearchResult[],
  booksMap?: Map<number, BookMetadata>,
  authorsMap?: Map<number, string>,
  genresMap?: Map<number, string>
): Uint8Array {
  const data = results.map(result => {
    const book = booksMap?.get(result.id);
    const authorName = book?.author_id !== undefined && authorsMap ? authorsMap.get(book.author_id) : undefined;
    const genreName = book?.genre_id !== undefined && genresMap ? genresMap.get(book.genre_id) : undefined;
    return {
      'Book ID': result.id,
      'Title': book?.title ?? '',
      'Author': authorName ?? '',
      'Death Year (AH)': result.death_ah ?? '',
      'Century (AH)': result.century_ah ?? '',
      'Genre': genreName ?? '',
      'Volume': result.part_label,
      'Page': result.page_number,
      'Score': result.score.toFixed(2),
      'Context': stripHtmlForExport(result.body || '').slice(0, 500)
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Search Results');

  return workbookToUint8Array(workbook);
}

export type ExportFormat = 'csv' | 'xlsx';

/**
 * Download file in browser
 */
function downloadInBrowser(content: string | Uint8Array, fileName: string, mimeType: string): void {
  const blob = content instanceof Uint8Array
    ? new Blob([content], { type: mimeType })
    : new Blob([content], { type: mimeType });

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Show save dialog and export CSV data
 */
async function exportCSVWithDialog(
  content: string,
  defaultFileName: string
): Promise<boolean> {
  if (isWebTarget()) {
    // Web: trigger browser download
    downloadInBrowser(content, defaultFileName, 'text/csv;charset=utf-8;');
    return true;
  }

  // Desktop: use Tauri dialog
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');

  const filePath = await save({
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    defaultPath: defaultFileName,
  });

  if (filePath) {
    await writeTextFile(filePath, content);
    return true;
  }

  return false;
}

/**
 * Show save dialog and export XLSX data
 */
async function exportXLSXWithDialog(
  data: Uint8Array,
  defaultFileName: string
): Promise<boolean> {
  if (isWebTarget()) {
    // Web: trigger browser download
    downloadInBrowser(data, defaultFileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return true;
  }

  // Desktop: use Tauri dialog
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');

  const filePath = await save({
    filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    defaultPath: defaultFileName,
  });

  if (filePath) {
    await writeFile(filePath, data);
    return true;
  }

  return false;
}

/**
 * Export books metadata
 */
export async function exportBooks(
  books: BookMetadata[],
  format: ExportFormat,
  authorsMap?: Map<number, string>,
  genresMap?: Map<number, string>
): Promise<boolean> {
  const date = new Date().toISOString().split('T')[0];

  if (format === 'csv') {
    const fileName = `texts_metadata_${date}.csv`;
    const content = generateBooksCSV(books, authorsMap, genresMap);
    return exportCSVWithDialog(content, fileName);
  } else {
    const fileName = `texts_metadata_${date}.xlsx`;
    const data = generateBooksXLSX(books, authorsMap, genresMap);
    return exportXLSXWithDialog(data, fileName);
  }
}

/**
 * Export authors metadata
 */
export async function exportAuthors(
  authors: AuthorInfo[],
  format: ExportFormat
): Promise<boolean> {
  const date = new Date().toISOString().split('T')[0];

  if (format === 'csv') {
    const fileName = `authors_metadata_${date}.csv`;
    const content = generateAuthorsCSV(authors);
    return exportCSVWithDialog(content, fileName);
  } else {
    const fileName = `authors_metadata_${date}.xlsx`;
    const data = generateAuthorsXLSX(authors);
    return exportXLSXWithDialog(data, fileName);
  }
}

/**
 * Export search results
 */
export async function exportSearchResults(
  results: SearchResult[],
  format: ExportFormat,
  booksMap?: Map<number, BookMetadata>,
  authorsMap?: Map<number, string>,
  genresMap?: Map<number, string>
): Promise<boolean> {
  const date = new Date().toISOString().split('T')[0];

  if (format === 'csv') {
    const fileName = `search_results_${date}.csv`;
    const content = generateSearchResultsCSV(results, booksMap, authorsMap, genresMap);
    return exportCSVWithDialog(content, fileName);
  } else {
    const fileName = `search_results_${date}.xlsx`;
    const data = generateSearchResultsXLSX(results, booksMap, authorsMap, genresMap);
    return exportXLSXWithDialog(data, fileName);
  }
}
