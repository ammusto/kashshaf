//! The api-mode bulk cache (Lab spec §2.5).
//!
//! One file per `(corpus_version, book_id)` under `<lab dir>/cache/`, holding
//! the zstd body the server sent. Size-capped, evicted least-recently-used by
//! file mtime — the spec's rule, and the one the OS maintains for free.
//!
//! Everything here treats a cache miss, a corrupt entry or an unwritable
//! directory as "fetch it again": nothing the cache does may make Lab wrong,
//! only slower.

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Default cap, user-settable in Settings (spec §7.8). A 500-page book is a
/// few MB compressed, so this holds a working set of a few hundred books.
pub const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub struct BulkCache {
    dir: PathBuf,
    max_bytes: u64,
}

impl BulkCache {
    /// A cache under `lab_dir/cache`. Creating the directory is best-effort:
    /// api mode works without a cache, just more slowly.
    pub fn new(lab_dir: &Path, max_bytes: u64) -> Self {
        let dir = lab_dir.join("cache");
        if let Err(e) = fs::create_dir_all(&dir) {
            eprintln!("[lab] bulk cache unavailable at {}: {}", dir.display(), e);
        }
        Self { dir, max_bytes }
    }

    /// The entry for one book of one corpus. The corpus version is in the name
    /// so a corpus update cannot serve stale pages: the old entries simply
    /// stop being asked for and age out.
    fn path(&self, corpus_version: &str, book_id: u64) -> PathBuf {
        self.dir.join(format!("{}-{}.ndjson.zst", safe_name(corpus_version), book_id))
    }

    /// A cached body, if there is one. Touches the file so the LRU order is
    /// by last *use*, not last write. A touch that fails is not an error: the
    /// entry is merely a worse eviction candidate than it should be.
    pub fn get(&self, corpus_version: &str, book_id: u64) -> Option<Vec<u8>> {
        let path = self.path(corpus_version, book_id);
        let bytes = fs::read(&path).ok()?;
        if bytes.is_empty() {
            let _ = fs::remove_file(&path);
            return None;
        }
        let _ = touch(&path);
        Some(bytes)
    }

    /// Store a body, then evict down to the cap. Failure is logged, not
    /// returned: the caller already has what it needs.
    pub fn put(&self, corpus_version: &str, book_id: u64, bytes: &[u8]) {
        let path = self.path(corpus_version, book_id);
        // Write to a temp file and rename, so a cancelled or crashed write
        // never leaves a half-file that would decompress to a short book.
        let tmp = path.with_extension("part");
        if let Err(e) = fs::write(&tmp, bytes).and_then(|()| fs::rename(&tmp, &path)) {
            eprintln!("[lab] could not cache book {}: {}", book_id, e);
            let _ = fs::remove_file(&tmp);
            return;
        }
        if let Err(e) = self.evict() {
            eprintln!("[lab] bulk cache eviction failed: {}", e);
        }
    }

    /// Total bytes currently held.
    pub fn size(&self) -> u64 {
        entries(&self.dir).iter().map(|(_, _, len)| len).sum()
    }

    /// Delete least-recently-used entries until the cache fits its cap.
    pub fn evict(&self) -> Result<()> {
        let mut files = entries(&self.dir);
        let mut total: u64 = files.iter().map(|(_, _, len)| len).sum();
        if total <= self.max_bytes {
            return Ok(());
        }
        // Oldest use first.
        files.sort_by_key(|(_, mtime, _)| *mtime);
        for (path, _, len) in files {
            if total <= self.max_bytes {
                break;
            }
            fs::remove_file(&path).with_context(|| format!("evicting {}", path.display()))?;
            total = total.saturating_sub(len);
        }
        Ok(())
    }

    /// Remove everything (Settings ▸ clear cache).
    pub fn clear(&self) -> Result<()> {
        for (path, _, _) in entries(&self.dir) {
            fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        }
        Ok(())
    }
}

/// `(path, mtime, len)` for every cache entry.
fn entries(dir: &Path) -> Vec<(PathBuf, SystemTime, u64)> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if path.extension().map(|x| x != "zst").unwrap_or(true) {
                return None;
            }
            let meta = e.metadata().ok()?;
            Some((path, meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()))
        })
        .collect()
}

/// The cache key for a corpus version, as a filename that cannot leave the
/// cache directory.
///
/// Everything outside `[A-Za-z0-9.-]` becomes `_`; a name that would still
/// read as a path — one starting with a dot, or containing `..` — is replaced
/// wholesale. Corpus versions come from a manifest Lab downloads, so this is
/// the boundary where that input stops being trusted.
fn safe_name(corpus_version: &str) -> String {
    let mapped: String = corpus_version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    if mapped.is_empty() || mapped.starts_with('.') || mapped.contains("..") {
        // Not a version we recognise; key it by a stable digest instead of
        // trying to repair it.
        return format!("v{:016x}", fnv1a(corpus_version));
    }
    mapped
}

