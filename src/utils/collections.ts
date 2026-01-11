/**
 * Collections Storage Layer
 *
 * Provides unified storage API for collections that works for both web and desktop:
 * - Web: Uses localStorage
 * - Desktop: Uses Tauri commands (SQLite)
 */

import type { Collection, CollectionEntry } from '../types/collections';
import { parseCollectionEntry } from '../types/collections';

// Check if we're in web mode
const isWebTarget = import.meta.env.VITE_TARGET === 'web';

// ============ LocalStorage Keys ============
const STORAGE_KEY = 'kashshaf_collections';

let collectionIdCounter = Date.now();

// ============ Web Storage Implementation ============

function getStoredCollections(): CollectionEntry[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const entries = JSON.parse(stored) as CollectionEntry[];
    // Update counter to be higher than any existing ID
    if (entries.length > 0) {
      collectionIdCounter = Math.max(collectionIdCounter, ...entries.map(e => e.id)) + 1;
    }
    return entries;
  } catch {
    return [];
  }
}

function setStoredCollections(entries: CollectionEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

// ============ Web Functions ============

async function webCreateCollection(
  name: string,
  bookIds: number[],
  description?: string
): Promise<Collection> {
  const entries = getStoredCollections();

  // Check for duplicate name
  if (entries.some(e => e.name === name)) {
    throw new Error(`Collection "${name}" already exists`);
  }

  const now = new Date().toISOString();
  const id = collectionIdCounter++;

  const newEntry: CollectionEntry = {
    id,
    name,
    description: description?.slice(0, 150) ?? null,
    book_ids: JSON.stringify(bookIds),
    created_at: now,
    updated_at: now,
  };

  entries.unshift(newEntry);
  setStoredCollections(entries);

  return parseCollectionEntry(newEntry);
}

async function webGetCollections(): Promise<Collection[]> {
  const entries = getStoredCollections();
  return entries.map(parseCollectionEntry);
}

async function webUpdateCollectionBooks(id: number, bookIds: number[]): Promise<void> {
  const entries = getStoredCollections();
  const index = entries.findIndex(e => e.id === id);

  if (index === -1) {
    throw new Error(`Collection with id ${id} not found`);
  }

  entries[index].book_ids = JSON.stringify(bookIds);
  entries[index].updated_at = new Date().toISOString();
  setStoredCollections(entries);
}

async function webUpdateCollectionDescription(id: number, description: string | null): Promise<void> {
  const entries = getStoredCollections();
  const index = entries.findIndex(e => e.id === id);

  if (index === -1) {
    throw new Error(`Collection with id ${id} not found`);
  }

  entries[index].description = description?.slice(0, 150) ?? null;
  entries[index].updated_at = new Date().toISOString();
  setStoredCollections(entries);
}

async function webRenameCollection(id: number, name: string): Promise<void> {
  const entries = getStoredCollections();
  const index = entries.findIndex(e => e.id === id);

  if (index === -1) {
    throw new Error(`Collection with id ${id} not found`);
  }

  // Check for duplicate name (excluding current collection)
  if (entries.some((e, i) => i !== index && e.name === name)) {
    throw new Error(`Collection "${name}" already exists`);
  }

  entries[index].name = name;
  entries[index].updated_at = new Date().toISOString();
  setStoredCollections(entries);
}

async function webDeleteCollection(id: number): Promise<void> {
  const entries = getStoredCollections();
  const filtered = entries.filter(e => e.id !== id);
  setStoredCollections(filtered);
}

// ============ Desktop Storage (Tauri) ============

let desktopTauri: typeof import('../api/tauri') | null = null;

async function getDesktopTauri() {
  if (!desktopTauri && !isWebTarget) {
    desktopTauri = await import('../api/tauri');
  }
  return desktopTauri;
}

// ============ Unified API ============

export async function createCollection(
  name: string,
  bookIds: number[],
  description?: string
): Promise<Collection> {
  if (isWebTarget) {
    return webCreateCollection(name, bookIds, description);
  }
  const tauri = await getDesktopTauri();
  return tauri!.createCollection(name, bookIds, description);
}

export async function getCollections(): Promise<Collection[]> {
  if (isWebTarget) {
    return webGetCollections();
  }
  const tauri = await getDesktopTauri();
  return tauri!.getCollections();
}

export async function updateCollectionBooks(id: number, bookIds: number[]): Promise<void> {
  if (isWebTarget) {
    return webUpdateCollectionBooks(id, bookIds);
  }
  const tauri = await getDesktopTauri();
  return tauri!.updateCollectionBooks(id, bookIds);
}

export async function updateCollectionDescription(id: number, description: string | null): Promise<void> {
  if (isWebTarget) {
    return webUpdateCollectionDescription(id, description);
  }
  const tauri = await getDesktopTauri();
  return tauri!.updateCollectionDescription(id, description);
}

export async function renameCollection(id: number, name: string): Promise<void> {
  if (isWebTarget) {
    return webRenameCollection(id, name);
  }
  const tauri = await getDesktopTauri();
  return tauri!.renameCollection(id, name);
}

export async function deleteCollection(id: number): Promise<void> {
  if (isWebTarget) {
    return webDeleteCollection(id);
  }
  const tauri = await getDesktopTauri();
  return tauri!.deleteCollection(id);
}
