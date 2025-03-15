import * as XLSX from 'xlsx';
import { Text, Author } from '../types';

/**
 * Load texts metadata from XLSX file
 */
export const loadTextsMetadata = async (): Promise<Map<number, Text>> => {
  try {
    // Fetch the XLSX file
    const response = await fetch('/texts.xlsx');
    if (!response.ok) {
      throw new Error(`Failed to fetch texts metadata: ${response.status} ${response.statusText}`);
    }
    
    // Get the file as ArrayBuffer
    const arrayBuffer = await response.arrayBuffer();
    
    // Process with SheetJS
    const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    // Convert to JSON with header: 1 to get raw rows
    const data = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1 });
    
    
    // Get headers from the first row
    const headers = data[0];
    
    // Find column indices for key fields
    const idIndex = findColumnIndex(headers, ['id', 'ID', 'text_id', 'text id']);
    const titleIndex = findColumnIndex(headers, ['ti_ar', 'title', 'Title', 'name', 'Name']);
    const authorIdIndex = findColumnIndex(headers, ['au_id', 'author_id', 'authorId']);
    const tagsIndex = findColumnIndex(headers, ['tags', 'Tags', 'genres', 'Genres']);
    const volumesIndex = findColumnIndex(headers, ['vols', 'volumes', 'Volumes', 'Vols']);
    
    
    // Check if required columns exist
    if (idIndex === -1) {
      throw new Error('Could not find ID column in texts.xlsx');
    }
    
    if (authorIdIndex === -1) {
      console.warn('Could not find author ID column in texts.xlsx');
    }
    
    // Create a map for quick lookups
    const textsMap = new Map<number, Text>();
    
    // Process each row (skip the header row)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      
      // Skip empty rows
      if (!row || row.length === 0) continue;
      
      // Get values with fallbacks
      const id = row[idIndex] !== undefined ? Number(row[idIndex]) : NaN;
      const au_id = authorIdIndex !== -1 && row[authorIdIndex] !== undefined 
        ? Number(row[authorIdIndex]) 
        : 0;
      
      // Skip rows with invalid IDs
      if (isNaN(id) || id === 0) {
        console.warn(`Skipping row ${i + 1} in texts.xlsx due to invalid ID`);
        continue;
      }
      
      // Process tags with careful handling
      let tags: string[] = [];
      if (tagsIndex !== -1 && row[tagsIndex]) {
        if (typeof row[tagsIndex] === 'string') {
          tags = row[tagsIndex].split(',').map((tag: string) => tag.trim()).filter(Boolean);
        } else if (Array.isArray(row[tagsIndex])) {
          tags = row[tagsIndex].filter((tag: any) => typeof tag === 'string');
        }
      }
      
      const text: Text = {
        id,
        title: titleIndex !== -1 && row[titleIndex] !== undefined ? String(row[titleIndex]) : '',
        au_id,
        tags,
        volumes: volumesIndex !== -1 && row[volumesIndex] !== undefined ? Number(row[volumesIndex]) : 1
      };
      
      // Add all raw fields from Excel for additional Arabic-specific data
      for (let j = 0; j < headers.length; j++) {
        if (j !== idIndex && j !== titleIndex && j !== authorIdIndex && j !== tagsIndex && j !== volumesIndex) {
          if (headers[j] && row[j] !== undefined) {
            (text as any)[headers[j]] = row[j];
          }
        }
      }
      
      textsMap.set(text.id, text);
    }
    
    return textsMap;
  } catch (error) {
    console.error('Failed to load texts metadata:', error);
    // Return an empty map but with one entry to prevent "No metadata loaded" error
    const fallbackMap = new Map<number, Text>();
    fallbackMap.set(0, {
      id: 0,
      title: 'Error loading texts',
      au_id: 0,
      tags: [],
      volumes: 1
    });
    return fallbackMap;
  }
};

/**
 * Load authors metadata from XLSX file
 */