/// FNV-1a, enough to key a local cache directory and no dependency.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Mark a file as used now, so eviction orders by last use.
///
/// A zero-length write does not update mtime on most platforms, so this sets
/// it explicitly.
fn touch(path: &Path) -> std::io::Result<()> {
    fs::OpenOptions::new().write(true).open(path)?.set_modified(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kashshaf-lab-cache-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_body_round_trips_and_is_keyed_by_corpus_and_book() {
        let dir = temp("roundtrip");
        let cache = BulkCache::new(&dir, DEFAULT_MAX_BYTES);
        assert!(cache.get("4.1.0", 7).is_none());

        cache.put("4.1.0", 7, b"body-a");
        assert_eq!(cache.get("4.1.0", 7).as_deref(), Some(&b"body-a"[..]));

        // A different book, and the same book of a different corpus, are
        // different entries — a corpus update must never serve stale pages.
        assert!(cache.get("4.1.0", 8).is_none());
        assert!(cache.get("4.0.0", 7).is_none());
        cache.put("4.0.0", 7, b"body-b");
        assert_eq!(cache.get("4.1.0", 7).as_deref(), Some(&b"body-a"[..]));
        assert_eq!(cache.get("4.0.0", 7).as_deref(), Some(&b"body-b"[..]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corpus_version_cannot_escape_the_cache_directory() {
        let dir = temp("traversal");
        let cache = BulkCache::new(&dir, DEFAULT_MAX_BYTES);
        for hostile in ["../../etc/passwd", "..", "./..", "", "/etc/passwd", "C:\\Windows"] {
            let path = cache.path(hostile, 1);
            assert_eq!(path.parent(), Some(dir.join("cache").as_path()), "{:?}", hostile);
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(!name.contains(".."), "{:?} -> {}", hostile, name);
            assert!(!name.starts_with('.'), "{:?} -> {}", hostile, name);
        }
        // An ordinary version is used as it stands, so the files stay legible.
        assert!(cache
            .path("4.1.0", 7)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("4.1.0-7"));
        // Two hostile versions that differ still get different entries.
        assert_ne!(cache.path("..", 1), cache.path("../..", 1));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Three 100-byte entries with fixed, ordered mtimes, seeded through a
    /// cache big enough not to evict while it is being built — `put` evicts,
    /// so seeding through the small cache would drop an entry before its
    /// mtime was set.
    fn seeded(dir: &Path) -> BulkCache {
        let big = BulkCache::new(dir, u64::MAX);
        for (book, mtime) in [(1u64, 10), (2, 20), (3, 30)] {
            big.put("4.1.0", book, &vec![b'x'; 100]);
            set_mtime(&big.path("4.1.0", book), mtime);
        }
        // Room for two of them, not three.
        BulkCache::new(dir, 250)
    }

    #[test]
    fn eviction_removes_the_least_recently_used_until_it_fits() {
        let dir = temp("evict");
        let cache = seeded(&dir);
        assert_eq!(cache.size(), 300);
        cache.evict().unwrap();
        assert!(cache.size() <= 250, "size {} exceeds the cap", cache.size());
        assert!(cache.get("4.1.0", 1).is_none(), "the oldest entry was evicted");
        assert!(cache.get("4.1.0", 2).is_some());
        assert!(cache.get("4.1.0", 3).is_some(), "the newest entry survived");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_an_entry_makes_it_the_most_recently_used() {
        let dir = temp("touch");
        let cache = seeded(&dir);
        // Use the oldest entry. That must move it to the back of the queue,
        // so the next eviction takes entry 2 instead.
        assert!(cache.get("4.1.0", 1).is_some());
        cache.evict().unwrap();
        assert!(cache.size() <= 250);
        assert!(cache.get("4.1.0", 1).is_some(), "a just-read entry must not be evicted first");
        assert!(cache.get("4.1.0", 2).is_none(), "the now-oldest entry went instead");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truncated_entry_is_discarded_rather_than_served() {
        let dir = temp("corrupt");
        let cache = BulkCache::new(&dir, DEFAULT_MAX_BYTES);
        cache.put("4.1.0", 5, b"body");
        fs::write(cache.path("4.1.0", 5), b"").unwrap();
        assert!(cache.get("4.1.0", 5).is_none());
        assert!(!cache.path("4.1.0", 5).exists(), "the empty entry was removed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_empties_the_cache() {
        let dir = temp("clear");
        let cache = BulkCache::new(&dir, DEFAULT_MAX_BYTES);
        cache.put("4.1.0", 1, b"a");
        cache.put("4.1.0", 2, b"b");
        assert!(cache.size() > 0);
        cache.clear().unwrap();
        assert_eq!(cache.size(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Set a file's mtime to `secs` after the epoch, so LRU order is exact
    /// rather than dependent on how fast the test ran.
    fn set_mtime(path: &Path, secs: u64) {
        let when = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(when).unwrap();
    }
}
