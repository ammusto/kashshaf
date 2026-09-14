import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMetadata } from '@kashshaf/shared';
import { isnadApi, pageLabel, type TransmitterListRow } from '../../api/isnad';
import { networkApi, type Graph, type NetNode, type Source } from '../../api/phase4';
import { VirtualTable, fmt, type Column } from '../stats/VirtualTable';

/**
 * The transmission network (spec §4.5, §7.7). Nodes are canonical persons
 * from confirmed isnāds with linked transmitters; an edge A → B means B
 * transmitted from A, weighted by count. A force layout on an SVG canvas
 * with a node cap and a minimum edge weight (both user-set); click a node
 * for its ego graph and its transmitter rows; "the author's direct
 * sources" lists the position-0 persons by count. Export CSV edge list or
 * GraphML.
 */

interface Props {
  book: BookMetadata | null;
}

interface Pos {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const W = 900;
const H = 620;

export function NetworkPanel({ book }: Props) {
  const bookId = book?.id ?? null;
  const [minWeight, setMinWeight] = useState(1);
  const [nodeCap, setNodeCap] = useState(300);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [ego, setEgo] = useState<Graph | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [rows, setRows] = useState<TransmitterListRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<number, Pos>>(new Map());
  const [running, setRunning] = useState(false);
  const frame = useRef<number | null>(null);

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
  }, [load]);

  const shown = ego ?? graph;

  // The force layout (spec §4.5): repulsion between every pair, springs on
  // edges, weak gravity to the centre; runs a bounded number of frames
  // whenever the shown graph changes, and settles.
  useEffect(() => {
    if (!shown) return;
    const ids = shown.nodes.map((n) => n.person_id);
    const pos = new Map<number, Pos>();
    ids.forEach((id, i) => {
      const prev = positions.get(id);
      const a = (i / Math.max(1, ids.length)) * Math.PI * 2;
      const r = Math.min(W, H) * 0.35;
      pos.set(id, prev ? { ...prev, vx: 0, vy: 0 } : { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0 });
    });
    const edges = shown.edges;
    let iter = 0;
    const maxIter = Math.min(300, 120 + ids.length);
    setRunning(true);
    const step = () => {
      const n = ids.length;
      const k = Math.sqrt((W * H) / Math.max(1, n));
      const temp = Math.max(0.5, 30 * (1 - iter / maxIter));
      const disp = new Map<number, { dx: number; dy: number }>();
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
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d * d) / k / Math.max(1, 2 / Math.sqrt(e.weight));
        const da = disp.get(e.from)!;
        const db = disp.get(e.to)!;
        da.dx -= (dx / d) * f;
        da.dy -= (dy / d) * f;
        db.dx += (dx / d) * f;
        db.dy += (dy / d) * f;
      }
      for (const id of ids) {
        const p = pos.get(id)!;
        const d = disp.get(id)!;
        // Gravity.
        d.dx += (W / 2 - p.x) * 0.02;
        d.dy += (H / 2 - p.y) * 0.02;
        const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy) || 0.01;
        const m = Math.min(len, temp);
        p.x = Math.min(W - 20, Math.max(20, p.x + (d.dx / len) * m));
        p.y = Math.min(H - 20, Math.max(20, p.y + (d.dy / len) * m));
      }
      iter += 1;
      setPositions(new Map(pos));
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

  const clickNode = async (n: NetNode) => {
    if (bookId == null) return;
    try {
      if (focus === n.person_id) {
        setEgo(null);
        setFocus(null);
        setRows([]);
        return;
      }
      const [e, t] = await Promise.all([networkApi.ego(bookId, n.person_id, minWeight), isnadApi.transmitters(bookId, true)]);
      setEgo(e);
      setFocus(n.person_id);
      setRows(t.filter((r) => r.person_id === n.person_id));
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

  const maxWeight = useMemo(() => Math.max(1, ...(shown?.edges.map((e) => e.weight) ?? [1])), [shown]);
  const nameOf = useMemo(() => new Map((shown?.nodes ?? []).map((n) => [n.person_id, n.name])), [shown]);

  const sourceColumns: Column<Source>[] = [
    { key: 'name', label: 'Person', sortValue: (r) => r.name, rtl: true, width: 'minmax(160px, 3fr)', render: (r) => r.name },
    { key: 'chains', label: 'Chains', sortValue: (r) => r.chains, align: 'right', width: '70px', defaultSort: 'desc', render: (r) => fmt(r.chains) },
  ];
  const rowColumns: Column<TransmitterListRow>[] = [
    { key: 'raw', label: 'Form', sortValue: (r) => r.raw, rtl: true, width: 'minmax(160px, 3fr)', render: (r) => r.raw },
    { key: 'verb', label: 'Verb', sortValue: (r) => r.verb_before ?? '', rtl: true, width: '70px', render: (r) => r.verb_before ?? '—' },
    { key: 'pos', label: 'Pos.', sortValue: (r) => r.position, align: 'right', width: '50px', render: (r) => String(r.position) },
    { key: 'page', label: 'Page', sortValue: (r) => r.part_index * 1_000_000 + r.page_id, width: '70px', render: (r) => pageLabel(r.part_index, r.page_id, book?.parts) },
  ];

  if (!book) {
    return <div className="p-6 text-sm text-app-text-tertiary">Choose a book in Books first.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-3 py-2 border-b border-app-border-light bg-app-surface flex items-center gap-3 flex-wrap text-xs">
        <label className="flex items-center gap-1" title="Edges lighter than this are hidden (spec §4.5)">
          min edge weight
          <input type="number" min={1} value={minWeight} onChange={(e) => setMinWeight(Math.max(1, Number(e.target.value) || 1))} className="w-14 border border-app-border-medium rounded px-1" aria-label="Min edge weight" />
        </label>
        <label className="flex items-center gap-1" title="At most this many nodes, by weighted degree (spec §4.5: 300)">
          node cap
          <input type="number" min={5} max={2000} value={nodeCap} onChange={(e) => setNodeCap(Math.max(5, Number(e.target.value) || 300))} className="w-16 border border-app-border-medium rounded px-1" aria-label="Node cap" />
        </label>
        {graph && (
          <span className="text-app-text-tertiary" data-testid="network-summary">
            {graph.chains} confirmed chains · {graph.nodes.length} persons · {graph.edges.length} edges
            {(graph.dropped_nodes > 0 || graph.dropped_edges > 0) && ` (${graph.dropped_nodes} persons, ${graph.dropped_edges} edges hidden)`}
          </span>
        )}
        {ego && focus != null && (
          <button onClick={() => { setEgo(null); setFocus(null); setRows([]); }} className="px-2 py-0.5 border border-app-border-medium rounded">
            ← whole book
          </button>
        )}
        {running && <span className="text-app-text-tertiary">laying out…</span>}
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
        <section className="flex-1 min-w-0 overflow-auto bg-app-surface">
          {shown && shown.nodes.length > 0 ? (
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" data-testid="network-canvas">
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#9CA3AF" />
                </marker>
              </defs>
              {shown.edges.map((e) => {
                const a = positions.get(e.from);
                const b = positions.get(e.to);
                if (!a || !b) return null;
                return (
                  <line key={`${e.from}-${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#9CA3AF" strokeWidth={1 + (3 * e.weight) / maxWeight} markerEnd="url(#arrow)" opacity={0.8}>
                    <title>
                      {nameOf.get(e.to)} ← {nameOf.get(e.from)} · {e.weight}
                    </title>
                  </line>
                );
              })}
              {shown.nodes.map((n) => {
                const p = positions.get(n.person_id);
                if (!p) return null;
                const r = 6 + Math.min(14, Math.sqrt(n.degree) * 2);
                return (
                  <g key={n.person_id} transform={`translate(${p.x},${p.y})`} onClick={() => void clickNode(n)} className="cursor-pointer" data-testid={`node-${n.person_id}`}>
                    <circle r={r} fill={n.person_id === focus ? '#2C5F8D' : n.as_source > 0 ? '#E8A33D' : '#6366F1'} stroke="#fff" strokeWidth={1.5} />
                    <text y={r + 12} textAnchor="middle" fontSize={11} className="font-arabic" fill="#1A1A1A">
                      {n.name}
                    </text>
                    <title>
                      {n.name} · {n.occurrences} occurrences · degree {n.degree}
                      {n.as_source > 0 ? ` · direct source ×${n.as_source}` : ''}
                    </title>
                  </g>
                );
              })}
            </svg>
          ) : (
            <div className="p-6 text-sm text-app-text-tertiary">
              {graph ? 'No confirmed isnāds with linked transmitters yet: confirm chains and link their transmitters in the Isnād workbench.' : 'Loading…'}
            </div>
          )}
        </section>
        <aside className="w-96 border-l border-app-border-light bg-app-surface flex flex-col min-h-0">
          <div className="px-3 py-1 text-xs text-app-text-tertiary border-b border-app-border-light">The author's direct sources (position 0)</div>
          <div className="p-2">
            <VirtualTable columns={sourceColumns} rows={sources} rowKey={(r) => r.person_id} height={220} onRowClick={(r) => void clickNode({ person_id: r.person_id, name: r.name, occurrences: 0, degree: 0, as_source: r.chains })} emptyText="No confirmed chains with a linked first transmitter." testId="network-sources" />
          </div>
          <div className="px-3 py-1 text-xs text-app-text-tertiary border-b border-t border-app-border-light">
            {focus != null ? `Transmitter rows of ${nameOf.get(focus) ?? sources.find((s) => s.person_id === focus)?.name ?? focus}` : 'Click a node for its transmitter rows'}
          </div>
          <div className="p-2 flex-1 min-h-0">
            <VirtualTable columns={rowColumns} rows={rows} rowKey={(r) => r.id} height={300} emptyText="—" testId="network-rows" />
          </div>
        </aside>
      </div>
    </div>
  );
}
