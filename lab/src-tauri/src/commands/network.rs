//! The transmission network commands (Lab spec §4.5, §7.7).
//!
//! Thin over `analysis::network`: the links come from `transmitter` rows
//! with a `person_id` in `isnad` rows with `status = 'confirmed'` for one
//! book; names from `person`. Exports go to `<lab dir>/exports/`.

use crate::analysis::network::{self, Graph, Link, Source};
use crate::commands::isnad::{db, dberr};
use crate::error::LabError;
use crate::state::{handles, Handles, ManagedLabState};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use tauri::State;

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, LabError> + Send + 'static) -> impl std::future::Future<Output = Result<T, LabError>> {
    async move { tokio::task::spawn_blocking(f).await.map_err(|e| LabError::Other(format!("task failed: {}", e)))? }
}

/// Linked transmitters of confirmed isnāds, and the names of every person
/// they point at.
fn links(conn: &Connection, book_id: u64) -> Result<(Vec<Link>, HashMap<i64, String>), LabError> {
    let mut stmt = conn
        .prepare(
            "SELECT t.isnad_id, t.position, t.person_id FROM transmitter t JOIN isnad i ON i.id = t.isnad_id \
             WHERE i.book_id = ?1 AND i.status = 'confirmed' AND t.person_id IS NOT NULL ORDER BY t.isnad_id, t.position",
        )
        .map_err(dberr)?;
    let links = stmt
        .query_map(params![book_id as i64], |r| Ok(Link { isnad_id: r.get(0)?, position: r.get::<_, i64>(1)? as usize, person_id: r.get(2)? }))
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    let mut names = HashMap::new();
    let mut stmt = conn.prepare("SELECT id, canonical_name FROM person").map_err(dberr)?;
    for r in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(dberr)? {
        let (id, n) = r.map_err(dberr)?;
        names.insert(id, n);
    }
    Ok((links, names))
}

fn whole(h: &Handles, book_id: u64) -> Result<(Graph, Vec<Link>, HashMap<i64, String>), LabError> {
    let conn = db(h)?;
    let (links, names) = links(&conn, book_id)?;
    Ok((network::build(&links, &names), links, names))
}

/// The book's graph with §4.5's view controls applied (node cap default
/// 300, minimum edge weight default 1).
#[tauri::command]
pub async fn network_graph(state: State<'_, ManagedLabState>, book_id: u64, min_weight: Option<usize>, node_cap: Option<usize>) -> Result<Graph, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let (g, _, _) = whole(&h, book_id)?;
        Ok(network::filter(&g, min_weight.unwrap_or(1), node_cap.unwrap_or(300)))
    })
    .await
}

/// One person's ego graph, at the given minimum edge weight, uncapped.
#[tauri::command]
pub async fn network_ego(state: State<'_, ManagedLabState>, book_id: u64, person_id: i64, min_weight: Option<usize>) -> Result<Graph, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let (g, _, _) = whole(&h, book_id)?;
        let f = network::filter(&g, min_weight.unwrap_or(1), usize::MAX);
        Ok(network::ego(&f, person_id))
    })
    .await
}

/// "The author's direct sources": position-0 persons by chain count.
#[tauri::command]
pub async fn network_sources(state: State<'_, ManagedLabState>, book_id: u64) -> Result<Vec<Source>, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let (_, links, names) = whole(&h, book_id)?;
        Ok(network::sources(&links, &names))
    })
    .await
}

/// CSV edge list or GraphML of the filtered graph, to `<lab dir>/exports/`.
#[tauri::command]
pub async fn network_export(state: State<'_, ManagedLabState>, book_id: u64, format: String, min_weight: Option<usize>, node_cap: Option<usize>) -> Result<String, LabError> {
    let h = handles(&state)?;
    blocking(move || {
        let (g, _, _) = whole(&h, book_id)?;
        let f = network::filter(&g, min_weight.unwrap_or(1), node_cap.unwrap_or(300));
        let (name, body) = match format.as_str() {
            "graphml" => (format!("book{}-network.graphml", book_id), network::graphml(&f)),
            _ => (format!("book{}-network-edges.csv", book_id), network::csv(&f)),
        };
        crate::commands::stats::save_export(name, body)
    })
    .await
}