export const loadAuthorsMetadata = async (): Promise<Map<number, Author>> => {
  try {
    // Fetch the XLSX file
    const response = await fetch('/authors.xlsx');
    if (!response.ok) {
      throw new Error(`Failed to fetch authors metadata: ${response.status} ${response.statusText}`);
    }
    
    // Get the file as ArrayBuffer
    const arrayBuffer = await response.arrayBuffer();
    
    // Process with SheetJS
    const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    // Get full raw data to see structure
    const rawData = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1 });
    
    // Find header row - it might not be the first row in some Excel files
    let headerRowIndex = 0;
    while (headerRowIndex < Math.min(10, rawData.length)) {
      const row = rawData[headerRowIndex];
      // Check if this looks like a header row (contains common column names)
      if (row && Array.isArray(row) && row.some(cell => 
        typeof cell === 'string' && 
        ['id', 'ID', 'au_id', 'author_id', 'au_ar', 'au_sh_ar', 'death'].some(h => 
          cell && cell.toString().toLowerCase().includes(h.toLowerCase())
        )
      )) {
        break;
      }
      headerRowIndex++;
    }
    
    // If we couldn't find a header row in the first 10 rows, assume it's the first row
    if (headerRowIndex >= 10) {
      headerRowIndex = 0;
    }
    
    
    // Get headers from the identified row
    const headers = rawData[headerRowIndex];
    
    // Find column indices for key fields
    const idIndex = findColumnIndex(headers, ['id', 'ID', 'au_id', 'author_id', 'المعرف']);
    
    // The primary name should be the Arabic short name (au_sh_ar) field
    const shortNameIndex = findColumnIndex(headers, ['au_sh_ar', 'authorShortArabic', 'الاسم المختصر']);
    
    // The full name is the au_ar field
    const fullNameIndex = findColumnIndex(headers, ['au_ar', 'authorArabic', 'الاسم الكامل', 'المؤلف']);
    
    // Regular name field is a fallback
    const nameIndex = findColumnIndex(headers, ['name', 'Name', 'author_name', 'authorName', 'الاسم']);
    
    const deathDateIndex = findColumnIndex(headers, ['death', 'death_date', 'Death', 'deathDate', 'تاريخ الوفاة', 'الوفاة']);
    const birthDateIndex = findColumnIndex(headers, ['birth', 'birth_date', 'Birth', 'birthDate', 'تاريخ الميلاد', 'الميلاد']);
    
    // Log found column indices for debugging

    // Check if required columns exist
    if (idIndex === -1) {
      // Generate sequence IDs if ID column is missing
      console.warn('Could not find ID column in authors.xlsx. Will generate sequence IDs.');
    }
    
    // Create a map for quick lookups
    const authorsMap = new Map<number, Author>();
    
    // Process each row (skip header rows)
    for (let i = headerRowIndex + 1; i < rawData.length; i++) {
      const row = rawData[i];
      
      // Skip empty rows
      if (!row || row.length === 0 || (Array.isArray(row) && row.every(cell => cell === undefined || cell === null))) {
        continue;
      }
      
      try {
        // Generate ID if missing
        let id: number;
        if (idIndex === -1 || row[idIndex] === undefined || row[idIndex] === null) {
          id = i; // Use row index as ID
        } else {
          id = Number(row[idIndex]);
          if (isNaN(id)) {
            id = i; // Fallback to row index if conversion fails
          }
        }
        
        // Get the most appropriate name
        let name = '';
        if (shortNameIndex !== -1 && row[shortNameIndex] !== undefined) {
          name = String(row[shortNameIndex]);
        } else if (fullNameIndex !== -1 && row[fullNameIndex] !== undefined) {
          name = String(row[fullNameIndex]);
        } else if (nameIndex !== -1 && row[nameIndex] !== undefined) {
          name = String(row[nameIndex]);
        } else {
          name = `المؤلف ${id}`;
        }
        
        let deathDate: number = 0;
        if (deathDateIndex !== -1 && row[deathDateIndex] !== undefined && row[deathDateIndex] !== null) {
          deathDate = Number(row[deathDateIndex]);
          if (isNaN(deathDate)) {
            // Try to extract number from string (e.g., "450 هـ" -> 450)
            const match = String(row[deathDateIndex]).match(/\d+/);
            deathDate = match ? Number(match[0]) : 0;
          }
        }
        
        let birthDate: number | undefined = undefined;
        if (birthDateIndex !== -1 && row[birthDateIndex] !== undefined && row[birthDateIndex] !== null) {
          birthDate = Number(row[birthDateIndex]);
          if (isNaN(birthDate)) {
            // Try to extract number from string (e.g., "370 هـ" -> 370)
            const match = String(row[birthDateIndex]).match(/\d+/);
            birthDate = match ? Number(match[0]) : undefined;
          }
        }
        
        const author: Author = {
          id,
          name,
          death_date: deathDate,
          birth_date: birthDate
        };
        
        // Add all raw fields from Excel for additional Arabic-specific data
        for (let j = 0; j < headers.length; j++) {
          if (j !== idIndex && j !== nameIndex && j !== deathDateIndex && j !== birthDateIndex) {
            if (headers[j] && row[j] !== undefined) {
              (author as any)[headers[j]] = row[j];
            }
          }
        }
        
        authorsMap.set(author.id, author);
      } catch (error) {
        console.warn(`Error processing author row ${i + 1}:`, error);
      }
    }
    
    
    // If no authors were loaded, create a fallback
    if (authorsMap.size === 0) {
      console.warn('No authors were loaded from Excel file, creating fallback entries');
      authorsMap.set(0, {
        id: 0,
        name: 'مؤلف غير معروف',
        death_date: 0
      });
    }
    
    return authorsMap;
  } catch (error) {
    console.error('Failed to load authors metadata:', error);
    // Return a map with at least one entry to prevent "No metadata loaded" error
    const fallbackMap = new Map<number, Author>();
    fallbackMap.set(0, {
      id: 0,
      name: 'مؤلف غير معروف',
      death_date: 0
    });
    return fallbackMap;
  }
};

