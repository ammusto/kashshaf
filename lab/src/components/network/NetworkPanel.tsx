import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { normalizeArabicForSearch } from '@kashshaf/shared';
import type { TransmitterListRow } from '../../api/isnad';
import { usePages } from '../../api/pages';
import { networkApi, nodeKey, sameNode, type Graph, type NodeId, type Source } from '../../api/phase4';
import { VirtualTable, fmt, type Column } from '../stats/VirtualTable';

/**
 * The transmission network (spec §4.5, §7.7; Phase 8 C). Nodes are canonical
 * persons from confirmed isnāds with linked transmitters; an edge A → B means
 * B transmitted from A, weighted by count. A force layout on an SVG canvas
 * with a node cap and a minimum edge weight (both user-set); click a node for
 * its ego graph and its transmitter rows; "the author's direct sources" lists
 * the position-0 persons by count. Export CSV edge list or GraphML.
 *
 * The canvas fills the panel and the layout runs in unbounded coordinates.
 * The view on it is one transform — scale `k`, offset `x, y` — which the
 * wheel, a drag, the buttons and the search box all move. Nothing is clamped
 * to a box, so a graph too big for the window is a matter of zooming out
 * rather than of nodes piling up on the border.
 */

interface Props {
  book: BookMetadata | null;
  /**
   * Bumped by the isnad workbench when something is confirmed or linked, so
   * the graph follows the work rather than waiting to be reloaded (spec §J1).
   */
  version?: number;
}

