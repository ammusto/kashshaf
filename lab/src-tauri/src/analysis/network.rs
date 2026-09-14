//! The transmission network (Lab spec §4.5).
//!
//! Built only from **confirmed** isnāds whose transmitters are **linked**
//! to persons. A node is a canonical person; a directed edge `A → B` means
//! B transmitted from A — the two are adjacent links of one chain, A at the
//! higher position (earlier in transmission: nearer the source), B at the
//! lower (later: nearer the author) — weighted by how many chains carry it.
//! A chain with an unlinked transmitter between two linked ones has no edge
//! across the gap: adjacency is in the chain as extracted, not as linked.
//!
//! Pure functions over `Link` rows; the commands read them from
//! `analysis.db`, and the exports (CSV edge list, GraphML) are strings.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// One linked transmitter of a confirmed isnād.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub isnad_id: i64,
    /// 0 = nearest the author.
    pub position: usize,
    pub person_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Node {
    pub person_id: i64,
    pub name: String,
    /// Transmitter rows linked to this person in the graph's chains.
    pub occurrences: usize,
    /// Weighted degree: the sum of edge weights in and out.
    pub degree: usize,
    /// Chains where this person is the first link (position 0).
    pub as_source: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Edge {
    /// The earlier transmitter (nearer the source).
    pub from: i64,
    /// The later one, who transmitted from `from`.
    pub to: i64,
    pub weight: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// What the node cap and the weight filter left out.
    pub dropped_nodes: usize,
    pub dropped_edges: usize,
    /// Confirmed chains the graph was built from.
    pub chains: usize,
}

/// The whole graph of a book from its links, unfiltered.
pub fn build(links: &[Link], names: &HashMap<i64, String>) -> Graph {
    let mut by_chain: BTreeMap<i64, Vec<&Link>> = BTreeMap::new();
    for l in links {
        by_chain.entry(l.isnad_id).or_default().push(l);
    }
    let mut weights: HashMap<(i64, i64), usize> = HashMap::new();
    let mut occ: HashMap<i64, usize> = HashMap::new();
    let mut src: HashMap<i64, usize> = HashMap::new();
    for chain in by_chain.values_mut() {
        chain.sort_by_key(|l| l.position);
        for l in chain.iter() {
            *occ.entry(l.person_id).or_insert(0) += 1;
            if l.position == 0 {
                *src.entry(l.person_id).or_insert(0) += 1;
            }
        }
        for w in chain.windows(2) {
            let (later, earlier) = (w[0], w[1]);
            if earlier.position == later.position + 1 && earlier.person_id != later.person_id {
                *weights.entry((earlier.person_id, later.person_id)).or_insert(0) += 1;
            }
        }
    }
    let mut degree: HashMap<i64, usize> = HashMap::new();
    for (&(a, b), &w) in &weights {
        *degree.entry(a).or_insert(0) += w;
        *degree.entry(b).or_insert(0) += w;
    }
    let mut nodes: Vec<Node> = occ
        .iter()
        .map(|(&id, &n)| Node {
            person_id: id,
            name: names.get(&id).cloned().unwrap_or_else(|| format!("person {}", id)),
            occurrences: n,
            degree: degree.get(&id).copied().unwrap_or(0),
            as_source: src.get(&id).copied().unwrap_or(0),
        })
        .collect();
    nodes.sort_by(|a, b| b.degree.cmp(&a.degree).then_with(|| b.occurrences.cmp(&a.occurrences)).then_with(|| a.person_id.cmp(&b.person_id)));
    let mut edges: Vec<Edge> = weights.into_iter().map(|((from, to), weight)| Edge { from, to, weight }).collect();
    edges.sort_by(|a, b| b.weight.cmp(&a.weight).then_with(|| (a.from, a.to).cmp(&(b.from, b.to))));
    Graph { nodes, edges, dropped_nodes: 0, dropped_edges: 0, chains: by_chain.len() }
}

/// §4.5's view controls: edges below `min_weight` go, then the nodes are
/// capped at `node_cap` by weighted degree, and edges to dropped nodes go
/// with them. Isolated nodes (no edge left) are dropped too.
pub fn filter(g: &Graph, min_weight: usize, node_cap: usize) -> Graph {
    let min_weight = min_weight.max(1);
    let kept_edges: Vec<&Edge> = g.edges.iter().filter(|e| e.weight >= min_weight).collect();
    let mut degree: HashMap<i64, usize> = HashMap::new();
    for e in &kept_edges {
        *degree.entry(e.from).or_insert(0) += e.weight;
        *degree.entry(e.to).or_insert(0) += e.weight;
    }
    let mut nodes: Vec<Node> = g
        .nodes
        .iter()
        .filter(|n| degree.contains_key(&n.person_id))
        .map(|n| Node { degree: degree[&n.person_id], ..n.clone() })
        .collect();
    nodes.sort_by(|a, b| b.degree.cmp(&a.degree).then_with(|| b.occurrences.cmp(&a.occurrences)).then_with(|| a.person_id.cmp(&b.person_id)));
    let total_nodes = nodes.len();
    nodes.truncate(node_cap.max(1));
    let keep: HashSet<i64> = nodes.iter().map(|n| n.person_id).collect();
    let edges: Vec<Edge> = kept_edges.into_iter().filter(|e| keep.contains(&e.from) && keep.contains(&e.to)).cloned().collect();
    Graph {
        dropped_nodes: g.nodes.len() - nodes.len().min(total_nodes),
        dropped_edges: g.edges.len() - edges.len(),
        nodes,
        edges,
        chains: g.chains,
    }
}

/// The ego graph of one person: the node, everyone one edge away, and the
/// edges among them.
pub fn ego(g: &Graph, person_id: i64) -> Graph {
    let mut keep: HashSet<i64> = HashSet::new();
    keep.insert(person_id);
    for e in &g.edges {
        if e.from == person_id {
            keep.insert(e.to);
        }
        if e.to == person_id {
            keep.insert(e.from);
        }
    }
    let nodes: Vec<Node> = g.nodes.iter().filter(|n| keep.contains(&n.person_id)).cloned().collect();
    let edges: Vec<Edge> = g.edges.iter().filter(|e| keep.contains(&e.from) && keep.contains(&e.to)).cloned().collect();
    Graph { dropped_nodes: g.nodes.len() - nodes.len(), dropped_edges: g.edges.len() - edges.len(), nodes, edges, chains: g.chains }
}

/// "The author's direct sources" (§4.5): every person at position 0 of a
/// confirmed chain, by how many chains, most first.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Source {
    pub person_id: i64,
    pub name: String,
    pub chains: usize,
}

