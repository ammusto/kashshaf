//! The transmission network (Lab spec §4.5).
//!
//! Built from **confirmed** isnāds (spec 1.5 §J1): every confirmed chain is
//! in the graph, and one is enough to draw a path.
//!
//! A node is a canonical **person** where a transmitter is linked to one, and
//! otherwise the transmitter's own normalised **name form** (spec §J2), drawn
//! in its own style and labelled with the raw form. Linking merges nodes:
//! that is what the authority file adds to the picture, not what gates it.
//! A directed edge `A → B` means B transmitted from A — the two are adjacent
//! links of one chain, A at the higher position (earlier in transmission:
//! nearer the source), B at the lower (later: nearer the author) — weighted
//! by how many chains carry it.
//!
//! Pure functions over `Link` rows; the commands read them from
//! `analysis.db`, and the exports (CSV edge list, GraphML) are strings.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// One transmitter of a confirmed isnād.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub isnad_id: i64,
    /// 0 = nearest the author.
    pub position: usize,
    /// The person it is linked to, when it is linked.
    pub person_id: Option<i64>,
    /// `names::form_norm(raw)` — the node key when it is not (spec §J2).
    pub form_norm: String,
    /// What the label shows for an unlinked node.
    pub raw: String,
}

/// How a transmitter becomes a node: a linked one is its person, an unlinked
/// one is its own name form.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NodeId {
    Person(i64),
    Form(String),
}