interface Pos {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** screen = world · k + (x, y). */
interface View {
  k: number;
  x: number;
  y: number;
}

const MIN_K = 0.05;
const MAX_K = 8;
/** Ideal edge length, in world units. The space is unbounded, so this is the
 *  only thing that sets the scale of the drawing. */
const SPRING = 90;
/** A label smaller than this on screen is a smudge, so it is not drawn. */
const MIN_LABEL_PX = 7;
const LABEL_SIZE = 11;

export function NetworkPanel({ book, version = 0 }: Props) {
  const bookId = book?.id ?? null;
  const labels = usePages(bookId, book?.parts);
  const [minWeight, setMinWeight] = useState(1);
  const [nodeCap, setNodeCap] = useState(300);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [ego, setEgo] = useState<Graph | null>(null);
  const [focus, setFocus] = useState<NodeId | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [rows, setRows] = useState<TransmitterListRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, Pos>>(new Map());
  const [running, setRunning] = useState(false);
  const frame = useRef<number | null>(null);

  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<string | null>(null);
  const box = useRef<HTMLElement | null>(null);
  const size = useRef({ w: 900, h: 620 });
  const posRef = useRef<Map<string, Pos>>(new Map());
  /** True until the reader takes the view over, so a settling layout stays framed. */
  const autoFit = useRef(true);
  const dragged = useRef(false);

  const load = useCallback(async () => {
    if (bookId == null) return;
    try {
      const [g, s] = await Promise.all([networkApi.graph(bookId, minWeight, nodeCap), networkApi.sources(bookId)]);
      setGraph(g);
      setSources(s);
      setEgo(null);
      setFocus(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [bookId, minWeight, nodeCap]);

  useEffect(() => {
    setGraph(null);
    setEgo(null);
    setFocus(null);
    setRows([]);
    void load();
    // `version` is the workbench's signal that a chain was confirmed or a
    // transmitter linked (spec §J1).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, version]);

  const shown = ego ?? graph;

  // ------------------------------------------------------------ the view ---

  // The canvas is whatever size the panel gives it. jsdom reports zero, so
  // fall back to something with an aspect ratio rather than dividing by it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      size.current = { w: el.clientWidth || 900, h: el.clientHeight || 620 };
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);

  /** The view that puts every node on screen with a margin. */
  const fitView = useCallback((pos: Map<string, Pos>): View | null => {
    if (pos.size === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pos.values()) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const { w, h } = size.current;
    // Room for the node radius and its label, which are not in the bounds.
    const pad = 60;
    const k = clamp(Math.min(w / Math.max(1, x1 - x0 + pad * 2), h / Math.max(1, y1 - y0 + pad * 2)), MIN_K, 1.5);
    return { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
  }, []);

  const fit = useCallback(() => {
    const v = fitView(posRef.current);
    if (v) setView(v);
  }, [fitView]);

  /** Zoom about a point in the canvas, so what is under it stays under it. */
  const zoomAbout = useCallback((px: number, py: number, factor: number) => {
    autoFit.current = false;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      if (k === v.k) return v;
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  }, []);

  const zoomByButton = (factor: number) => zoomAbout(size.current.w / 2, size.current.h / 2, factor);

  /** Back to life size, centred on the middle of the graph. */
  const resetView = () => {
    autoFit.current = false;
    const { w, h } = size.current;
    const v = fitView(posRef.current);
    if (!v) return setView({ k: 1, x: w / 2, y: h / 2 });
    // The world point the fit put in the middle, now at k = 1.
    const cx = (w / 2 - v.x) / v.k;
    const cy = (h / 2 - v.y) / v.k;
    setView({ k: 1, x: w / 2 - cx, y: h / 2 - cy });
  };

  // React registers `wheel` passively at the root, so the handler has to be a
  // native one to be allowed to swallow the scroll.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // A trackpad pinch arrives as a wheel with ctrlKey, and wants a
      // sharper response than a mouse wheel.
      const rate = e.ctrlKey ? 0.01 : 0.0015;
      zoomAbout(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * rate));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAbout, shown]);

  /** Drag the background to pan; a drag over a node is still a pan, but it
   *  must not also count as a click on it. */
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    dragged.current = false;
    const origin = view;
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      if (!dragged.current && Math.abs(dx) + Math.abs(dy) > 3) {
        dragged.current = true;
        autoFit.current = false;
      }
      if (dragged.current) setView({ k: origin.k, x: origin.x + dx, y: origin.y + dy });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------------------------------------------------------- the layout ---

  // The force layout (spec §4.5): repulsion between every pair, springs on
  // edges, weak gravity to the origin; runs a bounded number of frames
  // whenever the shown graph changes, and settles. Nothing is clamped: the
  // drawing is as big as it needs to be and the view is what moves.
  useEffect(() => {
    if (!shown) return;
    const ids = shown.nodes.map((n) => nodeKey(n.id));
    const pos = new Map<string, Pos>();
    const ring = Math.max(150, 25 * Math.sqrt(ids.length));
    ids.forEach((id, i) => {
      const prev = positions.get(id);
      const a = (i / Math.max(1, ids.length)) * Math.PI * 2;
      pos.set(id, prev ? { ...prev, vx: 0, vy: 0 } : { x: Math.cos(a) * ring, y: Math.sin(a) * ring, vx: 0, vy: 0 });
    });
    const edges = shown.edges;
    let iter = 0;
    const maxIter = Math.min(300, 120 + ids.length);
    autoFit.current = true;
    setRunning(true);
    const step = () => {
      const n = ids.length;
      const k = SPRING;
      const temp = Math.max(0.5, 30 * (1 - iter / maxIter));
      const disp = new Map<string, { dx: number; dy: number }>();
      ids.forEach((id) => disp.set(id, { dx: 0, dy: 0 }));
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = pos.get(ids[i])!;
          const b = pos.get(ids[j])!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          if (d < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d = 0.01;
          }
          const f = (k * k) / d;
          const da = disp.get(ids[i])!;
          const db = disp.get(ids[j])!;
          da.dx += (dx / d) * f;
          da.dy += (dy / d) * f;
          db.dx -= (dx / d) * f;
          db.dy -= (dy / d) * f;
        }
      }
      for (const e of edges) {
        const ka = nodeKey(e.from);
        const kb = nodeKey(e.to);
        const a = pos.get(ka);
        const b = pos.get(kb);
        if (!a || !b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d * d) / k / Math.max(1, 2 / Math.sqrt(e.weight));
        const da = disp.get(ka)!;
        const db = disp.get(kb)!;
        da.dx -= (dx / d) * f;
        da.dy -= (dy / d) * f;
        db.dx += (dx / d) * f;
        db.dy += (dy / d) * f;
      }
      for (const id of ids) {
        const p = pos.get(id)!;
        const d = disp.get(id)!;
        // Gravity, which is all that holds the drawing together now that
        // there is no border to hold it in.
        d.dx += -p.x * 0.02;
        d.dy += -p.y * 0.02;
        const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy) || 0.01;
        const m = Math.min(len, temp);
        p.x += (d.dx / len) * m;
        p.y += (d.dy / len) * m;
      }
      iter += 1;
      posRef.current = new Map(pos);
      setPositions(posRef.current);
      // Keep it framed while it settles, unless the reader has taken over.
      if (autoFit.current) {
        const v = fitView(pos);
        if (v) setView(v);
      }
      if (iter < maxIter) {
        frame.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(step) : (setTimeout(step, 16) as unknown as number);
      } else {
        setRunning(false);
      }
    };
    step();
    return () => {
      if (frame.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current);
      setRunning(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  // ---------------------------------------------------------------- data ---

  const clickNode = async (id: NodeId) => {
    if (bookId == null) return;
    // The pointer was panning, not picking.
    if (dragged.current) return;
    try {
      if (focus && sameNode(focus, id)) {
        setEgo(null);
        setFocus(null);
        setRows([]);
        return;
      }
      const [e, t] = await Promise.all([networkApi.ego(bookId, id, minWeight), networkApi.nodeRows(bookId, id)]);
      setEgo(e);
      setFocus(id);
      setRows(t);
    } catch (err) {
      setError(String(err));
    }
  };

  const exportGraph = async (format: 'csv' | 'graphml') => {
    if (bookId == null) return;
    try {
      setMessage(`Exported to ${await networkApi.export(bookId, format, minWeight, nodeCap)}`);
    } catch (e) {
      setError(String(e));
    }
  };

  /** Find a person by name and put them in the middle of the canvas. */
  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const needle = normalizeArabicForSearch(query.trim());
    if (!needle || !shown) return;
    const hit = shown.nodes.find((n) => normalizeArabicForSearch(n.name).includes(needle));
    if (!hit) {
      setFound(null);
      setMessage(`No one in this graph is called "${query.trim()}".`);
      return;
    }
    const key = nodeKey(hit.id);
    const p = posRef.current.get(key);
    setFound(key);
    setMessage(null);
    if (!p) return;
    autoFit.current = false;
    // Close enough to read the name, but not so close that the neighbours go.
    setView((v) => {
      const k = Math.max(v.k, 0.9);
      return { k, x: size.current.w / 2 - p.x * k, y: size.current.h / 2 - p.y * k };
    });
  };

  const maxWeight = useMemo(() => Math.max(1, ...(shown?.edges.map((e) => e.weight) ?? [1])), [shown]);
  const nameOf = useMemo(() => new Map((shown?.nodes ?? []).map((n) => [nodeKey(n.id), n.name])), [shown]);

  const sourceColumns: Column<Source>[] = [
    {
      key: 'name',
      label: 'Person',
      sortValue: (r) => r.name,
      rtl: true,
      width: 'minmax(160px, 3fr)',
      render: (r) => (
        <span className={r.linked ? '' : 'text-app-text-secondary italic'} title={r.linked ? undefined : 'Not yet linked to a person'}>
          {r.name}
        </span>
      ),
    },
    { key: 'chains', label: 'Chains', sortValue: (r) => r.chains, align: 'right', width: '70px', defaultSort: 'desc', render: (r) => fmt(r.chains) },
  ];
  const rowColumns: Column<TransmitterListRow>[] = [
    { key: 'raw', label: 'Form', sortValue: (r) => r.raw, rtl: true, width: 'minmax(160px, 3fr)', render: (r) => r.raw },
    { key: 'verb', label: 'Verb', sortValue: (r) => r.verb_before ?? '', rtl: true, width: '70px', render: (r) => r.verb_before ?? '—' },
    { key: 'pos', label: 'Pos.', sortValue: (r) => r.position, align: 'right', width: '50px', render: (r) => String(r.position) },
    { key: 'page', label: 'Page', sortValue: (r) => r.part_index * 1_000_000 + r.page_id, width: '70px', render: (r) => labels.label(r.part_index, r.page_id) },
  ];

  if (!book) {
    return <div className="flex-1 p-6 text-sm text-app-text-secondary">Open a text from the workspace first.</div>;
  }

  // Spec §J3: with nothing confirmed there is no network, and a panel of
  // controls over an empty canvas only invites fiddling with them.
  if (graph && graph.chains === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6" data-testid="network-empty">
        <p className="text-sm text-app-text-secondary">Confirm at least one isnād to build a network.</p>
      </div>
    );
  }

  const labelsVisible = view.k * LABEL_SIZE >= MIN_LABEL_PX;

  return (
    <div className="flex-1 min-w-0 flex min-h-0 flex-col" data-testid="network-panel">
      <div className="px-3 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-3 flex-wrap text-xs">
        <label className="flex items-center gap-1" title="Edges lighter than this are hidden (spec §4.5)">
          min edge weight
          <input type="number" min={1} value={minWeight} onChange={(e) => setMinWeight(Math.max(1, Number(e.target.value) || 1))} className="w-14 border border-app-border-medium rounded px-1" aria-label="Min edge weight" />
        </label>
        <label className="flex items-center gap-1" title="At most this many nodes, by weighted degree (spec §4.5: 300)">
          node cap
          <input type="number" min={5} max={2000} value={nodeCap} onChange={(e) => setNodeCap(Math.max(5, Number(e.target.value) || 300))} className="w-16 border border-app-border-medium rounded px-1" aria-label="Node cap" />
        </label>
        <form onSubmit={search} className="flex items-center gap-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a person…"
            aria-label="Find a person"
            dir="rtl"
            className="w-40 font-arabic border border-app-border-medium rounded px-1 py-0.5"
            data-testid="network-search"
          />
          <button type="submit" className="px-2 py-0.5 border border-app-border-medium rounded">
            Find
          </button>
        </form>
        {graph && (
          <span className="text-app-text-secondary" data-testid="network-summary">
            {graph.chains} confirmed chain{graph.chains === 1 ? '' : 's'} · {graph.nodes.length} transmitter
            {graph.nodes.length === 1 ? '' : 's'} ({graph.nodes.filter((n) => n.linked).length} linked) · {graph.edges.length} edges
            {(graph.dropped_nodes > 0 || graph.dropped_edges > 0) && ` (${graph.dropped_nodes} nodes, ${graph.dropped_edges} edges hidden)`}
          </span>
        )}
        {ego && focus && (
          <button onClick={() => { setEgo(null); setFocus(null); setRows([]); }} className="px-2 py-0.5 border border-app-border-medium rounded">
            ← whole text
          </button>
        )}
        {running && <span className="text-app-text-secondary">laying out…</span>}
        <span className="ml-auto flex items-center gap-1">
          <button onClick={() => exportGraph('csv')} className="px-2 py-0.5 border border-app-border-medium rounded">
            CSV edges
          </button>
          <button onClick={() => exportGraph('graphml')} className="px-2 py-0.5 border border-app-border-medium rounded">
            GraphML
          </button>
        </span>
      </div>
      {(error || message) && (
        <div className={`px-3 py-1 text-xs border-b border-app-border-light ${error ? 'text-app-error' : 'text-app-text-secondary'}`} role={error ? 'alert' : 'status'}>
          {error ?? message}
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <section ref={box} className="relative flex-1 min-w-0 overflow-hidden bg-app-surface touch-none">
          {shown && shown.nodes.length > 0 ? (
            <>
              <svg className="w-full h-full block cursor-grab active:cursor-grabbing" onPointerDown={onPointerDown} data-testid="network-canvas">
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#9CA3AF" />
                  </marker>
                </defs>
                <g transform={`translate(${view.x},${view.y}) scale(${view.k})`} data-testid="network-viewport">
                  {shown.edges.map((e) => {
                    const ka = nodeKey(e.from);
                    const kb = nodeKey(e.to);
                    const a = positions.get(ka);
                    const b = positions.get(kb);
                    if (!a || !b) return null;
                    return (
                      <line
                        key={`${ka}-${kb}`}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke="#9CA3AF"
                        strokeWidth={1 + (3 * e.weight) / maxWeight}
                        vectorEffect="non-scaling-stroke"
                        markerEnd="url(#arrow)"
                        opacity={0.8}
                      >
                        <title>
                          {nameOf.get(kb)} ← {nameOf.get(ka)} · {e.weight}
                        </title>
                      </line>
                    );
                  })}
                  {shown.nodes.map((n) => {
                    const key = nodeKey(n.id);
                    const p = positions.get(key);
                    if (!p) return null;
                    const r = 6 + Math.min(14, Math.sqrt(n.degree) * 2);
                    const isFocus = !!focus && sameNode(focus, n.id);
                    const isFound = found === key;
                    // Spec §J2: a transmitter nobody has linked yet is a node all
                    // the same, drawn hollow and dashed so it reads as a name and
                    // not as a person, and labelled with the form as written.
                    return (
                      <g
                        key={key}
                        transform={`translate(${p.x},${p.y})`}
                        onClick={() => void clickNode(n.id)}
                        className="cursor-pointer"
                        data-testid={`node-${key}`}
                        data-linked={n.linked ? 'true' : 'false'}
                        data-found={isFound ? 'true' : undefined}
                      >
                        {isFound && <circle r={r + 6} fill="none" stroke="#E8A33D" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
                        <circle
                          r={r}
                          fill={n.linked ? (isFocus ? '#2C5F8D' : n.as_source > 0 ? '#E8A33D' : '#6366F1') : isFocus ? '#BFD3E6' : '#FFFFFF'}
                          stroke={n.linked ? '#fff' : isFocus ? '#2C5F8D' : '#9CA3AF'}
                          strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke"
                          strokeDasharray={n.linked ? undefined : '3 2'}
                        />
                        {labelsVisible && (
                          <text y={r + 12} textAnchor="middle" fontSize={LABEL_SIZE} className="font-arabic" fill={n.linked ? '#1A1A1A' : '#6B7280'}>
                            {n.name}
                          </text>
                        )}
                        <title>
                          {n.name} · {n.occurrences} occurrences · degree {n.degree}
                          {n.as_source > 0 ? ` · direct source ×${n.as_source}` : ''}
                          {n.linked ? '' : ' · not yet linked to a person'}
                        </title>
                      </g>
                    );
                  })}
                </g>
              </svg>

              <div className="absolute bottom-3 left-3 flex items-center gap-1 text-xs bg-app-surface/90 border border-app-border-light rounded px-1 py-0.5">
                <button onClick={() => zoomByButton(1 / 1.3)} aria-label="Zoom out" className="px-2 py-0.5 hover:bg-app-surface-variant rounded">
                  −
                </button>
                <span className="w-12 text-center tabular-nums text-app-text-secondary" data-testid="zoom-level">
                  {Math.round(view.k * 100)}%
                </span>
                <button onClick={() => zoomByButton(1.3)} aria-label="Zoom in" className="px-2 py-0.5 hover:bg-app-surface-variant rounded">
                  +
                </button>
                <button onClick={resetView} className="px-2 py-0.5 hover:bg-app-surface-variant rounded" data-testid="zoom-reset">
                  Reset
                </button>
                <button
                  onClick={() => {
                    autoFit.current = false;
                    fit();
                  }}
                  className="px-2 py-0.5 hover:bg-app-surface-variant rounded"
                  data-testid="zoom-fit"
                >
                  Fit
                </button>
              </div>
            </>
          ) : (
            <div className="p-6 text-sm text-app-text-secondary">
              {graph ? 'Every node is hidden at this minimum edge weight.' : 'Loading…'}
            </div>
          )}
        </section>
        <aside className="w-96 border-l border-app-border-light bg-app-surface flex flex-col min-h-0">
          <div className="px-3 py-1 text-xs text-app-text-secondary border-b border-app-border-light">The author's direct sources (position 0)</div>
          <div className="p-2">
            <VirtualTable
              columns={sourceColumns}
              rows={sources}
              rowKey={(r) => nodeKey(r.id)}
              height={220}
              onRowClick={(r) => void clickNode(r.id)}
              emptyText="No confirmed chain names its first transmitter."
              testId="network-sources"
            />
          </div>
          <div className="px-3 py-1 text-xs text-app-text-secondary border-b border-t border-app-border-light">
            {focus
              ? `Transmitter rows of ${nameOf.get(nodeKey(focus)) ?? sources.find((s) => sameNode(s.id, focus))?.name ?? ''}`
              : 'Click a node for its transmitter rows'}
          </div>
          <div className="p-2 flex-1 min-h-0">
            <VirtualTable columns={rowColumns} rows={rows} rowKey={(r) => r.id} height={300} emptyText="—" testId="network-rows" />
          </div>
        </aside>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
