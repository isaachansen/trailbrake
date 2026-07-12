//! Tolerant extraction from the iRacing session-info YAML.
//!
//! The session string is YAML-ish but known to be *slightly malformed* (e.g.
//! unquoted driver names / team names containing `:`), which trips strict YAML
//! parsers. Rather than depend on a full parser and fight the quirks, we scan by
//! indentation for exactly the keys we need. Because we read "the rest of the
//! line" as each scalar value, odd characters in names don't break us.
//!
//! Parsed **only when `sessionInfoUpdate` changes**, never per frame.

use std::collections::HashMap;

/// Per-driver info from `DriverInfo.Drivers`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DriverEntry {
    pub car_idx: u32,
    pub user_name: Option<String>,
    /// Car model display name (e.g. "Ferrari 296 GT3").
    pub car_screen_name: Option<String>,
    /// Car number (e.g. "92").
    pub car_number: Option<String>,
    /// Short class name (e.g. "GT3").
    pub car_class_name: Option<String>,
    pub car_class_id: Option<u32>,
    /// Class color as 0xRRGGBB.
    pub class_color: Option<u32>,
    pub irating: Option<i32>,
    pub license: Option<String>,
    /// 2-letter country code (ISO 3166-1 alpha-2), from `LLCountry` / `Country`
    /// when present, else derived from `FlairID`.
    pub country: Option<String>,
    /// iRacing flair id — preferred nationality source when Country fields are empty.
    pub flair_id: Option<u32>,
    /// Position of this driver's pit stall as a fraction `0..1` of lap distance
    /// (`DriverInfo.Drivers[].DriverPitTrkPct`). Used to derive distance-to-box.
    pub pit_trk_pct: Option<f32>,
    /// Estimated lap time (s) for this car's class (`CarClassEstLapTime` from
    /// `DriverInfo.Drivers[]`). Used as the reference unit for multiclass gap
    /// normalisation (the "ruler" is always the chasing car's class estimate).
    pub car_class_est_lap_time: Option<f32>,
    /// True for the pace/safety car, so the connector can drop it from the field.
    pub is_pace_car: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionInfoMin {
    pub track_name: Option<String>,
    /// iRacing `WeekendInfo:TrackID`, used to look up the bundled track map.
    pub track_id: Option<u32>,
    pub driver_car_idx: Option<u32>,
    /// iRacing `DriverInfo:DriverCarEstLapTime` — the estimated lap time (s) for
    /// the player's car. Used to fold relative gaps into the shortest signed
    /// track distance so neighbours don't jump a full lap across start/finish.
    pub car_est_lap_time: Option<f32>,
    pub drivers: Vec<DriverEntry>,
    /// Session-type labels for **every** entry in `SessionInfo.Sessions[]`,
    /// keyed by `SessionNum` — e.g. `[(0, "Practice"), (1, "Qualify"),
    /// (2, "Race")]`. The live `SessionNum` telemetry var selects the active
    /// one (see [`SessionInfoMin::session_type_for`]), so the reported type
    /// tracks the weekend as it advances Practice→Qualy→Race.
    pub session_types: Vec<(i32, String)>,
    /// Sector-start fractions (0..1) from `SplitTimeInfo.Sectors[].SectorStartPct`,
    /// in `SectorNum` order. iRacing exposes only these boundaries — per-sector
    /// times are computed by the connector from `LapDistPct` crossings.
    pub sector_starts: Vec<f32>,
    /// Pit-lane speed limit (km/h) from `WeekendInfo:TrackPitSpeedLimit`. iRacing
    /// has no telemetry var for this; it lives in the session YAML.
    pub pit_speed_limit_kph: Option<f32>,
    /// Track length (meters) from `WeekendInfo:TrackLength` ("X.XX km"). Used to
    /// turn the pit-stall track-fraction into a distance.
    pub track_length_m: Option<f32>,
    /// Grid / results positions from `SessionInfo.Sessions[].ResultsPositions[]`,
    /// keyed by `(SessionNum, CarIdx) → (Position, ClassPosition)`. Populated as
    /// qualifying completes and when the race grid is formed — fills the gap
    /// before live `CarIdxPosition` is trustworthy.
    pub session_positions: HashMap<(i32, u32), (u32, u32)>,
    /// DQ incident threshold from `WeekendInfo.WeekendOptions.IncidentLimit`.
    /// `None` when the weekend is unlimited (or the key is absent / "unlimited").
    pub incident_limit: Option<u32>,
    /// Mechanical redline RPM from `DriverInfo:DriverCarRedLine`. Used as gauge
    /// max and fallback blink threshold when no Lovely car profile matches.
    pub driver_car_redline: Option<f32>,
    /// iRacing shift-indicator shift point from `DriverInfo:DriverCarSLShiftRPM`
    /// (the "shift now" RPM — just below blink).
    pub driver_car_sl_shift_rpm: Option<f32>,
    /// iRacing shift-indicator blink point from `DriverInfo:DriverCarSLBlinkRPM`
    /// (the RPM at which the strip starts flashing).
    pub driver_car_sl_blink_rpm: Option<f32>,
}

