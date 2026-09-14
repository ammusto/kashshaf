import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VirtualTable, fmt, type Column } from './VirtualTable';

interface Row {
  key: string;
  n: number;
}

const rows: Row[] = [
  { key: 'ب', n: 2 },
  { key: 'أ', n: 10 },
  { key: 'ج', n: 5 },
];

const columns: Column<Row>[] = [
  { key: 'key', label: 'Key', sortValue: (r) => r.key, rtl: true },
  { key: 'n', label: 'N', sortValue: (r) => r.n, align: 'right', defaultSort: 'desc', render: (r) => fmt(r.n) },
];

describe('VirtualTable', () => {
  it('renders rows on first paint, sorted by the default column', () => {
    render(<VirtualTable columns={columns} rows={rows} rowKey={(r) => r.key} />);
    const cells = screen.getAllByRole('cell').map((c) => c.textContent);
    // Three rows × two columns, N descending: 10, 5, 2.
    expect(cells).toEqual(['أ', '10', 'ج', '5', 'ب', '2']);
  });

  it('toggles the sort direction and sorts by another column', () => {
    render(<VirtualTable columns={columns} rows={rows} rowKey={(r) => r.key} />);
    fireEvent.click(screen.getByRole('columnheader', { name: /N/ }));
    expect(screen.getAllByRole('cell').map((c) => c.textContent)).toEqual(['ب', '2', 'ج', '5', 'أ', '10']);
    fireEvent.click(screen.getByRole('columnheader', { name: /Key/ }));
    // A fresh column starts descending: ج, ب, أ.
    expect(screen.getAllByRole('cell').map((c) => c.textContent)).toEqual(['ج', '5', 'ب', '2', 'أ', '10']);
  });

  it('reports the clicked row and shows the empty text', () => {
    const onRowClick = vi.fn();
    render(<VirtualTable columns={columns} rows={rows} rowKey={(r) => r.key} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('ج'));
    expect(onRowClick).toHaveBeenCalledWith({ key: 'ج', n: 5 });
    render(<VirtualTable columns={columns} rows={[]} rowKey={(r) => r.key} emptyText="Nothing here." />);
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('formats numbers for cells', () => {
    expect(fmt(1234)).toBe('1,234');
    expect(fmt(0.5)).toBe('0.5');
    expect(fmt(2.345, 2)).toBe('2.35');
    expect(fmt(null)).toBe('—');
  });
});
