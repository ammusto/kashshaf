import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, writeFile } from '@tauri-apps/plugin-fs';
import * as XLSX from 'xlsx';
import type { BookMetadata, SearchResult } from '../types';

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
export function generateBooksCSV(books: BookMetadata[]): string {
  const headers = [
    'ID', 'Title', 'Author', 'Author ID', 'Death Year (AH)', 'Century (AH)',
    'Genre', 'Page Count', 'Token Count', 'Corpus', 'Original ID', 'Date', 'Paginated'
  ];

  const rows = books.map(book => [
    escapeCSV(book.id),
    escapeCSV(book.title),
    escapeCSV(book.author),
    escapeCSV(book.author_id),
    escapeCSV(book.death_ah),
    escapeCSV(book.century_ah),
    escapeCSV(book.genre),
    escapeCSV(book.page_count),
    escapeCSV(book.token_count),
    escapeCSV(book.corpus),
    escapeCSV(book.original_id),
    escapeCSV(book.date),
    escapeCSV(book.paginated ? 'Yes' : 'No')
  ].join(','));

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
export function generateSearchResultsCSV(results: SearchResult[]): string {
  const headers = [
    'Book ID', 'Title', 'Author', 'Death Year (AH)', 'Century (AH)', 'Genre',
    'Volume', 'Page', 'Score', 'Context'
  ];

  const rows = results.map(result => [
    escapeCSV(result.id),
    escapeCSV(result.title),
    escapeCSV(result.author),
    escapeCSV(result.death_ah),
    escapeCSV(result.century_ah),
    escapeCSV(result.genre),
    escapeCSV(result.part_label),
    escapeCSV(result.page_number),
    escapeCSV(result.score.toFixed(2)),
    escapeCSV(stripHtmlForExport(result.body || '').slice(0, 500)) // Limit context to 500 chars
  ].join(','));

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
export function generateBooksXLSX(books: BookMetadata[]): Uint8Array {
  const data = books.map(book => ({
    'ID': book.id,
    'Title': book.title,
    'Author': book.author ?? '',
    'Author ID': book.author_id ?? '',
    'Death Year (AH)': book.death_ah ?? '',
    'Century (AH)': book.century_ah ?? '',
    'Genre': book.genre ?? '',
    'Page Count': book.page_count ?? '',
    'Token Count': book.token_count ?? '',
    'Corpus': book.corpus ?? '',
    'Original ID': book.original_id ?? '',
    'Date': book.date ?? '',
    'Paginated': book.paginated ? 'Yes' : 'No'
  }));

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
export function generateSearchResultsXLSX(results: SearchResult[]): Uint8Array {
  const data = results.map(result => ({
    'Book ID': result.id,
    'Title': result.title,
    'Author': result.author,
    'Death Year (AH)': result.death_ah ?? '',
    'Century (AH)': result.century_ah ?? '',
    'Genre': result.genre ?? '',
    'Volume': result.part_label,
    'Page': result.page_number,
    'Score': result.score.toFixed(2),
    'Context': stripHtmlForExport(result.body || '').slice(0, 500)
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Search Results');

  return workbookToUint8Array(workbook);
}

export type ExportFormat = 'csv' | 'xlsx';

/**
 * Show save dialog and export CSV data
 */
async function exportCSVWithDialog(
  content: string,
  defaultFileName: string
): Promise<boolean> {
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
  format: ExportFormat
): Promise<boolean> {
  const date = new Date().toISOString().split('T')[0];

  if (format === 'csv') {
    const fileName = `texts_metadata_${date}.csv`;
    const content = generateBooksCSV(books);
    return exportCSVWithDialog(content, fileName);
  } else {
    const fileName = `texts_metadata_${date}.xlsx`;
    const data = generateBooksXLSX(books);
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
  format: ExportFormat
): Promise<boolean> {
  const date = new Date().toISOString().split('T')[0];

  if (format === 'csv') {
    const fileName = `search_results_${date}.csv`;
    const content = generateSearchResultsCSV(results);
    return exportCSVWithDialog(content, fileName);
  } else {
    const fileName = `search_results_${date}.xlsx`;
    const data = generateSearchResultsXLSX(results);
    return exportXLSXWithDialog(data, fileName);
  }
}