pub fn sources(links: &[Link], names: &HashMap<i64, String>) -> Vec<Source> {
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for l in links.iter().filter(|l| l.position == 0) {
        *counts.entry(l.person_id).or_insert(0) += 1;
    }
    let mut v: Vec<Source> = counts
        .into_iter()
        .map(|(id, n)| Source { person_id: id, name: names.get(&id).cloned().unwrap_or_else(|| format!("person {}", id)), chains: n })
        .collect();
    v.sort_by(|a, b| b.chains.cmp(&a.chains).then_with(|| a.name.cmp(&b.name)));
    v
}

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// CSV edge list: `from_id,from,to_id,to,weight` (A → B: B transmitted from A).
pub fn csv(g: &Graph) -> String {
    let name: HashMap<i64, &str> = g.nodes.iter().map(|n| (n.person_id, n.name.as_str())).collect();
    let mut out = String::from("from_id,from,to_id,to,weight\n");
    for e in &g.edges {
        out.push_str(&format!(
            "{},{},{},{},{}\n",
            e.from,
            csv_cell(name.get(&e.from).copied().unwrap_or("")),
            e.to,
            csv_cell(name.get(&e.to).copied().unwrap_or("")),
            e.weight
        ));
    }
    out
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// GraphML with `name`, `occurrences`, `as_source` on nodes and `weight` on
/// edges — what Gephi and yEd read.
pub fn graphml(g: &Graph) -> String {
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<graphml xmlns=\"http://graphml.graphdrawing.org/xmlns\">\n");
    out.push_str("  <key id=\"name\" for=\"node\" attr.name=\"name\" attr.type=\"string\"/>\n");
    out.push_str("  <key id=\"occurrences\" for=\"node\" attr.name=\"occurrences\" attr.type=\"int\"/>\n");
    out.push_str("  <key id=\"as_source\" for=\"node\" attr.name=\"as_source\" attr.type=\"int\"/>\n");
    out.push_str("  <key id=\"weight\" for=\"edge\" attr.name=\"weight\" attr.type=\"int\"/>\n");
    out.push_str("  <graph id=\"transmission\" edgedefault=\"directed\">\n");
    for n in &g.nodes {
        out.push_str(&format!(
            "    <node id=\"p{}\"><data key=\"name\">{}</data><data key=\"occurrences\">{}</data><data key=\"as_source\">{}</data></node>\n",
            n.person_id,
            xml(&n.name),
            n.occurrences,
            n.as_source
        ));
    }
    for (i, e) in g.edges.iter().enumerate() {
        out.push_str(&format!("    <edge id=\"e{}\" source=\"p{}\" target=\"p{}\"><data key=\"weight\">{}</data></edge>\n", i, e.from, e.to, e.weight));
    }
    out.push_str("  </graph>\n</graphml>\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> HashMap<i64, String> {
        [(1, "Abū Dāwūd"), (2, "Mālik"), (3, "Nāfiʿ"), (4, "Ibn ʿUmar"), (5, "Shuʿba")].into_iter().map(|(i, n)| (i, n.to_string())).collect()
    }

    fn link(isnad: i64, pos: usize, person: i64) -> Link {
        Link { isnad_id: isnad, position: pos, person_id: person }
    }

    #[test]
    fn edges_run_from_the_earlier_link_to_the_later_and_add_up() {
        // Chain 10: Abū Dāwūd ← Mālik ← Nāfiʿ ← Ibn ʿUmar; chain 11 the same
        // through Mālik; chain 12: Abū Dāwūd ← Shuʿba (unlinked gap) ← Nāfiʿ.
        let links = vec![
            link(10, 0, 1), link(10, 1, 2), link(10, 2, 3), link(10, 3, 4),
            link(11, 0, 1), link(11, 1, 2), link(11, 2, 3),
            link(12, 0, 1), link(12, 1, 5), link(12, 3, 3),
        ];
        let g = build(&links, &names());
        assert_eq!(g.chains, 3);
        let w = |a: i64, b: i64| g.edges.iter().find(|e| e.from == a && e.to == b).map(|e| e.weight);
        assert_eq!(w(2, 1), Some(2), "Abū Dāwūd transmitted from Mālik twice");
        assert_eq!(w(3, 2), Some(2));
        assert_eq!(w(4, 3), Some(1));
        assert_eq!(w(5, 1), Some(1));
        assert_eq!(w(3, 5), None, "the gap at position 2 breaks adjacency");
        assert_eq!(w(1, 2), None, "no reverse edges");
        let n1 = g.nodes.iter().find(|n| n.person_id == 1).unwrap();
        assert_eq!((n1.occurrences, n1.as_source, n1.degree), (3, 3, 3));
        assert_eq!(g.nodes[0].person_id, 2, "Mālik has the highest weighted degree (2 in + 2 out)");
        let s = sources(&links, &names());
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].person_id, s[0].chains), (1, 3));
    }

    #[test]
    fn filter_drops_light_edges_then_caps_nodes_and_ego_keeps_the_neighbourhood() {
        let links = vec![
            link(10, 0, 1), link(10, 1, 2), link(10, 2, 3), link(10, 3, 4),
            link(11, 0, 1), link(11, 1, 2), link(11, 2, 3),
            link(12, 0, 1), link(12, 1, 5),
        ];
        let g = build(&links, &names());
        let f = filter(&g, 2, 300);
        assert_eq!(f.edges.len(), 2, "{:?}", f.edges);
        assert_eq!(f.nodes.iter().map(|n| n.person_id).collect::<Vec<_>>(), vec![2, 1, 3], "by weighted degree (Mālik 4), then occurrences (Abū Dāwūd 3, Nāfiʿ 2)");
        assert!(f.dropped_nodes >= 2);
        let f = filter(&g, 1, 2);
        assert_eq!(f.nodes.len(), 2);
        assert!(f.edges.iter().all(|e| f.nodes.iter().any(|n| n.person_id == e.from) && f.nodes.iter().any(|n| n.person_id == e.to)));
        let e = ego(&g, 2);
        assert_eq!(e.nodes.iter().map(|n| n.person_id).collect::<std::collections::BTreeSet<_>>(), [1, 2, 3].into_iter().collect());
        assert_eq!(e.edges.len(), 2);
    }

    #[test]
    fn exports_carry_names_and_weights() {
        let links = vec![link(10, 0, 1), link(10, 1, 2)];
        let g = build(&links, &names());
        let c = csv(&g);
        assert_eq!(c, "from_id,from,to_id,to,weight\n2,Mālik,1,Abū Dāwūd,1\n");
        let x = graphml(&g);
        assert!(x.contains("<node id=\"p2\"><data key=\"name\">Mālik</data>"));
        assert!(x.contains("<edge id=\"e0\" source=\"p2\" target=\"p1\"><data key=\"weight\">1</data></edge>"));
        assert!(x.contains("edgedefault=\"directed\""));
    }
}
