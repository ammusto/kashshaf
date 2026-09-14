//! Where the corpus, `settings.db` and Lab's own data live, and whether a
//! download would fit there.
//!
//! Moved out of the desktop app's `downloader` module so Kashshaf Lab resolves
//! the same corpus directory by the same rules (Lab spec §2.2, §2.5). The
//! resolution logic and its tests are unchanged.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Where the resolved data directory came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataDirSource {
    /// `<exe_dir>/data`: a portable install, or an install that already has a
    /// corpus next to the executable.
    Portable,
    /// `dirs::data_dir()/Kashshaf`: `%APPDATA%\Kashshaf`,
    /// `~/Library/Application Support/Kashshaf`, `~/.local/share/Kashshaf`.
    User,
    /// Debug build: the CWD-relative / project-root search.
    Dev,
}

/// Free space the download must leave on the volume, on top of its own size.
pub const FREE_SPACE_MARGIN: u64 = 1024 * 1024 * 1024;

/// Everything the download and settings modals show about the data directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataDirInfo {
    pub path: String,
    pub source: DataDirSource,
    pub writable: bool,
    pub free_bytes: u64,
    pub total_bytes: u64,
    /// What the caller asked about (a pending download), if anything.
    pub required_bytes: Option<u64>,
    pub margin_bytes: u64,
    /// `free_bytes >= required_bytes + margin_bytes`; `None` when nothing was asked.
    pub enough_space: Option<bool>,
}

/// Can this process create a file here? An actual write (create, write,
/// delete a uniquely named temp file) rather than a permission check:
/// Windows ACLs and the VirtualStore can report success where a write would
/// silently redirect or fail.
pub fn write_probe(dir: &Path) -> bool {
    let probe = dir.join(format!(".kashshaf-write-probe-{}-{}", std::process::id(), std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    let ok = std::fs::write(&probe, b"probe").is_ok() && std::fs::read(&probe).map(|b| b == b"probe").unwrap_or(false);
    let _ = std::fs::remove_file(&probe);
    ok
}

/// Release-build resolution, with its inputs injected so it can be tested:
///
/// 1. `exe_data` (`<exe_dir>/data`) when it already exists and `probe` says it
///    is writable — portable installs and existing installs keep their
///    directory (and their `settings.db`).
/// 2. `user_data` (`dirs::data_dir()/Kashshaf`), created if absent, when
///    `probe` accepts it.
/// 3. Otherwise an error naming both candidates and why each was rejected.
pub fn resolve_with(
    exe_data: Option<PathBuf>,
    user_data: Option<PathBuf>,
    probe: &dyn Fn(&Path) -> bool,
) -> Result<(PathBuf, DataDirSource)> {
    let mut why: Vec<String> = Vec::new();
    match exe_data {
        Some(p) if p.is_dir() => {
            if probe(&p) {
                return Ok((p, DataDirSource::Portable));
            }
            why.push(format!("{} exists but is not writable", p.display()));
        }
        Some(p) => why.push(format!("{} does not exist (not a portable install)", p.display())),
        None => why.push("the executable's directory could not be determined".to_string()),
    }
    match user_data {
        Some(u) => {
            if let Err(e) = std::fs::create_dir_all(&u) {
                why.push(format!("{} could not be created: {}", u.display(), e));
            } else if probe(&u) {
                return Ok((u, DataDirSource::User));
            } else {
                why.push(format!("{} is not writable", u.display()));
            }
        }
        None => why.push("no per-user data directory is known for this platform".to_string()),
    }
    Err(anyhow!(
        "No writable data directory for the corpus: {}. Move Kashshaf to a folder you can write to, \
         or make one of these directories writable, then restart.",
        why.join("; ")
    ))
}

/// Debug builds: the development search (project `data/` junction, then up
/// to five levels above the executable, then `<exe_dir>/data`).
#[cfg(debug_assertions)]
fn resolve_dev() -> PathBuf {
    let dev_paths = [
        PathBuf::from("data"),
        PathBuf::from("../../data"),       // app/src-tauri -> project root
        PathBuf::from("../../../data"),    // app/src-tauri/target/debug -> project root
    ];
    for path in &dev_paths {
        if path.join("corpus.db").exists() || path.join("tantivy_index").exists() {
            return path.canonicalize().unwrap_or_else(|_| path.clone());
        }
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let mut current = exe_dir;
            for _ in 0..5 {
                let data_path = current.join("data");
                if data_path.join("corpus.db").exists() || data_path.join("tantivy_index").exists() {
                    return data_path;
                }
                match current.parent() {
                    Some(parent) => current = parent,
                    None => break,
                }
            }
            return exe_dir.join("data");
        }
    }
    PathBuf::from("data")
}

fn resolve_data_dir_uncached() -> Result<(PathBuf, DataDirSource)> {
    #[cfg(debug_assertions)]
    {
        return Ok((resolve_dev(), DataDirSource::Dev));
    }
    #[cfg(not(debug_assertions))]
    {
        let exe_data = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("data")));
        let user_data = dirs::data_dir().map(|d| d.join("Kashshaf"));
        resolve_with(exe_data, user_data, &write_probe)
    }
}

