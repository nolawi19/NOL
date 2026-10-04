// Computer awareness: only what the OS actually exposes, read on request.
//
// Nothing here polls on its own. The island asks while the command center is
// on screen (every 2 s) and stops when it leaves, so a hidden or idle Coucou
// reads nothing. CPU usage needs two samples; the first call returns None.

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;

use crate::platform;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// 0–100 across all cores since the previous call; None on the first call.
    pub cpu_percent: Option<f64>,
    pub cpu_count: usize,
    pub mem_total: Option<u64>,
    pub mem_used: Option<u64>,
    pub uptime_secs: Option<u64>,
    /// None when the machine has no battery (or the OS doesn't say).
    pub battery_percent: Option<u8>,
    pub charging: Option<bool>,
    pub os: &'static str,
}

static LAST_CPU: Mutex<Option<(u64, u64)>> = Mutex::new(None);

/// Percentage of non-idle time between two (idle, total) samples.
pub fn cpu_percent_between(prev: (u64, u64), now: (u64, u64)) -> Option<f64> {
    let idle = now.0.checked_sub(prev.0)?;
    let total = now.1.checked_sub(prev.1)?;
    if total == 0 {
        return None;
    }
    Some(((total.saturating_sub(idle)) as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
}

pub fn stats() -> SystemStats {
    let cpu = platform::cpu_times();
    let cpu_percent = {
        let mut last = LAST_CPU.lock().unwrap();
        let pct = match (*last, cpu) {
            (Some(prev), Some(now)) => cpu_percent_between(prev, now),
            _ => None,
        };
        *last = cpu;
        pct
    };
    let (mem_total, mem_used) = match platform::memory() {
        Some((total, available)) => (Some(total), Some(total.saturating_sub(available))),
        None => (None, None),
    };
    let (battery_percent, charging) = match platform::battery() {
        Some((pct, ch)) => (Some(pct), Some(ch)),
        None => (None, None),
    };
    SystemStats {
        cpu_percent,
        cpu_count: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        mem_total,
        mem_used,
        uptime_secs: platform::uptime_secs(),
        battery_percent,
        charging,
        os: if cfg!(windows) { "windows" } else { "linux" },
    }
}

// ── Projects ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub git: bool,
    pub branch: Option<String>,
    /// HEAD points at a commit, not a branch.
    pub detached: bool,
    /// Which well-known project files exist. Their contents are never read.
    pub markers: Vec<&'static str>,
}

const MARKERS: &[&str] = &[
    "package.json", "Cargo.toml", "pyproject.toml", "requirements.txt", "go.mod",
    "pom.xml", "build.gradle", "Gemfile", "composer.json", "Dockerfile",
    "vercel.json", "netlify.toml", "tsconfig.json", "deno.json", ".github",
];

/// Describes a project folder Claude Code is working in. Read-only and narrow:
/// it checks which marker files *exist*, and reads exactly one file —
/// `.git/HEAD` — to name the branch. Nothing else in the folder is opened.
pub fn probe_project(path: &str) -> Result<ProjectInfo, String> {
    let dir = Path::new(path);
    if !(dir.is_absolute() && dir.is_dir()) {
        return Err("Not a project folder.".into());
    }
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let git_dir = dir.join(".git");
    let git = git_dir.exists();
    let (branch, detached) = if git_dir.is_dir() {
        match std::fs::read_to_string(git_dir.join("HEAD")) {
            Ok(head) => parse_head(&head),
            Err(_) => (None, false),
        }
    } else {
        // A worktree or submodule: .git is a file pointing elsewhere. Don't follow it.
        (None, false)
    };
    let markers = MARKERS.iter().copied().filter(|m| dir.join(m).exists()).collect();
    Ok(ProjectInfo { name, path: path.to_string(), git, branch, detached, markers })
}

/// "ref: refs/heads/main" → (Some("main"), false); a bare hash → (None, true).
pub fn parse_head(head: &str) -> (Option<String>, bool) {
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref:") {
        let r = r.trim();
        let branch = r.strip_prefix("refs/heads/").unwrap_or(r);
        // Branch names are shown in the UI: keep them to sane characters.
        if branch.is_empty() || branch.len() > 200 || branch.chars().any(|c| c.is_control()) {
            return (None, false);
        }
        return (Some(branch.to_string()), false);
    }
    let is_hash = head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit());
    (None, is_hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_percent_is_busy_share_of_elapsed_time() {
        assert_eq!(cpu_percent_between((100, 1000), (150, 1100)), Some(50.0));
        assert_eq!(cpu_percent_between((100, 1000), (200, 1100)), Some(0.0));
        assert_eq!(cpu_percent_between((100, 1000), (100, 1000)), None);
        // Counters going backwards (reset, overflow) are not a reading.
        assert_eq!(cpu_percent_between((100, 1000), (50, 900)), None);
    }

    #[test]
    fn head_parsing() {
        assert_eq!(parse_head("ref: refs/heads/main\n"), (Some("main".into()), false));
        assert_eq!(parse_head("ref: refs/heads/feat/x"), (Some("feat/x".into()), false));
        assert_eq!(parse_head("0123456789abcdef0123456789abcdef01234567"), (None, true));
        assert_eq!(parse_head("garbage"), (None, false));
        assert_eq!(parse_head("ref: "), (None, false));
    }

    #[test]
    fn probe_reads_markers_and_branch_only() {
        let dir = std::env::temp_dir().join(format!("coucou-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/HEAD"), "ref: refs/heads/dev\n").unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        let info = probe_project(dir.to_str().unwrap()).unwrap();
        assert!(info.git);
        assert_eq!(info.branch.as_deref(), Some("dev"));
        assert_eq!(info.markers, vec!["package.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_refuses_relative_and_missing_paths() {
        assert!(probe_project("relative/path").is_err());
        assert!(probe_project("/definitely/not/here/coucou").is_err());
    }
}
