//! Kashshaf Lab — Tauri entry point.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use kashshaf_lab_lib::{commands, state::LabState, ManagedLabState};
use std::sync::{Arc, RwLock};

fn main() {
    // Mode detection happens before the window opens so the badge is right on
    // the first frame (spec §2.4). It never fails: a Lab with neither a local
    // corpus nor a reachable server still opens and says why.
    let state = LabState::resolve();
    eprintln!(
        "[lab {}] mode={:?} corpus={:?} lab_dir={:?}",
        kashshaf_lab_lib::LAB_VERSION,
        state.status.mode,
        state.status.corpus_version,
        state.status.lab_dir
    );
    if let Some(e) = &state.status.local_error {
        eprintln!("[lab] local corpus unavailable: {}", e);
    }
    if let Some(e) = &state.status.api_error {
        eprintln!("[lab] api unavailable: {}", e);
    }
    let managed: ManagedLabState = Arc::new(RwLock::new(state));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(managed)
        .invoke_handler(tauri::generate_handler![
            // Mode, corpus and directories
            commands::corpus::lab_status,
            commands::corpus::reload_source,
            commands::corpus::lab_dirs,
            commands::corpus::check_corpus_status,
            commands::corpus::start_corpus_download,
            commands::corpus::cancel_corpus_download,
            commands::corpus::open_lab_directory,
            // Book browser and reader
            commands::books::list_books,
            commands::books::get_book,
            commands::books::list_page_refs,
            commands::books::get_page,
            commands::books::open_book,
            // Debug
            commands::debug::verify_alignment,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kashshaf Lab");
}