/**
 * Get available genres from texts metadata
 */
export const getAvailableGenres = async (): Promise<string[]> => {
  try {
    const textsMap = await loadTextsMetadata();
    const genres = new Set<string>();
    
    textsMap.forEach((text) => {
      if (text.tags && Array.isArray(text.tags)) {
        text.tags.forEach((tag) => genres.add(tag));
      }
    });
    
    return Array.from(genres).sort();
  } catch (error) {
    console.error('Failed to get available genres:', error);
    return [];
  }
};

/**
 * Search authors by name
 */
export const searchAuthors = async (query: string): Promise<Author[]> => {
  try {
    if (!query.trim()) {
      return [];
    }
    
    const authorsMap = await loadAuthorsMetadata();
    const normalizedQuery = query.toLowerCase();
    
    const matchedAuthors = Array.from(authorsMap.values()).filter((author) => {
      // Search in name field
      const nameMatch = author.name.toLowerCase().includes(normalizedQuery);
      
      // Search in au_ar and au_sh_ar fields if available
      const auArMatch = (author as any).au_ar && 
                       (author as any).au_ar.toLowerCase().includes(normalizedQuery);
      const auShArMatch = (author as any).au_sh_ar && 
                         (author as any).au_sh_ar.toLowerCase().includes(normalizedQuery);
      
      return nameMatch || auArMatch || auShArMatch;
    });
    
    return matchedAuthors.slice(0, 100); // Limit to 100 results
  } catch (error) {
    console.error('Failed to search authors:', error);
    return [];
  }
};

/**
 * Utility function to find a column index from an array of possible column names
 */
function findColumnIndex(headers: any[], possibleNames: string[]): number {
  if (!headers || !Array.isArray(headers)) return -1;
  
  for (const name of possibleNames) {
    const index = headers.findIndex(h => 
      h !== undefined && 
      h !== null && 
      String(h).toLowerCase() === name.toLowerCase()
    );
    if (index !== -1) return index;
  }
  
  // If exact match not found, try partial match (for Arabic column names)
  for (const name of possibleNames) {
    const index = headers.findIndex(h => 
      h !== undefined && 
      h !== null && 
      String(h).toLowerCase().includes(name.toLowerCase())
    );
    if (index !== -1) return index;
  }
  
  return -1;
}