impl SessionInfoMin {
    /// The type label of session `num` (the live `SessionNum` telemetry var).
    /// Falls back to the first parsed session when `num` is unavailable or not
    /// found — better a best-effort label than none while telemetry warms up.
    pub fn session_type_for(&self, num: Option<i32>) -> Option<String> {
        num.and_then(|n| self.session_types.iter().find(|(sn, _)| *sn == n))
            .or_else(|| self.session_types.first())
            .map(|(_, label)| label.clone())
    }

    /// Results/grid position for a car in a given session, when the YAML block
    /// has been published (post-qualify grid, live qual results, etc.).
    pub fn session_position(&self, session_num: i32, car_idx: u32) -> Option<(u32, u32)> {
        self.session_positions.get(&(session_num, car_idx)).copied()
    }
}

/// Decode iRacing's NUL-terminated session-info block.
///
/// Current SDK data is usually UTF-8, but older / localized strings can arrive
/// in the Windows ANSI code page. Decoding those bytes as UTF-8 lossy would turn
/// accented driver names into replacement characters, so fall back to
/// Windows-1252 when UTF-8 is not valid.
pub fn decode_session_info(raw: &[u8]) -> String {
    let nul = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    let bytes = &raw[..nul];
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => decode_windows_1252(bytes),
    }
}

fn decode_windows_1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80 => '\u{20AC}',
            0x82 => '\u{201A}',
            0x83 => '\u{0192}',
            0x84 => '\u{201E}',
            0x85 => '\u{2026}',
            0x86 => '\u{2020}',
            0x87 => '\u{2021}',
            0x88 => '\u{02C6}',
            0x89 => '\u{2030}',
            0x8A => '\u{0160}',
            0x8B => '\u{2039}',
            0x8C => '\u{0152}',
            0x8E => '\u{017D}',
            0x91 => '\u{2018}',
            0x92 => '\u{2019}',
            0x93 => '\u{201C}',
            0x94 => '\u{201D}',
            0x95 => '\u{2022}',
            0x96 => '\u{2013}',
            0x97 => '\u{2014}',
            0x98 => '\u{02DC}',
            0x99 => '\u{2122}',
            0x9A => '\u{0161}',
            0x9B => '\u{203A}',
            0x9C => '\u{0153}',
            0x9E => '\u{017E}',
            0x9F => '\u{0178}',
            0x81 | 0x8D | 0x8F | 0x90 | 0x9D => '\u{FFFD}',
            _ => char::from_u32(b as u32).unwrap_or('\u{FFFD}'),
        })
        .collect()
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches(|c| c == '"' || c == '\'').to_string()
}

/// Parse a possibly-`0x`-prefixed color/int into a `u32`.
fn parse_color(s: &str) -> Option<u32> {
    let t = s.trim();
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16).ok()
    } else {
        t.parse::<u32>().ok()
    }
}

/// Parse the leading number out of a value like `"80.00 kph"` or `"4.318 km"`.
fn parse_leading_f32(s: &str) -> Option<f32> {
    let t = s.trim();
    let end = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))
        .unwrap_or(t.len());
    t[..end].parse::<f32>().ok().filter(|v| v.is_finite())
}

/// Parse `WeekendOptions:IncidentLimit` — a positive integer, or `unlimited`.
fn parse_incident_limit(raw: Option<String>) -> Option<u32> {
    let s = raw?.trim().to_string();
    if s.is_empty() || s.eq_ignore_ascii_case("unlimited") {
        return None;
    }
    s.parse().ok().filter(|&n| n > 0)
}

