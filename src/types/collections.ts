/**
 * Collection type definitions for saving named groups of texts
 */

export interface Collection {
  id: number;
  name: string;
  description: string | null;
  book_ids: number[];
  created_at: string;  // ISO timestamp
  updated_at: string;  // ISO timestamp
}

/**
 * Raw collection entry from storage (book_ids as JSON string)
 */
export interface CollectionEntry {
  id: number;
  name: string;
  description: string | null;
  book_ids: string;  // JSON array string: "[1, 2, 3]"
  created_at: string;
  updated_at: string;
}

/**
 * Convert raw CollectionEntry to Collection with parsed book_ids
 */
export function parseCollectionEntry(entry: CollectionEntry): Collection {
  return {
    ...entry,
    book_ids: JSON.parse(entry.book_ids) as number[],
  };
}

/**
 * Convert Collection to CollectionEntry with stringified book_ids
 */
export function serializeCollection(collection: Collection): CollectionEntry {
  return {
    ...collection,
    book_ids: JSON.stringify(collection.book_ids),
  };
}
