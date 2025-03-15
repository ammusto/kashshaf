import * as XLSX from 'xlsx';
import { SearchResult, Text, Author } from '../types';

/**
 * Format search results for export with metadata lookup
 */
const formatResultsForExport = (
  results: SearchResult[],
  query: string,
  textsMetadata: Map<number, Text>,
  authorsMetadata: Map<number, Author>
): Array<Record<string, string>> => {
  return results.map(result => {
    // Look up text and author information from metadata
    const text = textsMetadata.get(result.text_id);
    const author = text ? authorsMetadata.get(text.au_id) : undefined;
    
    // Use metadata for title and author name
    const title = text?.title || result.text_title || `Text ID: ${result.text_id}`;
    const authorName = author?.name || result.author_name || `Author ID: ${text?.au_id || 'Unknown'}`;
    
    // Combine all highlights into a single context
    const context = result.highlights.map(h => {
      return `${h.pre} ${h.match} ${h.post}`;
    }).join(' ... ');
    
    return {
      'Text': title,
      'Author': authorName,
      'Location': `vol. ${result.vol}, pg. ${result.page_num}`,
      'Context': context,
      'Search Term': query
    };
  });
};

/**
 * Export search results as CSV
 */
export const exportResultsAsCsv = (
  results: SearchResult[],
  query: string,
  textsMetadata: Map<number, Text>,
  authorsMetadata: Map<number, Author>,
  filename = `kashshaf-results-${query}.csv`
): void => {
  const data = formatResultsForExport(results, query, textsMetadata, authorsMetadata);
  
  // Create a worksheet
  const worksheet = XLSX.utils.json_to_sheet(data);
  
  // Create a workbook
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Results');
  
  // Write to file and download
  XLSX.writeFile(workbook, filename);
};

/**
 * Export search results as XLSX
 */
export const exportResultsAsXlsx = (
  results: SearchResult[],
  query: string,
  textsMetadata: Map<number, Text>,
  authorsMetadata: Map<number, Author>,
  filename = `kashshaf-results-${query}.xlsx`
): void => {
  const data = formatResultsForExport(results, query, textsMetadata, authorsMetadata);
  
  // Create a worksheet
  const worksheet = XLSX.utils.json_to_sheet(data);
  
  // Add some styling (column widths)
  const columnWidths = [
    { wch: 30 }, // Text
    { wch: 20 }, // Author
    { wch: 10 }, // Location
    { wch: 80 }, // Context
    { wch: 20 }  // Search Term
  ];
  worksheet['!cols'] = columnWidths;
  
  // Create a workbook
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Results');
  
  // Write to file and download
  XLSX.writeFile(workbook, filename);
};