/**
 * Table export (Lab spec §6.6): CSV with a UTF-8 BOM (so Excel opens Arabic
 * correctly) and JSON. Files go to Lab's `exports/` with a timestamped name
 * through the backend, and are also offered through the OS save dialog.
 */

import { labApi } from '../api/lab';

export interface ExportColumn<T> {
  key: string;
  label: string;
  value: (row: T) => string | number | null | undefined;
}

/** RFC 4180: quote when needed, double the quotes inside. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const BOM = '﻿';

export function toCsv<T>(columns: ExportColumn<T>[], rows: T[]): string {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(','));
  return BOM + [head, ...body].join('\r\n') + '\r\n';
}

export function toJson<T>(columns: ExportColumn<T>[], rows: T[]): string {
  const objs = rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, c.value(r) ?? null])));
  return JSON.stringify(objs, null, 2);
}

export type ExportFormat = 'csv' | 'json';

/**
 * Build the file, save it to `exports/`, then offer the OS dialog. The
 * dialog is best-effort: in a test or a browser there is none, and the
 * `exports/` copy is the one the user can always find.
 */
export async function exportTable<T>(
  baseName: string,
  format: ExportFormat,
  columns: ExportColumn<T>[],
  rows: T[]
): Promise<{ path: string; savedAs: string | null }> {
  const contents = format === 'csv' ? toCsv(columns, rows) : toJson(columns, rows);
  const name = `${baseName}.${format}`;
  const path = await labApi.saveExport(name, contents);
  let savedAs: string | null = null;
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const chosen = await save({
      defaultPath: name,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (chosen) {
      await writeTextFile(chosen, contents);
      savedAs = chosen;
    }
  } catch {
    // No dialog available; the exports/ copy stands.
  }
  return { path, savedAs };
}