static RESOLVED_DATA_DIR: std::sync::OnceLock<(PathBuf, DataDirSource)> = std::sync::OnceLock::new();

/// The data directory for this process, resolved once and logged once, so
/// every caller — startup, `reload_app_state`, the download, `settings.db` —
/// agrees on the same path. Errors are not cached: a user who fixes a
/// permission problem and retries gets a fresh attempt.
pub fn resolve_data_dir() -> Result<(PathBuf, DataDirSource)> {
    if let Some(r) = RESOLVED_DATA_DIR.get() {
        return Ok(r.clone());
    }
    let resolved = resolve_data_dir_uncached()?;
    let r = RESOLVED_DATA_DIR.get_or_init(|| resolved);
    eprintln!("[data-dir] {} ({:?})", r.0.display(), r.1);
    Ok(r.clone())
}

/// Get the data directory (corpus files and `settings.db`).
///
/// - Release, all platforms: `<exe_dir>/data` if it exists and is writable
///   (portable / existing installs), else `dirs::data_dir()/Kashshaf`
///   (`%APPDATA%\Kashshaf`, `~/Library/Application Support/Kashshaf`,
///   `~/.local/share/Kashshaf`), created if absent; an error if neither works.
/// - Development: project root or relative dev paths.
pub fn get_data_dir() -> Result<PathBuf> {
    resolve_data_dir().map(|(p, _)| p)
}

/// `free >= required + margin`, the rule the download enforces before its
/// first byte.
pub fn has_enough_space(free_bytes: u64, required_bytes: u64, margin_bytes: u64) -> bool {
    free_bytes >= required_bytes.saturating_add(margin_bytes)
}

/// Path, writability and free space of the data directory, and whether a
/// download of `required_bytes` would fit with [`FREE_SPACE_MARGIN`] to spare.
pub fn data_dir_info(required_bytes: Option<u64>) -> Result<DataDirInfo> {
    let (path, source) = resolve_data_dir()?;
    let writable = path.is_dir() && write_probe(&path);
    // The volume figures come from the deepest existing ancestor.
    let mut probe_path = path.clone();
    while !probe_path.exists() {
        match probe_path.parent() {
            Some(p) => probe_path = p.to_path_buf(),
            None => break,
        }
    }
    let free_bytes = fs4::available_space(&probe_path).unwrap_or(0);
    let total_bytes = fs4::total_space(&probe_path).unwrap_or(0);
    Ok(DataDirInfo {
        path: path.to_string_lossy().to_string(),
        source,
        writable,
        free_bytes,
        total_bytes,
        required_bytes,
        margin_bytes: FREE_SPACE_MARGIN,
        enough_space: required_bytes.map(|r| has_enough_space(free_bytes, r, FREE_SPACE_MARGIN)),
    })
}

/// Get the application data directory (for backwards compatibility)
/// Now returns the portable data directory's parent (or creates structure next to exe)
pub fn get_app_data_directory() -> Result<PathBuf> {
    let data_dir = get_data_dir()?;
    // Return parent of data dir (where settings.db will live alongside data/)
    if let Some(parent) = data_dir.parent() {
        Ok(parent.to_path_buf())
    } else {
        Ok(PathBuf::from("."))
    }
}

/// Get the corpus data directory (where corpus.db and tantivy_index live)
pub fn get_corpus_data_directory() -> Result<PathBuf> {
    get_data_dir()
}

/// Get the settings database path (in data folder alongside corpus.db)
pub fn get_settings_db_path() -> Result<PathBuf> {
    Ok(get_data_dir()?.join("settings.db"))
}

