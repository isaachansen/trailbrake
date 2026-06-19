//! Background track-map bundle refresh.
//!
//! On startup, spawns a background thread that:
//! 1. Loads the cached bundle from the app config dir (if present) and merges
//!    it immediately — fast, makes updated maps available before the first
//!    telemetry frame.
//! 2. If the cache is missing or older than 24 hours, fetches the latest
//!    bundle from GitHub Releases, writes it to the cache, and merges it.
//! 3. On any error (network, parse, I/O), keeps using the baseline compiled
//!    into the binary — the app always works offline.
//!
//! The merge is additive: entries in the download overwrite their baseline
//! counterparts; baseline-only entries are kept. This lets new tracks appear
//! without an app update.
//!
//! All errors are logged to stderr and swallowed — this must never crash the
//! app or block the UI. The thread finishes after one fetch attempt.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

/// URL to the published track-map bundle. A weekly CI job bakes this from
/// iRacing's official SVGs + lovely-track-data metadata and attaches it to a
/// GitHub Release tagged `trackmaps-latest`. Overridable via env var for
/// testing.
const DEFAULT_TRACK_MAPS_URL: &str =
    "https://github.com/isaachansen/trailbrake/releases/download/trackmaps-latest/track_maps.json";

/// Max cache age before a re-fetch is attempted.
const CACHE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60); // 24h
/// Network timeout for the fetch.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Spawn the background refresh thread. Non-blocking — returns immediately.
pub fn spawn_refresh(app: &AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("track-map-refresh".into())
        .spawn(move || {
            if let Err(e) = run_refresh(&app) {
                eprintln!("[track-maps] refresh failed: {e}");
            }
        })
        .expect("failed to spawn track-map-refresh thread");
}

fn run_refresh(app: &AppHandle) -> Result<(), String> {
    let cache_path = cache_path(app)?;
    let url = std::env::var("TRACK_MAPS_URL").unwrap_or_else(|_| DEFAULT_TRACK_MAPS_URL.to_string());

    // Step 1: if a cached bundle exists, merge it immediately (fast — no
    // network). This makes the last-known bundle available before the first
    // telemetry frame, even if the network fetch below is slow or fails.
    if cache_path.exists() {
        match fs::read_to_string(&cache_path) {
            Ok(body) if !body.trim().is_empty() => {
                merge(&body, "cache");
            }
            Ok(_) => {
                // Empty or whitespace-only cache — treat as missing.
            }
            Err(e) => {
                eprintln!("[track-maps] cache read failed: {e}");
            }
        }
    }

    // Step 2: if the cache is missing or stale, fetch a fresh bundle.
    let needs_fetch = !cache_path.exists()
        || fs::metadata(&cache_path)
            .and_then(|m| m.modified())
            .map_err(|e| e.to_string())
            .and_then(|mtime| {
                SystemTime::now()
                    .duration_since(mtime)
                    .map(|age| age > CACHE_MAX_AGE)
                    .map_err(|e| e.to_string())
            })
            .unwrap_or(true);

    if !needs_fetch {
        return Ok(());
    }

    eprintln!("[track-maps] fetching latest bundle from {url}");
    let body = match fetch_bundle(&url) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[track-maps] fetch failed (using baseline/cache): {e}");
            return Ok(()); // non-fatal
        }
    };

    // Validate it's non-empty JSON before caching (avoid caching an error page).
    if body.trim().is_empty() || !body.trim().starts_with('{') {
        eprintln!("[track-maps] fetched body is not valid JSON object, skipping");
        return Ok(());
    }

    // Write to cache atomically (write .tmp then rename) so a crash mid-write
    // doesn't corrupt the cache.
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = cache_path.with_extension("json.tmp");
    fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &cache_path).map_err(|e| e.to_string())?;

    merge(&body, "fetched");
    Ok(())
}

/// Fetch the bundle JSON text from `url` with a timeout.
fn fetch_bundle(url: &str) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(FETCH_TIMEOUT)
        .build();
    let response = agent
        .get(url)
        .call()
        .map_err(|e| format!("{e}"))?;
    response
        .into_string()
        .map_err(|e| format!("read body: {e}"))
}

/// Merge a bundle body into the iracing-connector's in-memory registry.
/// On Windows the connector is compiled in; on other platforms this is a no-op
/// (the app uses the mock connector there anyway).
#[allow(unused_variables)]
fn merge(body: &str, source: &str) {
    #[cfg(windows)]
    {
        match iracing_connector::merge_external(body) {
            Ok(count) => eprintln!("[track-maps] merged {count} tracks from {source}"),
            Err(e) => eprintln!("[track-maps] merge from {source} failed: {e}"),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (body, source);
    }
}

/// Path to the cached bundle in the app config dir.
fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("track_maps.json"))
}
