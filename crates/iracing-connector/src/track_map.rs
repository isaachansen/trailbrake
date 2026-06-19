//! Bundled official iRacing track maps.
//!
//! The map data is fetched and baked once by `scripts/fetch-track-maps.mjs`
//! (clean-room, from iRacing's own published track-map SVGs) into
//! `assets/track_maps.json`, then compiled into the binary with `include_str!`.
//! Each entry is a normalized closed-loop centerline whose array order matches
//! `lapDistPct`: index 0 sits on the start/finish line and the points run in the
//! driving direction, so the widget places a car straight from its lap fraction.
//!
//! The bundled file ships empty (`{}`) so the crate builds before the user runs
//! the fetch script; once populated, `path_for` returns the matching centerline.
//!
//! # Runtime updates
//!
//! [`merge_external`] lets the Tauri shell merge a freshly-downloaded bundle
//! (published to GitHub Releases by a weekly CI job) into the in-memory
//! registry at startup. Entries in the download overwrite their baseline
//! counterparts; baseline-only entries are kept. This lets new tracks appear
//! without an app update — the app fetches the latest bundle on launch and
//! merges it on top of the compiled-in baseline. If the download fails or is
//! invalid, the baseline is used as-is (graceful offline fallback).

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use overlay_core::{TrackMetadata, TrackTurn};
use serde::Deserialize;

/// One baked track as emitted by `fetch-track-maps.mjs`. `name`/`config` are
/// kept in the JSON for human inspection but unused here. `metadata` is
/// optionally merged in by `fetch-lovely-track-data.mjs` (corner names,
/// sectors, pit markers from the lovely-track-data project).
#[derive(Clone, Deserialize)]
struct BakedTrack {
    points: Vec<[f32; 2]>,
    #[serde(default)]
    turns: Vec<TrackTurn>,
    #[serde(default)]
    metadata: Option<TrackMetadata>,
}

const RAW: &str = include_str!("../assets/track_maps.json");

static MAPS: OnceLock<RwLock<HashMap<u32, BakedTrack>>> = OnceLock::new();

fn maps() -> &'static RwLock<HashMap<u32, BakedTrack>> {
    MAPS.get_or_init(|| RwLock::new(parse(RAW)))
}

/// Parse the `{ "<trackId>": { points, turns, metadata, .. } }` blob into a
/// `track_id -> track` map, dropping any entry whose key isn't a `u32`.
fn parse(raw: &str) -> HashMap<u32, BakedTrack> {
    let by_id: HashMap<String, BakedTrack> = serde_json::from_str(raw).unwrap_or_default();
    by_id
        .into_iter()
        .filter_map(|(id, t)| id.parse::<u32>().ok().map(|id| (id, t)))
        .collect()
}

/// The normalized centerline for `track_id`, if a baked map is bundled for it.
/// Returns an owned clone (the snapshot needs an owned `Vec`); `None` when the
/// track isn't in the bundle (e.g. the user hasn't fetched maps yet).
pub fn path_for(track_id: u32) -> Option<Vec<[f32; 2]>> {
    maps()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(&track_id)
        .map(|t| t.points.clone())
}

/// The corner labels for `track_id`, if any are bundled. `None` when the track
/// is absent or has no turn data.
pub fn turns_for(track_id: u32) -> Option<Vec<TrackTurn>> {
    maps()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(&track_id)
        .filter(|t| !t.turns.is_empty())
        .map(|t| t.turns.clone())
}

/// The supplementary metadata (corner names, sectors, pit markers) for
/// `track_id`, if any is bundled. `None` when the track is absent or has no
/// metadata.
pub fn metadata_for(track_id: u32) -> Option<TrackMetadata> {
    maps()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(&track_id)
        .and_then(|t| t.metadata.clone())
}