/// Kashshaf Lab's own directory: `dirs::data_dir()/KashshafLab`, holding
/// `analysis.db`, `lab_settings.db`, `exports/` and `cache/` (Lab spec §2.5).
/// Deliberately a sibling of the corpus directory, never inside it: Kashshaf's
/// `delete_local_data` and `archive_old_corpus` operate on the corpus
/// directory and so cannot reach Lab's data (§2.3).
///
/// Created on demand with the same write probe as the corpus directory.
pub fn lab_data_dir() -> Result<PathBuf> {
    let dir = dirs::data_dir()
        .map(|d| d.join("KashshafLab"))
        .ok_or_else(|| anyhow!("no per-user data directory is known for this platform"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow!("{} could not be created: {}", dir.display(), e))?;
    if !write_probe(&dir) {
        return Err(anyhow!(
            "{} is not writable. Kashshaf Lab keeps its analyses there; make it writable, then restart.",
            dir.display()
        ));
    }
    Ok(dir)
}

#[cfg(test)]
mod data_dir_tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kashshaf-datadir-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn existing_writable_exe_dir_is_preferred_over_the_user_dir() {
        let base = temp("portable");
        let exe_data = base.join("data");
        std::fs::create_dir_all(&exe_data).unwrap();
        std::fs::write(exe_data.join("settings.db"), b"x").unwrap(); // an existing install
        let user = base.join("user").join("Kashshaf");
        let (p, src) = resolve_with(Some(exe_data.clone()), Some(user.clone()), &write_probe).unwrap();
        assert_eq!(p, exe_data);
        assert_eq!(src, DataDirSource::Portable);
        assert!(!user.exists(), "the user dir must not be created when the portable dir wins");
        assert!(exe_data.join("settings.db").exists(), "the existing settings.db stays where it is");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unwritable_exe_dir_falls_through_to_the_user_dir() {
        let base = temp("unwritable");
        let exe_data = base.join("data");
        std::fs::create_dir_all(&exe_data).unwrap();
        let user = base.join("AppData").join("Kashshaf");
        // A probe that fails for the exe dir (Program Files) and succeeds elsewhere.
        let exe = exe_data.clone();
        let probe = move |p: &Path| p != exe.as_path() && write_probe(p);
        let (p, src) = resolve_with(Some(exe_data.clone()), Some(user.clone()), &probe).unwrap();
        assert_eq!(p, user);
        assert_eq!(src, DataDirSource::User);
        assert!(user.is_dir(), "the user dir is created");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_exe_dir_is_a_fresh_install_and_uses_the_user_dir() {
        let base = temp("fresh");
        let exe_data = base.join("data"); // does not exist
        let user = base.join("user").join("Kashshaf");
        let (p, src) = resolve_with(Some(exe_data), Some(user.clone()), &write_probe).unwrap();
        assert_eq!((p, src), (user, DataDirSource::User));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn neither_usable_is_a_descriptive_error_not_a_path() {
        let base = temp("neither");
        let exe_data = base.join("data");
        std::fs::create_dir_all(&exe_data).unwrap();
        let user = base.join("user").join("Kashshaf");
        let never = |_: &Path| false;
        let e = resolve_with(Some(exe_data.clone()), Some(user.clone()), &never).unwrap_err().to_string();
        assert!(e.contains("No writable data directory"), "{}", e);
        assert!(e.contains(&exe_data.display().to_string()) && e.contains("not writable"), "{}", e);
        assert!(e.contains(&user.display().to_string()), "{}", e);
        let e = resolve_with(None, None, &write_probe).unwrap_err().to_string();
        assert!(e.contains("could not be determined") && e.contains("no per-user"), "{}", e);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn write_probe_leaves_nothing_behind_and_rejects_a_file() {
        let base = temp("probe");
        assert!(write_probe(&base));
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0, "probe file was removed");
        let file = base.join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        assert!(!write_probe(&file), "a path that is a file is not a writable directory");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolved_path_is_stable_across_calls() {
        // What reload_app_state relies on: the same path every time in one process.
        let a = get_data_dir().unwrap();
        let b = get_data_dir().unwrap();
        let c = get_corpus_data_directory().unwrap();
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(get_settings_db_path().unwrap(), a.join("settings.db"));
        let info = data_dir_info(None).unwrap();
        assert_eq!(PathBuf::from(&info.path), a);
        assert!(info.enough_space.is_none());
    }

    #[test]
    fn free_space_check_rejects_a_download_that_would_not_fit() {
        let gb = 1024u64 * 1024 * 1024;
        assert!(has_enough_space(12 * gb, 9 * gb, FREE_SPACE_MARGIN));
        assert!(!has_enough_space(9 * gb + FREE_SPACE_MARGIN - 1, 9 * gb, FREE_SPACE_MARGIN), "margin counts");
        assert!(!has_enough_space(5 * gb, 9 * gb, FREE_SPACE_MARGIN));
        assert!(has_enough_space(u64::MAX, u64::MAX, FREE_SPACE_MARGIN), "saturating add, no overflow");
        // Against the real volume: asking for more than it has is refused.
        let info = data_dir_info(Some(u64::MAX / 2)).unwrap();
        assert_eq!(info.enough_space, Some(false));
        assert!(info.total_bytes >= info.free_bytes);
        let small = data_dir_info(Some(0)).unwrap();
        assert_eq!(small.enough_space, Some(small.free_bytes >= FREE_SPACE_MARGIN));
    }

    #[test]
    fn lab_dir_is_a_sibling_of_the_corpus_dir_not_inside_it() {
        // Lab spec §2.3/§2.5: Kashshaf's delete_local_data and archive_old_corpus
        // act on the corpus directory; Lab's directory must not be under it.
        let lab = lab_data_dir().unwrap();
        let corpus = get_data_dir().unwrap();
        assert!(lab.is_dir());
        assert!(!lab.starts_with(&corpus), "{} is inside {}", lab.display(), corpus.display());
        assert!(lab.ends_with("KashshafLab"));
    }
}
