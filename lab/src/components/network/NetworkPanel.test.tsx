import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import type { BookMetadata } from '@kashshaf/shared';

/**
 * The network panel against a mocked bridge (spec §4.5, §7.7): the graph
 * loads with the view controls, changing them reloads, a node click opens
 * its ego graph and its transmitter rows, the sources table lists
 * position-0 persons, and export goes through the backend.
 */

const api = vi.hoisted(() => {
  const network = {
    graph: vi.fn(),
    ego: vi.fn(),
    nodeRows: vi.fn(),
    sources: vi.fn(),
    export: vi.fn(async () => 'C:/lab/exports/book527-network-edges.csv'),
  };
  const isnad = {
    transmitters: vi.fn(),
  };
  const lab = {
    listPages: vi.fn(async (): Promise<unknown[]> => []),
    runSize: vi.fn(async () => ({ book_id: 0, pages: 1, book_pages: 1, tokens: 10, book_tokens: 10 })),
    statsPause: vi.fn(async () => {}),
  };
  return { network, isnad, lab };
});

vi.mock('../../api/lab', () => ({ labApi: api.lab }));

vi.mock('../../api/phase4', async () => {
  const real = await vi.importActual<typeof import('../../api/phase4')>('../../api/phase4');
  return { ...real, networkApi: api.network };
});
vi.mock('../../api/isnad', async () => {
  const real = await vi.importActual<typeof import('../../api/isnad')>('../../api/isnad');
  return { ...real, isnadApi: api.isnad };
});

import { NetworkPanel } from './NetworkPanel';

const book: BookMetadata = { id: 527, title: 'الزهد', in_corpus: true, parts: 1 };

// Two linked persons and one transmitter nobody has linked yet, which is a
// node of its own keyed by its normalised form (spec 1.5 J2).
// The wire shape (see network.rs): a person id is a bare number, a name
// form a bare string. Reading these as tagged objects is what crashed the
// panel on every unlinked transmitter.
const P = (n: number) => n;
const F = (f: string) => f;

const graph = {
  chains: 3,
  dropped_nodes: 0,
  dropped_edges: 0,
  nodes: [
    { id: P(1), person_id: 1, linked: true, name: 'أبو داود', occurrences: 3, degree: 3, as_source: 3 },
    { id: P(2), person_id: 2, linked: true, name: 'مالك', occurrences: 2, degree: 4, as_source: 0 },
    { id: F('نافع'), person_id: null, linked: false, name: 'نافع', occurrences: 2, degree: 2, as_source: 0 },
  ],
  edges: [
    { from: P(2), to: P(1), weight: 2 },
    { from: F('نافع'), to: P(2), weight: 2 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.network.graph.mockResolvedValue(graph);
  api.network.sources.mockResolvedValue([{ id: P(1), person_id: 1, linked: true, name: 'أبو داود', chains: 3 }]);
  api.network.ego.mockResolvedValue({ ...graph, nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1), dropped_nodes: 1, dropped_edges: 1 });
  api.network.nodeRows.mockImplementation(async (_b: number, node: number | string) =>
    node === 2 ? [rows[0]] : typeof node === 'string' ? [rows[2]] : [rows[1]]
  );
  api.isnad.transmitters.mockResolvedValue(rows);
});

const rows = [
    { id: 11, isnad_id: 1, position: 1, tok_start: 5, tok_end: 6, raw: 'مالك', kunya: null, ism: 'مالك', nasab: null, nisba: null, laqab: null, verb_before: 'نا', person_id: 2, form_norm: 'مالك', suggested_person_id: null, part_index: 0, page_id: 9, place: null, isnad_status: 'confirmed', form_count: 2, person_name: 'مالك', suggested_person_name: null },
  { id: 12, isnad_id: 1, position: 0, tok_start: 1, tok_end: 3, raw: 'ابو داود', kunya: 'ابو داود', ism: null, nasab: null, nisba: null, laqab: null, verb_before: 'حدثنا', person_id: 1, form_norm: 'ابو داود', suggested_person_id: null, part_index: 0, page_id: 9, place: null, isnad_status: 'confirmed', form_count: 3, person_name: 'أبو داود', suggested_person_name: null },
  { id: 13, isnad_id: 1, position: 2, tok_start: 8, tok_end: 9, raw: 'نافع', kunya: null, ism: 'نافع', nasab: null, nisba: null, laqab: null, verb_before: 'عن', person_id: null, form_norm: 'نافع', suggested_person_id: null, part_index: 0, page_id: 9, place: null, isnad_status: 'confirmed', form_count: 2, person_name: null, suggested_person_name: null },
];

