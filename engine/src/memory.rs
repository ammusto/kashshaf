//! Process memory figures for `/health`, `get_stats` and the bench.
//!
//! The resident set (working set) counts every touched page including the
//! memory-mapped index files, so a query that streams a large share of the
//! postings inflates it with reclaimable page cache; the private figures
//! count anonymous (heap) memory only.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessMemory {
    /// Current resident set, bytes.
    pub rss: u64,
    /// Peak resident set, bytes.
    pub peak_rss: u64,
    /// Current private (anonymous) bytes.
    pub private: u64,
    /// Peak private bytes (Windows: peak commit charge; Linux: current value).
    pub peak_private: u64,
}

impl ProcessMemory {
    pub fn rss_mb(&self) -> f64 {
        mib(self.rss)
    }
    pub fn peak_rss_mb(&self) -> f64 {
        mib(self.peak_rss)
    }
    pub fn private_mb(&self) -> f64 {
        mib(self.private)
    }
    pub fn peak_private_mb(&self) -> f64 {
        mib(self.peak_private)
    }
}

pub fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

#[cfg(windows)]
pub fn process_memory() -> ProcessMemory {
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut c: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
    c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, c.cb) };
    if ok == 0 {
        return ProcessMemory::default();
    }
    ProcessMemory {
        rss: c.WorkingSetSize as u64,
        peak_rss: c.PeakWorkingSetSize as u64,
        private: c.PrivateUsage as u64,
        peak_private: c.PeakPagefileUsage as u64,
    }
}

#[cfg(not(windows))]
pub fn process_memory() -> ProcessMemory {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else { return ProcessMemory::default() };
    let kb = |key: &str| -> u64 {
        status
            .lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let anon = kb("RssAnon:") * 1024;
    ProcessMemory { rss: kb("VmRSS:") * 1024, peak_rss: kb("VmHWM:") * 1024, private: anon, peak_private: anon }
}