/// Merge a downloaded track-map bundle into the in-memory registry. Entries in
/// the download overwrite their baseline counterparts; baseline-only entries
/// are kept. Returns the number of entries merged. Returns an error if the
/// payload is empty or unparseable (the existing registry is left untouched).
///
/// Called by the Tauri shell at startup after fetching the latest bundle from
/// GitHub Releases. Safe to call multiple times (idempotent per-entry).
pub fn merge_external(raw: &str) -> Result<usize, String> {
    let by_id: HashMap<String, BakedTrack> =
        serde_json::from_str(raw).map_err(|e| format!("parse error: {e}"))?;
    let parsed: HashMap<u32, BakedTrack> = by_id
        .into_iter()
        .filter_map(|(id, t)| id.parse::<u32>().ok().map(|id| (id, t)))
        .collect();
    if parsed.is_empty() {
        return Err("bundle contains no valid tracks".to_string());
    }
    let count = parsed.len();
    let mut map = maps().write().unwrap_or_else(|e| e.into_inner());
    for (id, track) in parsed {
        map.insert(id, track);
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::{merge_external, parse};

    #[test]
    fn parses_and_looks_up() {
        let raw = r#"{
            "18": { "name": "Test Speedway", "config": "Oval", "points": [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]],
                    "turns": [{"label": "1", "x": 0.5, "y": 0.5}] },
            "199": { "name": "No Config", "config": null, "points": [[0.1, 0.2]] }
        }"#;
        let maps = parse(raw);
        assert_eq!(maps.len(), 2);
        let t = maps.get(&18).expect("track 18 present");
        assert_eq!(t.points.len(), 3);
        assert_eq!(t.points[1], [1.0, 0.0]);
        assert_eq!(t.turns.len(), 1);
        assert_eq!(t.turns[0].label, "1");
        assert!(maps.get(&7).is_none());
        // Entry without a `turns` field defaults to empty (no turn labels).
        assert!(maps.get(&199).unwrap().turns.is_empty());
    }

    #[test]
    fn empty_object_is_ok() {
        assert!(parse("{}").is_empty());
    }

    #[test]
    fn metadata_parses() {
        let raw = r#"{
            "18": { "points": [[0.0, 0.0]],
                    "metadata": { "country": "IT", "length": 4909, "pitEntry": 0.908,
                                  "sectors": [{"name": "1", "marker": 0.241}],
                                  "lovelyTurns": [{"name": "Variante Tamburello", "marker": 0.144}] } }
        }"#;
        let maps = parse(raw);
        let t = maps.get(&18).expect("track 18 present");
        let md = t.metadata.as_ref().expect("metadata present");
        assert_eq!(md.country.as_deref(), Some("IT"));
        assert_eq!(md.length, Some(4909));
        assert_eq!(md.pit_entry, Some(0.908));
        assert_eq!(md.sectors.len(), 1);
        assert_eq!(md.sectors[0].name, "1");
        assert!((md.sectors[0].marker - 0.241).abs() < 1e-6);
        assert_eq!(md.lovely_turns.len(), 1);
        assert_eq!(md.lovely_turns[0].name, "Variante Tamburello");
        assert!((md.lovely_turns[0].marker - 0.144).abs() < 1e-6);
    }

    #[test]
    fn merge_external_rejects_empty() {
        // Use a fresh map to avoid interfering with other tests via the global.
        let result = merge_external("{}");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "bundle contains no valid tracks");
    }

    #[test]
    fn merge_external_rejects_garbage() {
        let result = merge_external("not json at all");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("parse error"));
    }

    #[test]
    fn merge_external_rejects_non_object() {
        let result = merge_external("[1, 2, 3]");
        assert!(result.is_err());
    }

    #[test]
    fn merge_external_merges_tracks() {
        // Merging a valid bundle should report the count and make entries
        // retrievable via the public accessors. We can't isolate the global
        // static, so we verify via merge_external's return value + path_for.
        let raw = r#"{
            "9999": { "points": [[0.1, 0.2], [0.3, 0.4]] }
        }"#;
        let count = merge_external(raw).expect("valid bundle");
        assert_eq!(count, 1);
        // The merged track should now be retrievable.
        let path = super::path_for(9999);
        assert!(path.is_some(), "merged track should be retrievable");
        assert_eq!(path.unwrap().len(), 2);
    }
}