describe('NetworkPanel', () => {
  it('asks for a text first', () => {
    render(<NetworkPanel book={null} />);
    expect(screen.getByText(/Open a text from the workspace/)).toBeInTheDocument();
  });

  it('draws the graph with the view controls and lists the direct sources', async () => {
    render(<NetworkPanel book={book} />);
    await waitFor(() => expect(api.network.graph).toHaveBeenCalledWith(527, 1, 300));
    expect(await screen.findByTestId('network-summary')).toHaveTextContent('3 confirmed chains · 3 transmitters (2 linked) · 2 edges');
    const canvas = await screen.findByTestId('network-canvas');
    expect(canvas.querySelectorAll('line').length).toBe(2);
    expect(canvas.querySelectorAll('circle').length).toBe(3);
    expect(screen.getByTestId('network-sources')).toHaveTextContent('أبو داود');
    // The controls reload the graph.
    fireEvent.change(screen.getByLabelText('Min edge weight'), { target: { value: '2' } });
    await waitFor(() => expect(api.network.graph).toHaveBeenLastCalledWith(527, 2, 300));
    fireEvent.change(screen.getByLabelText('Node cap'), { target: { value: '50' } });
    await waitFor(() => expect(api.network.graph).toHaveBeenLastCalledWith(527, 2, 50));
  });

  it('a node click opens the ego graph and the transmitter rows; export goes through the backend', async () => {
    render(<NetworkPanel book={book} />);
    const canvas = await screen.findByTestId('network-canvas');
    await waitFor(() => expect(canvas.querySelectorAll('circle').length).toBe(3));
    // An unlinked transmitter is a node like any other, drawn apart (J2).
    expect(screen.getByTestId('node-f:نافع')).toHaveAttribute('data-linked', 'false');
    expect(screen.getByTestId('node-p1')).toHaveAttribute('data-linked', 'true');

    fireEvent.click(screen.getByTestId('node-p2'));
    await waitFor(() => expect(api.network.ego).toHaveBeenCalledWith(527, 2, 1));
    await waitFor(() => expect(screen.getByTestId('network-canvas').querySelectorAll('circle').length).toBe(2));
    await waitFor(() => expect(screen.getByTestId('network-rows')).toHaveTextContent('مالك'));
    expect(screen.getByTestId('network-rows')).not.toHaveTextContent('ابو داود');
    // The ego view says so, with the way out in it (9 A).
    const banner = screen.getByTestId('ego-banner');
    expect(banner).toHaveTextContent('and their neighbours only');
    expect(banner).toHaveTextContent('2 of 3 transmitters');
    expect(banner).toHaveTextContent('1 of 2 edges');
    expect(within(banner).getByTestId('show-whole-text')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'GraphML' }));
    await waitFor(() => expect(api.network.export).toHaveBeenCalledWith(527, 'graphml', 1, 300));
    expect(await screen.findByRole('status')).toHaveTextContent('Exported to');
  });

  it('says how many sources there are, how many forms are unlinked, and which are not drawn (9 A)', async () => {
    // One source is a chain of one transmitter, so it has no edge and the
    // drawing cannot hold it. The list still names it, and says why.
    api.network.sources.mockResolvedValue([
      { id: P(1), person_id: 1, linked: true, name: 'أبو داود', chains: 3 },
      { id: F('عطية'), person_id: null, linked: false, name: 'عطية', chains: 1 },
    ]);
    render(<NetworkPanel book={book} />);
    const list = await screen.findByTestId('network-sources');
    expect(await screen.findByTestId('sources-heading')).toHaveTextContent('direct sources (position 0) · 2');
    expect(list).toHaveTextContent('not drawn');
    // And a linked one is not marked.
    expect(within(list).getByText('أبو داود').textContent).not.toContain('not drawn');

    // One of the three nodes is a bare name form, which is what fragments a
    // chain before anyone is linked.
    expect(screen.getByTestId('unlinked-count')).toHaveTextContent('1 unlinked name form');
  });

  it('shows one sentence and nothing else when nothing is confirmed (spec 1.5 J3)', async () => {
    api.network.graph.mockResolvedValue({ chains: 0, dropped_nodes: 0, dropped_edges: 0, nodes: [], edges: [] });
    api.network.sources.mockResolvedValue([]);
    render(<NetworkPanel book={book} />);
    expect(await screen.findByTestId('network-empty')).toHaveTextContent('Confirm at least one isnād to build a network.');
    // No controls over an empty canvas.
    expect(screen.queryByLabelText('Min edge weight')).toBeNull();
    expect(screen.queryByTestId('network-canvas')).toBeNull();
    expect(screen.queryByRole('button', { name: 'GraphML' })).toBeNull();
  });

  it('draws a graph of unlinked transmitters alone without crashing (A1)', async () => {
    // The crash: every node id was a bare string, and the panel read it as
    // `{ Form: ... }`. A book where nothing is linked yet is the common case
    // on first use, so it is the one that broke.
    api.network.graph.mockResolvedValue({
      chains: 2,
      dropped_nodes: 0,
      dropped_edges: 0,
      nodes: [
        { id: F('الجنيد'), person_id: null, linked: false, name: 'الجنيد', occurrences: 2, degree: 1, as_source: 2 },
        { id: F('مالك'), person_id: null, linked: false, name: 'مالك', occurrences: 1, degree: 1, as_source: 0 },
      ],
      edges: [{ from: F('الجنيد'), to: F('مالك'), weight: 1 }],
    });
    api.network.sources.mockResolvedValue([
      { id: F('الجنيد'), person_id: null, linked: false, name: 'الجنيد', chains: 2 },
    ]);
    render(<NetworkPanel book={book} />);
    const canvas = await screen.findByTestId('network-canvas');
    await waitFor(() => expect(canvas.querySelectorAll('circle').length).toBe(2));
    expect(screen.getByTestId('node-f:الجنيد')).toHaveAttribute('data-linked', 'false');
    expect(screen.getByTestId('network-summary')).toHaveTextContent('2 transmitters (0 linked)');
    expect(screen.queryByTestId('panel-error')).toBeNull();
  });

  // ------------------------------------------------------ the canvas (8 C) ---

  /** jsdom has no PointerEvent, and React only reads the mouse fields. `act`
   *  is what flushes the state the handler sets. */
  function pointer(target: EventTarget, type: string, init: MouseEventInit) {
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
  }

  const level = () => Number((screen.getByTestId('zoom-level').textContent ?? '').replace('%', ''));
  const viewport = () => screen.getByTestId('network-viewport').getAttribute('transform') ?? '';

  it('fills the panel rather than drawing in a fixed box', async () => {
    render(<NetworkPanel book={book} />);
    const canvas = await screen.findByTestId('network-canvas');
    // No viewBox and no width or height: the SVG is whatever the panel is.
    expect(canvas).not.toHaveAttribute('viewBox');
    expect(canvas).not.toHaveAttribute('width');
    expect(canvas).not.toHaveAttribute('height');
    expect(canvas.getAttribute('class')).toContain('w-full');
    expect(canvas.getAttribute('class')).toContain('h-full');
    // Everything drawn sits under one transform, which is the view.
    expect(viewport()).toMatch(/translate\(-?[\d.]+,-?[\d.]+\) scale\([\d.]+\)/);
  });

  it('zooms on the wheel, on the buttons, and back to life size on reset', async () => {
    render(<NetworkPanel book={book} />);
    const canvas = await screen.findByTestId('network-canvas');

    // The first wheel also takes the view off auto-fit, so the reading after
    // it is the baseline.
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 100, clientY: 100 });
    const first = level();
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 100, clientY: 100 });
    expect(level()).toBeGreaterThan(first);

    const before = level();
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(level()).toBe(Math.round(before * 1.3));
    fireEvent.click(screen.getByLabelText('Zoom out'));
    expect(level()).toBeCloseTo(before, 0);

    fireEvent.click(screen.getByTestId('zoom-reset'));
    expect(level()).toBe(100);
  });

  it('pans on a drag of the background, and fits on demand', async () => {
    render(<NetworkPanel book={book} />);
    const canvas = await screen.findByTestId('network-canvas');
    fireEvent.click(screen.getByTestId('zoom-reset'));
    const start = viewport();

    pointer(canvas, 'pointerdown', { button: 0, clientX: 0, clientY: 0 });
    pointer(window, 'pointermove', { clientX: 40, clientY: 25 });
    pointer(window, 'pointerup', { clientX: 40, clientY: 25 });
    const panned = viewport();
    expect(panned).not.toBe(start);
    expect(panned).toContain('scale(1)');

    // Fit puts it back over the graph at a scale that holds all of it.
    fireEvent.click(screen.getByTestId('zoom-fit'));
    expect(viewport()).not.toBe(panned);
    expect(level()).toBeGreaterThan(0);
  });

  it('drops the labels once they would be too small to read', async () => {
    render(<NetworkPanel book={book} />);
    const canvas = await screen.findByTestId('network-canvas');
    fireEvent.click(screen.getByTestId('zoom-reset'));
    expect(canvas.querySelectorAll('text').length).toBe(3);

    // 11px type at anything under about 64% is a smudge.
    const out = screen.getByLabelText('Zoom out');
    while (level() > 60) fireEvent.click(out);
    expect(canvas.querySelectorAll('text').length).toBe(0);
    // The nodes themselves stay.
    expect(canvas.querySelectorAll('circle').length).toBe(3);
  });

  it('finds a person by name and puts them in the middle', async () => {
    render(<NetworkPanel book={book} />);
    await screen.findByTestId('network-canvas');
    fireEvent.click(screen.getByTestId('zoom-reset'));
    const before = viewport();

    // Typed without the hamza, as a reader would.
    fireEvent.change(screen.getByTestId('network-search'), { target: { value: 'ابو داود' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(screen.getByTestId('node-p1')).toHaveAttribute('data-found', 'true');
    expect(viewport()).not.toBe(before);

    fireEvent.change(screen.getByTestId('network-search'), { target: { value: 'سفيان' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByRole('status')).toHaveTextContent('No one in this graph');
    expect(screen.queryByTestId('node-p1')).not.toHaveAttribute('data-found');
  });

  it('redraws when the workbench says something was confirmed (spec 1.5 J1)', async () => {
    const { rerender } = render(<NetworkPanel book={book} version={0} />);
    await waitFor(() => expect(api.network.graph).toHaveBeenCalledTimes(1));
    rerender(<NetworkPanel book={book} version={1} />);
    await waitFor(() => expect(api.network.graph).toHaveBeenCalledTimes(2));
  });
});