/// Find the value of the first line whose trimmed content starts with `"{key}:"`.
fn scan_value(yaml: &str, key: &str) -> Option<String> {
    let needle = format!("{key}:");
    for line in yaml.lines() {
        if let Some(rest) = line.trim_start().strip_prefix(&needle) {
            let v = unquote(rest);
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

pub fn parse_min(yaml: &str) -> SessionInfoMin {
    let mut info = SessionInfoMin {
        track_name: scan_value(yaml, "TrackDisplayName").or_else(|| scan_value(yaml, "TrackName")),
        track_id: scan_value(yaml, "TrackID").and_then(|s| s.parse().ok()),
        driver_car_idx: None,
        car_est_lap_time: None,
        drivers: Vec::new(),
        session_types: Vec::new(),
        sector_starts: Vec::new(),
        // WeekendInfo values: "80.00 kph" / "4.318 km" — take the leading number.
        pit_speed_limit_kph: scan_value(yaml, "TrackPitSpeedLimit").and_then(|s| parse_leading_f32(&s)),
        track_length_m: scan_value(yaml, "TrackLength")
            .and_then(|s| parse_leading_f32(&s))
            .map(|km| km * 1000.0),
        session_positions: scan_session_positions(yaml),
        incident_limit: parse_incident_limit(scan_value(yaml, "IncidentLimit")),
        driver_car_redline: None,
        driver_car_sl_shift_rpm: None,
        driver_car_sl_blink_rpm: None,
    };

    let lines: Vec<&str> = yaml.lines().collect();
    let mut i = 0;
    // Locate the top-level `DriverInfo:` block.
    while i < lines.len() {
        if indent(lines[i]) == 0 && lines[i].trim_start().starts_with("DriverInfo:") {
            i += 1;
            break;
        }
        i += 1;
    }

    // Walk the block until a new top-level key (indent 0, non-empty).
    while i < lines.len() {
        let line = lines[i];
        if !line.trim().is_empty() && indent(line) == 0 {
            break;
        }
        let t = line.trim_start();

        if let Some(v) = t.strip_prefix("DriverCarIdx:") {
            info.driver_car_idx = v.trim().parse().ok();
            i += 1;
            continue;
        }

        if let Some(v) = t.strip_prefix("DriverCarEstLapTime:") {
            info.car_est_lap_time = v.trim().parse().ok().filter(|&l: &f32| l.is_finite() && l > 0.0);
            i += 1;
            continue;
        }

        if let Some(v) = t.strip_prefix("DriverCarRedLine:") {
            info.driver_car_redline = v.trim().parse().ok().filter(|&r: &f32| r.is_finite() && r > 0.0);
            i += 1;
            continue;
        }

        if let Some(v) = t.strip_prefix("DriverCarSLShiftRPM:") {
            info.driver_car_sl_shift_rpm = v.trim().parse().ok().filter(|&r: &f32| r.is_finite() && r > 0.0);
            i += 1;
            continue;
        }

        if let Some(v) = t.strip_prefix("DriverCarSLBlinkRPM:") {
            info.driver_car_sl_blink_rpm = v.trim().parse().ok().filter(|&r: &f32| r.is_finite() && r > 0.0);
            i += 1;
            continue;
        }

        if let Some(v) = t.strip_prefix("- CarIdx:") {
            let entry_indent = indent(line);
            let mut d = DriverEntry {
                car_idx: v.trim().parse().unwrap_or(0),
                ..Default::default()
            };
            i += 1;
            // Capture this driver's fields until the next list item / dedent.
            while i < lines.len() {
                let dl = lines[i];
                if dl.trim().is_empty() {
                    i += 1;
                    continue;
                }
                if indent(dl) <= entry_indent {
                    break;
                }
                let dt = dl.trim_start();
                if let Some(x) = dt.strip_prefix("UserName:") {
                    d.user_name = Some(unquote(x));
                } else if let Some(x) = dt.strip_prefix("CarScreenName:") {
                    d.car_screen_name = Some(unquote(x));
                } else if let Some(x) = dt.strip_prefix("CarNumber:") {
                    d.car_number = Some(unquote(x));
                } else if let Some(x) = dt.strip_prefix("CarNumberRaw:") {
                    if d.car_number.is_none() {
                        d.car_number = Some(x.trim().to_string());
                    }
                } else if let Some(x) = dt.strip_prefix("CarClassShortName:") {
                    d.car_class_name = Some(unquote(x));
                } else if let Some(x) = dt.strip_prefix("CarClassID:") {
                    d.car_class_id = x.trim().parse().ok();
                } else if let Some(x) = dt.strip_prefix("CarClassColor:") {
                    d.class_color = parse_color(x);
                } else if let Some(x) = dt.strip_prefix("IRating:") {
                    d.irating = x.trim().parse().ok();
                } else if let Some(x) = dt.strip_prefix("LicString:") {
                    d.license = Some(unquote(x));
                } else if let Some(x) = dt.strip_prefix("CarIsPaceCar:") {
                    d.is_pace_car = x.trim() == "1";
                } else if let Some(x) = dt.strip_prefix("CarPath:") {
                    // CarPath often embeds a locale/region; not used directly.
                    let _ = x;
                } else if let Some(x) = dt.strip_prefix("FlairID:") {
                    d.flair_id = x.trim().parse().ok().filter(|&id| id > 0);
                } else if let Some(x) = dt.strip_prefix("LLCountry:") {
                    // Per-driver locale country (ISO code) — often empty in live sessions.
                    let c = unquote(x);
                    if !c.is_empty() {
                        d.country = Some(c);
                    }
                } else if let Some(x) = dt.strip_prefix("Country:") {
                    // Fallback country field — also often empty now.
                    let c = unquote(x);
                    if !c.is_empty() && d.country.is_none() {
                        d.country = Some(c);
                    }
                } else if let Some(x) = dt.strip_prefix("DriverPitTrkPct:") {
                    d.pit_trk_pct = x.trim().parse().ok().filter(|p: &f32| p.is_finite());
                } else if let Some(x) = dt.strip_prefix("CarClassEstLapTime:") {
                    d.car_class_est_lap_time = x.trim().parse().ok().filter(|&v: &f32| v.is_finite() && v > 0.0);
                }
                i += 1;
            }
            // Live sessions leave Country/LLCountry blank; FlairID is the
            // nationality signal iRacing still publishes.
            if d.country.is_none() {
                d.country = crate::flair::country_from_flair(d.flair_id);
            }
            info.drivers.push(d);
            continue;
        }

        i += 1;
    }

    // Parse every session's type from `SessionInfo.Sessions[]`, keyed by
    // `SessionNum`; the connector selects the active one with the live
    // `SessionNum` telemetry var each poll.
    info.session_types = scan_session_types(yaml);

    info.sector_starts = scan_sector_starts(yaml);

    info
}

/// Extract sector-start fractions from the `SplitTimeInfo.Sectors[]` block.
/// Returns the `SectorStartPct` values ordered by `SectorNum`.
///
/// Example block:
/// ```text
/// SplitTimeInfo:
///  Sectors:
///  - SectorNum: 0
///    SectorStartPct: 0.0000
///  - SectorNum: 1
///    SectorStartPct: 0.297693
/// ```
fn scan_sector_starts(yaml: &str) -> Vec<f32> {
    let lines: Vec<&str> = yaml.lines().collect();
    let mut i = 0;
    // Find `SplitTimeInfo:` at indent 0.
    while i < lines.len() {
        if indent(lines[i]) == 0 && lines[i].trim_start().starts_with("SplitTimeInfo:") {
            i += 1;
            break;
        }
        i += 1;
    }

    // Collect (num, pct) pairs walking the block until a new top-level key.
    let mut sectors: Vec<(i32, f32)> = Vec::new();
    let mut cur_num: Option<i32> = None;
    let mut cur_pct: Option<f32> = None;
    while i < lines.len() {
        let line = lines[i];
        if !line.trim().is_empty() && indent(line) == 0 {
            break;
        }
        let t = line.trim_start();
        if let Some(v) = t.strip_prefix("- SectorNum:") {
            // Flush any in-progress entry before starting the next one.
            if let (Some(n), Some(p)) = (cur_num.take(), cur_pct.take()) {
                sectors.push((n, p));
            }
            cur_num = v.trim().parse().ok();
            cur_pct = None;
        } else if let Some(v) = t.strip_prefix("SectorNum:") {
            // Some builds put SectorNum on its own line under the list item.
            cur_num = v.trim().parse().ok();
        } else if let Some(v) = t.strip_prefix("SectorStartPct:") {
            cur_pct = v.trim().parse().ok();
        }
        i += 1;
    }
    if let (Some(n), Some(p)) = (cur_num, cur_pct) {
        sectors.push((n, p));
    }

    sectors.sort_by_key(|&(n, _)| n);
    sectors.into_iter().map(|(_, p)| p).collect()
}

/// Extract `(SessionNum, type label)` for every entry in the
/// `SessionInfo.Sessions[]` block. Each entry's label comes from its
/// `SessionType` (e.g. "Open_Qualify", normalized) or falls back to its
/// `SessionName`.
///
/// Example block:
/// ```text
/// SessionInfo:
///  Sessions:
///  - SessionNum: 0
///    SessionType: Practice
///  - SessionNum: 1
///    SessionType: Lone_Qualify
///  - SessionNum: 2
///    SessionType: Race
/// ```
fn scan_session_types(yaml: &str) -> Vec<(i32, String)> {
    let lines: Vec<&str> = yaml.lines().collect();
    let mut i = 0;
    // Find `SessionInfo:` at indent 0.
    while i < lines.len() {
        if indent(lines[i]) == 0 && lines[i].trim_start().starts_with("SessionInfo:") {
            i += 1;
            break;
        }
        i += 1;
    }

    // Collect per-entry (num, type, name), flushing at each new list item.
    fn flush(
        out: &mut Vec<(i32, String)>,
        num: &mut Option<i32>,
        ty: &mut Option<String>,
        name: &mut Option<String>,
    ) {
        if let (Some(n), Some(label)) = (num.take(), ty.take().or_else(|| name.take())) {
            out.push((n, label));
        }
        *ty = None;
        *name = None;
    }

    let mut out: Vec<(i32, String)> = Vec::new();
    let mut cur_num: Option<i32> = None;
    let mut cur_type: Option<String> = None;
    let mut cur_name: Option<String> = None;
    while i < lines.len() {
        let line = lines[i];
        if !line.trim().is_empty() && indent(line) == 0 {
            break;
        }
        let t = line.trim_start();
        if let Some(v) = t.strip_prefix("- SessionNum:") {
            flush(&mut out, &mut cur_num, &mut cur_type, &mut cur_name);
            cur_num = v.trim().parse().ok();
        } else if let Some(x) = t.strip_prefix("SessionType:") {
            cur_type = Some(normalize_session_type(&unquote(x)));
        } else if let Some(x) = t.strip_prefix("SessionName:") {
            cur_name = Some(unquote(x));
        }
        i += 1;
    }
    flush(&mut out, &mut cur_num, &mut cur_type, &mut cur_name);
    out
}

fn flush_result_entry(
    out: &mut HashMap<(i32, u32), (u32, u32)>,
    session_num: Option<i32>,
    cur_car: &mut Option<u32>,
    cur_pos: &mut Option<u32>,
    cur_class: &mut Option<u32>,
) {
    // YAML `Position` and `ClassPosition` are 0-based; live `CarIdxPosition`
    // and `CarIdxClassPosition` are 1-based. Normalize both YAML fields here so
    // the leader (`Position: 0`) is retained as P1.
    if let (Some(sn), Some(ci), Some(p)) = (session_num, cur_car.take(), cur_pos.take()) {
        let raw_class = cur_class.take();
        if let Some(position) = p.checked_add(1) {
            let class_position = raw_class
                .and_then(|class| class.checked_add(1))
                .unwrap_or(position);
            out.insert((sn, ci), (position, class_position));
        }
    } else {
        *cur_car = None;
        *cur_pos = None;
        *cur_class = None;
    }
}

/// Extract grid/results positions from each session's `ResultsPositions[]` block.
fn scan_session_positions(yaml: &str) -> HashMap<(i32, u32), (u32, u32)> {
    let lines: Vec<&str> = yaml.lines().collect();
    let mut out: HashMap<(i32, u32), (u32, u32)> = HashMap::new();
    let mut i = 0;
    while i < lines.len() {
        if indent(lines[i]) == 0 && lines[i].trim_start().starts_with("SessionInfo:") {
            i += 1;
            break;
        }
        i += 1;
    }

    let mut session_num: Option<i32> = None;
    let mut in_results = false;
    let mut results_indent = 0;
    let mut entry_indent = 0;
    let mut cur_car: Option<u32> = None;
    let mut cur_pos: Option<u32> = None;
    let mut cur_class: Option<u32> = None;

    while i < lines.len() {
        let line = lines[i];
        if !line.trim().is_empty() && indent(line) == 0 {
            break;
        }
        let ind = indent(line);
        let t = line.trim_start();

        if let Some(v) = t.strip_prefix("- SessionNum:") {
            flush_result_entry(&mut out, session_num, &mut cur_car, &mut cur_pos, &mut cur_class);
            in_results = false;
            session_num = v.trim().parse().ok();
        } else if t.starts_with("ResultsPositions:") {
            flush_result_entry(&mut out, session_num, &mut cur_car, &mut cur_pos, &mut cur_class);
            in_results = true;
            results_indent = ind;
            entry_indent = 0;
        } else if in_results {
            let leave_results = ind < results_indent
                || (ind == results_indent && !t.starts_with("- ") && !t.starts_with("ResultsPositions:"));
            if leave_results {
                flush_result_entry(&mut out, session_num, &mut cur_car, &mut cur_pos, &mut cur_class);
                in_results = false;
            } else if t.starts_with("- ") {
                flush_result_entry(&mut out, session_num, &mut cur_car, &mut cur_pos, &mut cur_class);
                entry_indent = ind;
                if let Some(x) = t.strip_prefix("- Position:") {
                    cur_pos = x.trim().parse().ok();
                } else if let Some(x) = t.strip_prefix("- CarIdx:") {
                    cur_car = x.trim().parse().ok();
                } else if let Some(x) = t.strip_prefix("- ClassPosition:") {
                    cur_class = x.trim().parse().ok();
                }
            } else if entry_indent > 0 && ind > entry_indent {
                if let Some(x) = t.strip_prefix("Position:") {
                    cur_pos = x.trim().parse().ok();
                } else if let Some(x) = t.strip_prefix("ClassPosition:") {
                    cur_class = x.trim().parse().ok();
                } else if let Some(x) = t.strip_prefix("CarIdx:") {
                    cur_car = x.trim().parse().ok();
                }
            }
        }
        i += 1;
    }
    flush_result_entry(&mut out, session_num, &mut cur_car, &mut cur_pos, &mut cur_class);
    out
}

/// Map iRacing session type strings to a coarse label widgets can switch on.
fn normalize_session_type(raw: &str) -> String {
    let r = raw.trim();
    match r {
        "Race" => r.to_string(),
        "Lone_Qualify" | "Open_Qualify" => "Qualify".to_string(),
        "Practice" | "Warmup" => "Practice".to_string(),
        s if s.contains("Qual") => "Qualify".to_string(),
        s if s.contains("Practice") || s.contains("Warmup") => "Practice".to_string(),
        s if s.contains("Race") => "Race".to_string(),
        _ => r.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A trimmed, slightly-malformed-style sample (note the unquoted name with a
    // colon, which strict YAML would choke on).
    const SAMPLE: &str = "\
---
WeekendInfo:
 TrackName: spa
 TrackID: 18
 TrackDisplayName: Circuit de Spa-Francorchamps
DriverInfo:
 DriverCarIdx: 2
 DriverCarEstLapTime: 88.5417
 Drivers:
 - CarIdx: 0
   UserName: Max: The Racer
   CarScreenName: Ferrari 296 GT3
   CarClassID: 84
   CarClassColor: 0xff5252
   CarClassEstLapTime: 92.3
   IRating: 4210
   LicString: A 3.99
   LLCountry: FR
 - CarIdx: 2
   UserName: Jane Doe
   CarClassID: 84
   CarClassColor: 0x42a5f5
   CarClassEstLapTime: 88.5417
   IRating: 3320
   LicString: B 2.50
   Country: US
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Open_Qualify
   SessionName: Open Qualify
SplitTimeInfo:
 Sectors:
 - SectorNum: 0
   SectorStartPct: 0.0000
 - SectorNum: 1
   SectorStartPct: 0.297693
 - SectorNum: 2
   SectorStartPct: 0.658859
 ";

    #[test]
    fn parses_track_and_drivers() {
        let info = parse_min(SAMPLE);
        assert_eq!(
            info.track_name.as_deref(),
            Some("Circuit de Spa-Francorchamps")
        );
        assert_eq!(info.track_id, Some(18));
        assert_eq!(info.driver_car_idx, Some(2));
        assert_eq!(info.drivers.len(), 2);

        let d0 = &info.drivers[0];
        assert_eq!(d0.car_idx, 0);
        assert_eq!(d0.user_name.as_deref(), Some("Max: The Racer"));
        assert_eq!(d0.car_screen_name.as_deref(), Some("Ferrari 296 GT3"));
        assert_eq!(d0.car_class_id, Some(84));
        assert_eq!(d0.class_color, Some(0xff5252));
        assert_eq!(d0.irating, Some(4210));
        assert_eq!(d0.license.as_deref(), Some("A 3.99"));
        assert_eq!(d0.country.as_deref(), Some("FR"));

        let d1 = &info.drivers[1];
        assert_eq!(d1.car_idx, 2);
        assert_eq!(d1.user_name.as_deref(), Some("Jane Doe"));
        assert_eq!(d1.class_color, Some(0x42a5f5));
        assert_eq!(d1.country.as_deref(), Some("US"));
    }

    #[test]
    fn parses_est_lap_time() {
        let info = parse_min(SAMPLE);
        assert_eq!(info.car_est_lap_time, Some(88.5417));
    }

    #[test]
    fn parses_car_class_est_lap_time_per_driver() {
        let info = parse_min(SAMPLE);
        // Each driver's class estimate is parsed individually.
        let d0 = &info.drivers[0];
        assert_eq!(d0.car_idx, 0);
        assert!((d0.car_class_est_lap_time.unwrap() - 92.3).abs() < 1e-4);
        let d1 = &info.drivers[1];
        assert_eq!(d1.car_idx, 2);
        assert!((d1.car_class_est_lap_time.unwrap() - 88.5417).abs() < 1e-4);
    }

    #[test]
    fn car_class_est_lap_time_absent_is_none() {
        let yaml = "---\nDriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   UserName: A\n";
        let info = parse_min(yaml);
        assert_eq!(info.drivers[0].car_class_est_lap_time, None);
    }

    #[test]
    fn est_lap_time_absent_is_none() {
        let yaml = "---\nDriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   UserName: A\n";
        let info = parse_min(yaml);
        assert_eq!(info.car_est_lap_time, None);
    }

    #[test]
    fn parses_car_number_raw_when_car_number_missing() {
        let yaml = "---\nDriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   UserName: A\n   CarNumberRaw: 64\n";
        let info = parse_min(yaml);
        assert_eq!(info.drivers[0].car_number.as_deref(), Some("64"));
    }

    #[test]
    fn car_number_wins_over_car_number_raw() {
        let yaml = "---\nDriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   UserName: A\n   CarNumber: \"064\"\n   CarNumberRaw: 64\n";
        let info = parse_min(yaml);
        assert_eq!(info.drivers[0].car_number.as_deref(), Some("064"));
    }

    #[test]
    fn parses_results_positions_per_session() {
        let yaml = "\
---
SessionInfo:
 Sessions:
 - SessionNum: 1
   SessionType: Lone_Qualify
   ResultsPositions:
   - Position: 0
     ClassPosition: 0
     CarIdx: 5
   - Position: 1
     ClassPosition: 1
     CarIdx: 12
 - SessionNum: 2
   SessionType: Race
   ResultsPositions:
   - Position: 0
     ClassPosition: 0
     CarIdx: 12
   - Position: 1
     ClassPosition: 1
     CarIdx: 5
";
        let info = parse_min(yaml);
        // Both positions are stored 1-based after the 0-based YAML conversion.
        assert_eq!(info.session_position(1, 5), Some((1, 1)));
        assert_eq!(info.session_position(1, 12), Some((2, 2)));
        assert_eq!(info.session_position(2, 12), Some((1, 1)));
        assert_eq!(info.session_position(2, 5), Some((2, 2)));
    }

    #[test]
    fn zero_results_position_is_the_leader() {
        let yaml = "\
---
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Practice
   ResultsPositions:
   - Position: 0
     ClassPosition: 0
     CarIdx: 3
   - Position: 1
     ClassPosition: 0
     CarIdx: 5
";
        let info = parse_min(yaml);
        assert_eq!(info.session_position(0, 3), Some((1, 1)));
        assert_eq!(info.session_position(0, 5), Some((2, 1)));
    }

    #[test]
    fn parses_incident_limit() {
        let limited = parse_min(
            "---\nWeekendInfo:\n WeekendOptions:\n  IncidentLimit: 17\n",
        );
        assert_eq!(limited.incident_limit, Some(17));
        let unlimited = parse_min(
            "---\nWeekendInfo:\n WeekendOptions:\n  IncidentLimit: unlimited\n",
        );
        assert_eq!(unlimited.incident_limit, None);
    }

    #[test]
    fn flair_id_fills_country_when_locale_empty() {
        let yaml = "\
---
DriverInfo:
 DriverCarIdx: 0
 Drivers:
 - CarIdx: 0
   UserName: A
   FlairID: 71
 - CarIdx: 1
   UserName: B
   FlairID: 223
   LLCountry: DE
";
        let info = parse_min(yaml);
        assert_eq!(info.drivers[0].flair_id, Some(71));
        assert_eq!(info.drivers[0].country.as_deref(), Some("FR")); // from flair
        assert_eq!(info.drivers[1].country.as_deref(), Some("DE")); // LLCountry wins
    }

    #[test]
    fn parses_session_type() {
        let info = parse_min(SAMPLE);
        assert_eq!(info.session_types, vec![(0, "Qualify".to_string())]);
        assert_eq!(info.session_type_for(Some(0)).as_deref(), Some("Qualify"));
    }

    // A Practice→Qualy→Race weekend's `SessionInfo` block (types as iRacing
    // emits them, pre-normalization).
    const MULTI_SESSION: &str = "\
---
WeekendInfo:
 TrackName: spa
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Practice
   SessionName: PRACTICE
 - SessionNum: 1
   SessionType: Lone_Qualify
   SessionName: QUALIFY
 - SessionNum: 2
   SessionType: Race
   SessionName: RACE
SplitTimeInfo:
 Sectors:
 - SectorNum: 0
   SectorStartPct: 0.0000
 ";

    #[test]
    fn parses_all_session_types_keyed_by_num() {
        let info = parse_min(MULTI_SESSION);
        assert_eq!(
            info.session_types,
            vec![
                (0, "Practice".to_string()),
                (1, "Qualify".to_string()),
                (2, "Race".to_string()),
            ]
        );
    }

    /// Live `SessionNum` selects the active session's type — the fix for the
    /// "Practice all weekend" bug (audit B1).
    #[test]
    fn session_type_follows_live_session_num() {
        let info = parse_min(MULTI_SESSION);
        assert_eq!(info.session_type_for(Some(0)).as_deref(), Some("Practice"));
        assert_eq!(info.session_type_for(Some(1)).as_deref(), Some("Qualify"));
        assert_eq!(info.session_type_for(Some(2)).as_deref(), Some("Race"));
        // Unknown / missing SessionNum → best-effort first session.
        assert_eq!(info.session_type_for(Some(9)).as_deref(), Some("Practice"));
        assert_eq!(info.session_type_for(None).as_deref(), Some("Practice"));
        // No sessions parsed at all → honest None, never a guess.
        assert_eq!(SessionInfoMin::default().session_type_for(Some(0)), None);
    }

    /// An entry with no `SessionType` falls back to its `SessionName`.
    #[test]
    fn session_type_falls_back_to_name() {
        let yaml = "---\nSessionInfo:\n Sessions:\n - SessionNum: 0\n   SessionName: HOSTED FUN\n";
        let info = parse_min(yaml);
        assert_eq!(info.session_types, vec![(0, "HOSTED FUN".to_string())]);
    }

    #[test]
    fn parses_sector_starts() {
        let info = parse_min(SAMPLE);
        assert_eq!(info.sector_starts.len(), 3);
        assert!((info.sector_starts[0] - 0.0).abs() < 1e-6);
        assert!((info.sector_starts[1] - 0.297693).abs() < 1e-6);
        assert!((info.sector_starts[2] - 0.658859).abs() < 1e-6);
    }

    #[test]
    fn sector_starts_empty_when_block_absent() {
        let yaml = "---\nWeekendInfo:\n TrackName: spa\nDriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   UserName: A\n";
        let info = parse_min(yaml);
        assert!(info.sector_starts.is_empty());
    }

    #[test]
    fn sector_starts_sorted_by_num() {
        // Out-of-order SectorNum should still come back ordered.
        let yaml = "---\nSplitTimeInfo:\n Sectors:\n - SectorNum: 2\n   SectorStartPct: 0.6\n - SectorNum: 0\n   SectorStartPct: 0.0\n - SectorNum: 1\n   SectorStartPct: 0.3\n";
        let info = parse_min(yaml);
        assert_eq!(info.sector_starts.len(), 3);
        assert!((info.sector_starts[0] - 0.0).abs() < 1e-6);
        assert!((info.sector_starts[1] - 0.3).abs() < 1e-6);
        assert!((info.sector_starts[2] - 0.6).abs() < 1e-6);
    }

    #[test]
    fn stops_at_next_top_level_key() {
        // Drivers must not bleed into SessionInfo.
        let info = parse_min(SAMPLE);
        assert!(info
            .drivers
            .iter()
            .all(|d| d.car_idx == 0 || d.car_idx == 2));
    }

    #[test]
    fn decodes_windows_1252_driver_names() {
        let raw = b"---\nDriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   UserName: Jos\xe9 Mart\xednez\n\0ignored";
        let yaml = decode_session_info(raw);
        let info = parse_min(&yaml);
        assert_eq!(
            info.drivers[0].user_name.as_deref(),
            Some("Jos\u{e9} Mart\u{ed}nez")
        );
    }

    #[test]
    fn preserves_utf8_extended_latin_driver_names() {
        let raw = "---\nDriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   UserName: M\u{101}ris Ozoli\u{146}\u{161}\n"
            .as_bytes();
        let yaml = decode_session_info(raw);
        let info = parse_min(&yaml);
        assert_eq!(
            info.drivers[0].user_name.as_deref(),
            Some("M\u{101}ris Ozoli\u{146}\u{161}")
        );
    }
}
