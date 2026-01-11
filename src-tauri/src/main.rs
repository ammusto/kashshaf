//! Kashshaf - Medieval Arabic Text Research Environment
//! Native Rust application with Tauri + React UI

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use kashshaf_lib::{AppState, get_data_dir};
use std::sync::{Arc, RwLock};
use tauri::Emitter;

/// Wrapper for AppState that allows hot-reloading after corpus download
pub type ManagedAppState = Arc<RwLock<Option<Arc<AppState>>>>;

fn main() {
    // Determine data directory using centralized portable path logic
    let data_dir = get_data_dir();
    println!("Using data directory: {:?}", data_dir);

    // Try to initialize application state
    // If data is missing, AppState will be None and app shows download UI
    let app_state: ManagedAppState = Arc::new(RwLock::new(
        match AppState::new(data_dir.clone()) {
            Ok(state) => {
                println!("AppState initialized successfully");
                Some(Arc::new(state))
            }
            Err(e) => {
                eprintln!("Data not ready: {}", e);
                eprintln!("App will show download UI.");
                None
            }
        }
    ));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::search,
            commands::combined_search,
            commands::name_search,
            commands::get_page,
            commands::get_all_books,
            commands::list_books,
            commands::list_books_filtered,
            commands::search_authors,
            commands::get_book,
            commands::get_genres,
            commands::get_authors,
            commands::get_centuries,
            commands::get_stats,
            commands::proximity_search,
            commands::get_page_tokens,
            commands::get_token_at,
            commands::get_cache_stats,
            commands::clear_token_cache,
            commands::get_match_positions,
            commands::get_match_positions_combined,
            commands::get_page_with_matches,
            commands::get_name_match_positions,
            commands::wildcard_search,
            commands::show_app_menu,
            // Search history commands
            commands::add_to_history,
            commands::get_search_history,
            commands::clear_history,
            // Saved searches commands
            commands::save_search,
            commands::unsave_search,
            commands::unsave_search_by_query,
            commands::is_search_saved,
            commands::get_saved_searches,
            // App settings commands
            commands::get_app_setting,
            commands::set_app_setting,
            // App update check command
            commands::check_app_update,
            // Corpus download commands
            commands::check_corpus_status,
            commands::start_corpus_download,
            commands::cancel_corpus_download,
            commands::get_data_directory,
            commands::archive_old_corpus,
            commands::reload_app_state,
            // User settings commands (for online/offline mode)
            commands::get_user_setting,
            commands::set_user_setting,
            commands::corpus_exists,
            commands::delete_local_data,
            // Announcements command
            commands::fetch_announcements,
            // Collections commands
            commands::create_collection,
            commands::get_collections,
            commands::update_collection_books,
            commands::update_collection_description,
            commands::rename_collection,
            commands::delete_collection,
        ])
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "quit" => {
                    app.exit(0);
                }
                "check_for_updates" => {
                    // Emit event to frontend to trigger manual update check
                    if let Err(e) = app.emit("check-for-updates", ()) {
                        eprintln!("Failed to emit check-for-updates event: {}", e);
                    }
                }
                "delete_local_data" => {
                    // Emit event to frontend to show delete confirmation modal
                    if let Err(e) = app.emit("delete-local-data", ()) {
                        eprintln!("Failed to emit delete-local-data event: {}", e);
                    }
                }
                "settings" => {
                    // Settings does nothing for now - can be implemented later
                    println!("Settings clicked");
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