impl Link {
    fn node(&self) -> NodeId {
        match self.person_id {
            Some(p) => NodeId::Person(p),
            None => NodeId::Form(self.form_norm.clone()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Node {
    pub id: NodeId,
    /// The person's id when the node is one, for the transmitter-row lookup.
    pub person_id: Option<i64>,
    /// Whether the node is a named person or a bare name form (spec §J2).
    pub linked: bool,
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
    pub from: NodeId,
    /// The later one, who transmitted from `from`.
    pub to: NodeId,
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

/// The whole graph of a book from its transmitters, unfiltered.
pub fn build(links: &[Link], names: &HashMap<i64, String>) -> Graph {
    let mut by_chain: BTreeMap<i64, Vec<&Link>> = BTreeMap::new();
    for l in links {
        by_chain.entry(l.isnad_id).or_default().push(l);
    }
    let mut weights: HashMap<(NodeId, NodeId), usize> = HashMap::new();
    let mut occ: HashMap<NodeId, usize> = HashMap::new();
    let mut src: HashMap<NodeId, usize> = HashMap::new();
    let mut label: HashMap<NodeId, String> = HashMap::new();
    for chain in by_chain.values_mut() {
        chain.sort_by_key(|l| l.position);
        for l in chain.iter() {
            let node = l.node();
            *occ.entry(node.clone()).or_insert(0) += 1;
            if l.position == 0 {
                *src.entry(node.clone()).or_insert(0) += 1;
            }
            label.entry(node).or_insert_with(|| match l.person_id {
                Some(p) => names.get(&p).cloned().unwrap_or_else(|| format!("person {}", p)),
                None => l.raw.clone(),
            });
        }
        for w in chain.windows(2) {
            let (later, earlier) = (w[0], w[1]);
            if earlier.position == later.position + 1 && earlier.node() != later.node() {
                *weights.entry((earlier.node(), later.node())).or_insert(0) += 1;
            }
        }
    }
    let mut degree: HashMap<NodeId, usize> = HashMap::new();
    for ((a, b), w) in &weights {
        *degree.entry(a.clone()).or_insert(0) += w;
        *degree.entry(b.clone()).or_insert(0) += w;
    }
    let mut nodes: Vec<Node> = occ
        .iter()
        .map(|(id, &n)| Node {
            person_id: match id {
                NodeId::Person(p) => Some(*p),
                NodeId::Form(_) => None,
            },
            linked: matches!(id, NodeId::Person(_)),
            name: label.get(id).cloned().unwrap_or_default(),
            occurrences: n,
            degree: degree.get(id).copied().unwrap_or(0),
            as_source: src.get(id).copied().unwrap_or(0),
            id: id.clone(),
        })
        .collect();
    nodes.sort_by(|a, b| b.degree.cmp(&a.degree).then_with(|| b.occurrences.cmp(&a.occurrences)).then_with(|| a.id.cmp(&b.id)));
    let mut edges: Vec<Edge> = weights.into_iter().map(|((from, to), weight)| Edge { from, to, weight }).collect();
    edges.sort_by(|a, b| b.weight.cmp(&a.weight).then_with(|| (&a.from, &a.to).cmp(&(&b.from, &b.to))));
    Graph { nodes, edges, dropped_nodes: 0, dropped_edges: 0, chains: by_chain.len() }
}

/// §4.5's view controls: edges below `min_weight` go, then the nodes are
/// capped at `node_cap` by weighted degree, and edges to dropped nodes go
/// with them. Isolated nodes (no edge left) are dropped too.
pub fn filter(g: &Graph, min_weight: usize, node_cap: usize) -> Graph {
    let min_weight = min_weight.max(1);
    let kept_edges: Vec<&Edge> = g.edges.iter().filter(|e| e.weight >= min_weight).collect();
    let mut degree: HashMap<NodeId, usize> = HashMap::new();
    for e in &kept_edges {
        *degree.entry(e.from.clone()).or_insert(0) += e.weight;
        *degree.entry(e.to.clone()).or_insert(0) += e.weight;
    }
    let mut nodes: Vec<Node> = g
        .nodes
        .iter()
        .filter(|n| degree.contains_key(&n.id))
        .map(|n| Node { degree: degree[&n.id], ..n.clone() })
        .collect();
    nodes.sort_by(|a, b| b.degree.cmp(&a.degree).then_with(|| b.occurrences.cmp(&a.occurrences)).then_with(|| a.id.cmp(&b.id)));
    let total_nodes = nodes.len();
    nodes.truncate(node_cap.max(1));
    let keep: HashSet<NodeId> = nodes.iter().map(|n| n.id.clone()).collect();
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
pub fn ego(g: &Graph, node: &NodeId) -> Graph {
    let mut keep: HashSet<NodeId> = HashSet::new();
    keep.insert(node.clone());
    for e in &g.edges {
        if &e.from == node {
            keep.insert(e.to.clone());
        }
        if &e.to == node {
            keep.insert(e.from.clone());
        }
    }
    let nodes: Vec<Node> = g.nodes.iter().filter(|n| keep.contains(&n.id)).cloned().collect();
    let edges: Vec<Edge> = g.edges.iter().filter(|e| keep.contains(&e.from) && keep.contains(&e.to)).cloned().collect();
    Graph { dropped_nodes: g.nodes.len() - nodes.len(), dropped_edges: g.edges.len() - edges.len(), nodes, edges, chains: g.chains }
}

/// "The author's direct sources" (§4.5): every person at position 0 of a
/// confirmed chain, by how many chains, most first.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Source {
    pub id: NodeId,
    pub person_id: Option<i64>,
    pub linked: bool,
    pub name: String,
    pub chains: usize,
}

pub fn sources(links: &[Link], names: &HashMap<i64, String>) -> Vec<Source> {
    let mut counts: HashMap<NodeId, (usize, String, Option<i64>)> = HashMap::new();
    for l in links.iter().filter(|l| l.position == 0) {
        let label = match l.person_id {
            Some(p) => names.get(&p).cloned().unwrap_or_else(|| format!("person {}", p)),
            None => l.raw.clone(),
        };
        let e = counts.entry(l.node()).or_insert((0, label, l.person_id));
        e.0 += 1;
    }
    let mut v: Vec<Source> = counts
        .into_iter()
        .map(|(id, (n, name, person_id))| Source { linked: matches!(id, NodeId::Person(_)), id, person_id, name, chains: n })
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
    let name: HashMap<&NodeId, &str> = g.nodes.iter().map(|n| (&n.id, n.name.as_str())).collect();
    let mut out = String::from("from_id,from,to_id,to,weight\n");
    for e in &g.edges {
        out.push_str(&format!(
            "{},{},{},{},{}\n",
            csv_cell(&key(&e.from)),
            csv_cell(name.get(&e.from).copied().unwrap_or("")),
            csv_cell(&key(&e.to)),
            csv_cell(name.get(&e.to).copied().unwrap_or("")),
            e.weight
        ));
    }
    out
}

/// A node's stable key for an export: `p<id>` for a person, `f:<form>` for a
/// bare name form (spec 1.5 J2).
pub fn key(id: &NodeId) -> String {
    match id {
        NodeId::Person(p) => format!("p{}", p),
        NodeId::Form(f) => format!("f:{}", f),
    }
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
    out.push_str("  <key id=\"linked\" for=\"node\" attr.name=\"linked\" attr.type=\"boolean\"/>\n");
    out.push_str("  <key id=\"weight\" for=\"edge\" attr.name=\"weight\" attr.type=\"int\"/>\n");
    out.push_str("  <graph id=\"transmission\" edgedefault=\"directed\">\n");
    for n in &g.nodes {
        out.push_str(&format!(
            "    <node id=\"{}\"><data key=\"name\">{}</data><data key=\"occurrences\">{}</data><data key=\"as_source\">{}</data><data key=\"linked\">{}</data></node>\n",
            xml(&key(&n.id)),
            xml(&n.name),
            n.occurrences,
            n.as_source,
            n.linked
        ));
    }
    for (i, e) in g.edges.iter().enumerate() {
        out.push_str(&format!(
            "    <edge id=\"e{}\" source=\"{}\" target=\"{}\"><data key=\"weight\">{}</data></edge>\n",
            i,
            xml(&key(&e.from)),
            xml(&key(&e.to)),
            e.weight
        ));
    }
    out.push_str("  </graph>\n</graphml>\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire shape the frontend parses. `#[serde(untagged)]` over two
    /// newtype variants serialises to the inner value, so a person is a bare
    /// number and a form is a bare string, not `{"Person": 7}`. The panel
    /// assumed the tagged shape and crashed on the first unlinked
    /// transmitter it drew, so the contract is pinned here.
    #[test]
    fn a_node_id_is_a_bare_number_or_a_bare_string() {
        assert_eq!(serde_json::to_string(&NodeId::Person(7)).unwrap(), "7");
        assert_eq!(
            serde_json::to_string(&NodeId::Form("الجنيد".to_string())).unwrap(),
            "\"الجنيد\""
        );
        // and back, so the id in an ego request round-trips
        assert_eq!(serde_json::from_str::<NodeId>("7").unwrap(), NodeId::Person(7));
        assert_eq!(
            serde_json::from_str::<NodeId>("\"malik\"").unwrap(),
            NodeId::Form("malik".into())
        );
    }

    /// A graph with both kinds of node, as the panel receives it: neither id
    /// is an object.
    #[test]
    fn a_graph_carries_both_node_kinds_on_the_wire() {
        let links = vec![
            Link { isnad_id: 1, position: 0, person_id: Some(1), form_norm: "abu dawud".into(), raw: "Abu Dawud".into() },
            Link { isnad_id: 1, position: 1, person_id: None, form_norm: "junayd".into(), raw: "al-Junayd".into() },
        ];
        let g = build(&links, &names());
        let json = serde_json::to_value(&g).unwrap();
        let ids: Vec<&serde_json::Value> =
            json["nodes"].as_array().unwrap().iter().map(|n| &n["id"]).collect();
        assert!(ids.iter().any(|v| v.is_number()), "a linked node is a number: {ids:?}");
        assert!(ids.iter().any(|v| v.is_string()), "an unlinked node is a string: {ids:?}");
        assert!(ids.iter().all(|v| !v.is_object()), "no node id is an object: {ids:?}");
    }

    fn names() -> HashMap<i64, String> {
        [(1, "Abu Dawud"), (2, "Malik"), (3, "Nafi"), (4, "Ibn Umar"), (5, "Shuba")]
            .into_iter()
            .map(|(i, n)| (i, n.to_string()))
            .collect()
    }

    fn link(isnad: i64, pos: usize, person: i64) -> Link {
        Link { isnad_id: isnad, position: pos, person_id: Some(person), form_norm: String::new(), raw: String::new() }
    }

    /// An unlinked transmitter: its own node, keyed by the normalised form.
    fn unlinked(isnad: i64, pos: usize, form: &str) -> Link {
        Link { isnad_id: isnad, position: pos, person_id: None, form_norm: form.to_string(), raw: form.to_string() }
    }

    fn p(id: i64) -> NodeId {
        NodeId::Person(id)
    }

    #[test]
    fn edges_run_from_the_earlier_link_to_the_later_and_add_up() {
        // Chain 10: Abu Dawud <- Malik <- Nafi <- Ibn Umar; chain 11 the same
        // through Malik; chain 12: Abu Dawud <- Shuba, then a gap, then Nafi.
        let links = vec![
            link(10, 0, 1), link(10, 1, 2), link(10, 2, 3), link(10, 3, 4),
            link(11, 0, 1), link(11, 1, 2), link(11, 2, 3),
            link(12, 0, 1), link(12, 1, 5), link(12, 3, 3),
        ];
        let g = build(&links, &names());
        assert_eq!(g.chains, 3);
        let w = |a: i64, b: i64| g.edges.iter().find(|e| e.from == p(a) && e.to == p(b)).map(|e| e.weight);
        assert_eq!(w(2, 1), Some(2), "Abu Dawud transmitted from Malik twice");
        assert_eq!(w(3, 2), Some(2));
        assert_eq!(w(4, 3), Some(1));
        assert_eq!(w(5, 1), Some(1));
        assert_eq!(w(3, 5), None, "the gap at position 2 breaks adjacency");
        assert_eq!(w(1, 2), None, "no reverse edges");
        let n1 = g.nodes.iter().find(|n| n.person_id == Some(1)).unwrap();
        assert_eq!((n1.occurrences, n1.as_source, n1.degree), (3, 3, 3));
        assert!(n1.linked);
        assert_eq!(g.nodes[0].person_id, Some(2), "Malik has the highest weighted degree (2 in + 2 out)");
        let s = sources(&links, &names());
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].person_id, s[0].chains), (Some(1), 3));
    }

    /// Spec 1.5 J2: an unlinked transmitter is its own node, and linking two
    /// occurrences of one form to a person merges them.
    #[test]
    fn unlinked_transmitters_are_nodes_of_their_own_and_linking_merges_them() {
        let links = vec![
            link(10, 0, 1), unlinked(10, 1, "malik"), unlinked(10, 2, "nafi"),
            link(11, 0, 1), unlinked(11, 1, "malik"),
        ];
        let g = build(&links, &names());
        assert_eq!(g.chains, 2);
        assert_eq!(g.nodes.len(), 3, "{:?}", g.nodes.iter().map(|n| &n.name).collect::<Vec<_>>());
        let malik = g.nodes.iter().find(|n| n.id == NodeId::Form("malik".into())).expect("the form is a node");
        assert!(!malik.linked);
        assert_eq!(malik.name, "malik", "an unlinked node is labelled with its raw form");
        assert_eq!(malik.occurrences, 2, "both chains' occurrences are the same node");
        let w = |from: NodeId, to: NodeId| g.edges.iter().find(|e| e.from == from && e.to == to).map(|e| e.weight);
        assert_eq!(w(NodeId::Form("malik".into()), p(1)), Some(2));
        assert_eq!(w(NodeId::Form("nafi".into()), NodeId::Form("malik".into())), Some(1));

        // One confirmed isnad is enough to draw a path (spec J2).
        let one = build(&[link(1, 0, 1), unlinked(1, 1, "x")], &names());
        assert_eq!(one.nodes.len(), 2);
        assert_eq!(one.edges.len(), 1);

        // Linking both occurrences to person 2 merges them into that node.
        let linked = vec![link(10, 0, 1), link(10, 1, 2), link(11, 0, 1), link(11, 1, 2)];
        let g2 = build(&linked, &names());
        assert!(g2.nodes.iter().all(|n| n.linked));
        assert_eq!(g2.nodes.iter().find(|n| n.person_id == Some(2)).unwrap().occurrences, 2);
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
        assert_eq!(
            f.nodes.iter().map(|n| n.person_id.unwrap()).collect::<Vec<_>>(),
            vec![2, 1, 3],
            "by weighted degree (Malik 4), then occurrences"
        );
        assert!(f.dropped_nodes >= 2);
        let f = filter(&g, 1, 2);
        assert_eq!(f.nodes.len(), 2);
        assert!(f.edges.iter().all(|e| f.nodes.iter().any(|n| n.id == e.from) && f.nodes.iter().any(|n| n.id == e.to)));
        let e = ego(&g, &p(2));
        assert_eq!(
            e.nodes.iter().map(|n| n.person_id.unwrap()).collect::<std::collections::BTreeSet<_>>(),
            [1, 2, 3].into_iter().collect()
        );
        assert_eq!(e.edges.len(), 2);
    }

    #[test]
    fn exports_carry_names_and_weights() {
        let links = vec![link(10, 0, 1), link(10, 1, 2), unlinked(10, 2, "majhul")];
        let g = build(&links, &names());
        let c = csv(&g);
        assert!(c.starts_with("from_id,from,to_id,to,weight\n"), "{}", c);
        assert!(c.contains("p2,Malik,p1,Abu Dawud,1"), "{}", c);
        assert!(c.contains("f:majhul,majhul,p2,Malik,1"), "{}", c);
        let x = graphml(&g);
        assert!(x.contains("<node id=\"p2\"><data key=\"name\">Malik</data>"));
        assert!(x.contains("<data key=\"linked\">false</data>"));
        assert!(x.contains("<edge id=\"e0\" source=\"p2\" target=\"p1\"><data key=\"weight\">1</data></edge>"));
        assert!(x.contains("edgedefault=\"directed\""));
    }
}
