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

use std::collections::HashMap;
use std::sync::OnceLock;

use overlay_core::TrackTurn;
use serde::Deserialize;

/// One baked track as emitted by `fetch-track-maps.mjs`. `name`/`config` are
/// kept in the JSON for human inspection but unused here.
#[derive(Clone, Deserialize)]
struct BakedTrack {
    points: Vec<[f32; 2]>,
    #[serde(default)]
    turns: Vec<TrackTurn>,
}

const RAW: &str = include_str!("../assets/track_maps.json");

static MAPS: OnceLock<HashMap<u32, BakedTrack>> = OnceLock::new();

fn maps() -> &'static HashMap<u32, BakedTrack> {
    MAPS.get_or_init(|| parse(RAW))
}

/// Parse the `{ "<trackId>": { points, turns, .. } }` blob into a `track_id ->
/// track` map, dropping any entry whose key isn't a `u32`.
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
    maps().get(&track_id).map(|t| t.points.clone())
}

/// The corner labels for `track_id`, if any are bundled. `None` when the track
/// is absent or has no turn data.
pub fn turns_for(track_id: u32) -> Option<Vec<TrackTurn>> {
    maps()
        .get(&track_id)
        .filter(|t| !t.turns.is_empty())
        .map(|t| t.turns.clone())
}

#[cfg(test)]
mod tests {
    use super::parse;

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
}
