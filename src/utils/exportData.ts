import * as XLSX from 'xlsx';
import { SearchResult } from '../types';

/**
 * Format search results for export
 */
const formatResultsForExport = (
  results: SearchResult[],
  query: string
): Array<Record<string, string>> => {
  return results.map(result => {
    // Combine all highlights into a single context
    const context = result.highlights.map(h => {
      return `${h.pre} ${h.match} ${h.post}`;
    }).join(' ... ');
    
    return {
      'Text': result.text_title || '',
      'Author': result.author_name || '',
      'Location': `${result.vol}:${result.page_num}`,
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
  filename = 'kashshaf-results.csv'
): void => {
  const data = formatResultsForExport(results, query);
  
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
  filename = 'kashshaf-results.xlsx'
): void => {
  const data = formatResultsForExport(results, query);
  
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