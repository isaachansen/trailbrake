//! iRacing-only standings position resolution.
//!
//! Widgets show `classPosition ?? position` (Relative) or
//! `position ?? classPosition` (Standings). If one side is left empty, a live
//! class-P27 and a fallback overall-P27 both render as "27".
//!
//! So every car always gets **both** fields:
//! 1. Live `CarIdx*` when present (YAML ignored once any live ranks exist —
//!    mixing them caused duplicates).
//! 2. Else current-session / qualify `ResultsPositions`.
//! 3. Else / for cars still missing: car-number order, uniquely appended.
//!
//! LMU and other connectors never call this.

use std::collections::{HashMap, HashSet};

use crate::session::SessionInfoMin;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedPos {
    pub position: Option<u32>,
    pub class_position: Option<u32>,
    /// True when the value did not come from live `CarIdx*` telemetry.
    pub provisional: bool,
}

#[derive(Clone, Debug)]
pub struct DriverPosInput {
    pub car_idx: u32,
    pub car_number: Option<String>,
    pub car_class_id: Option<u32>,
    pub live_position: Option<u32>,
    pub live_class_position: Option<u32>,
}

/// Resolve overall + class positions for the field.
pub fn resolve_field_positions(
    drivers: &[DriverPosInput],
    session: &SessionInfoMin,
    session_num: Option<i32>,
) -> HashMap<u32, ResolvedPos> {
    let current = session_num
        .map(|sn| results_for_session(session, sn))
        .unwrap_or_default();
    let qualify = qualify_results(session);

    let any_live = drivers
        .iter()
        .any(|d| d.live_position.is_some() || d.live_class_position.is_some());

    let mut out: HashMap<u32, ResolvedPos> = HashMap::with_capacity(drivers.len());
    let mut missing: Vec<&DriverPosInput> = Vec::new();

    if any_live {
        for d in drivers {
            if d.live_position.is_some() || d.live_class_position.is_some() {
                out.insert(
                    d.car_idx,
                    ResolvedPos {
                        position: d.live_position,
                        class_position: d.live_class_position,
                        provisional: false,
                    },
                );
            } else {
                missing.push(d);
            }
        }
    } else {
        for d in drivers {
            // Session scan 1-bases both positions; still guard so a stale or
            // manually constructed zero never blocks car-number fallback.
            if let Some((p, c)) = current
                .get(&d.car_idx)
                .copied()
                .or_else(|| qualify.get(&d.car_idx).copied())
                .filter(|(p, _)| *p > 0)
            {
                out.insert(
                    d.car_idx,
                    ResolvedPos {
                        position: Some(p),
                        class_position: if c > 0 { Some(c) } else { None },
                        provisional: true,
                    },
                );
            } else {
                missing.push(d);
            }
        }
    }

    append_by_car_number(&mut out, drivers, &mut missing);
    // Guarantee every driver is present before filling missing sides — a car
    // that somehow skipped live/YAML/append must not leave the UI with `--`.
    for d in drivers {
        out.entry(d.car_idx).or_insert(ResolvedPos {
            position: None,
            class_position: None,
            provisional: true,
        });
    }
    ensure_both_sides(&mut out, drivers);
    out
}

/// Every car gets both overall (globally unique) and class (unique within class).
fn ensure_both_sides(out: &mut HashMap<u32, ResolvedPos>, drivers: &[DriverPosInput]) {
    let class_of: HashMap<u32, u32> = drivers
        .iter()
        .map(|d| (d.car_idx, d.car_class_id.unwrap_or(0)))
        .collect();

    let mut used_overall: HashSet<u32> = out.values().filter_map(|r| r.position).collect();

    let mut need_overall: Vec<u32> = out
        .iter()
        .filter(|(_, r)| r.position.is_none())
        .map(|(&id, _)| id)
        .collect();
    need_overall.sort_by_key(|id| {
        (
            class_of.get(id).copied().unwrap_or(0),
            out.get(id).and_then(|r| r.class_position).unwrap_or(999),
            *id,
        )
    });
    let mut next = 1u32;
    for id in need_overall {
        while used_overall.contains(&next) {
            next += 1;
        }
        if let Some(r) = out.get_mut(&id) {
            r.position = Some(next);
        }
        used_overall.insert(next);
        next += 1;
    }

    let mut used_class: HashMap<u32, HashSet<u32>> = HashMap::new();
    for d in drivers {
        let class_id = d.car_class_id.unwrap_or(0);
        if let Some(cp) = out.get(&d.car_idx).and_then(|r| r.class_position) {
            used_class.entry(class_id).or_default().insert(cp);
        }
    }

    let mut need_class: Vec<(u32, u32)> = out
        .iter()
        .filter(|(_, r)| r.class_position.is_none())
        .map(|(&id, _)| (id, class_of.get(&id).copied().unwrap_or(0)))
        .collect();
    need_class.sort_by_key(|(id, class_id)| {
        (
            *class_id,
            out.get(id).and_then(|r| r.position).unwrap_or(999),
            *id,
        )
    });
    for (id, class_id) in need_class {
        let used = used_class.entry(class_id).or_default();
        let mut next_c = 1u32;
        while used.contains(&next_c) {
            next_c += 1;
        }
        if let Some(r) = out.get_mut(&id) {
            r.class_position = Some(next_c);
        }
        used.insert(next_c);
    }
}

fn append_by_car_number(
    out: &mut HashMap<u32, ResolvedPos>,
    drivers: &[DriverPosInput],
    missing: &mut Vec<&DriverPosInput>,
) {
    if missing.is_empty() {
        return;
    }
    missing.sort_by(|a, b| cmp_car_number(a.car_number.as_deref(), b.car_number.as_deref()));

    if out.is_empty() {
        let mut class_counts: HashMap<u32, u32> = HashMap::new();
        for (i, d) in missing.iter().enumerate() {
            let class_id = d.car_class_id.unwrap_or(0);
            let class_pos = class_counts.get(&class_id).copied().unwrap_or(0) + 1;
            class_counts.insert(class_id, class_pos);
            out.insert(
                d.car_idx,
                ResolvedPos {
                    position: Some((i as u32) + 1),
                    class_position: Some(class_pos),
                    provisional: true,
                },
            );
        }
        return;
    }

    let mut used_overall: HashSet<u32> = out.values().filter_map(|r| r.position).collect();
    let mut class_counts: HashMap<u32, u32> = HashMap::new();
    for d in drivers {
        if let Some(cp) = out.get(&d.car_idx).and_then(|r| r.class_position) {
            let class_id = d.car_class_id.unwrap_or(0);
            let prev = class_counts.get(&class_id).copied().unwrap_or(0);
            if cp > prev {
                class_counts.insert(class_id, cp);
            }
        }
    }

    let mut next = 1u32;
    for d in missing.iter() {
        while used_overall.contains(&next) {
            next += 1;
        }
        let class_id = d.car_class_id.unwrap_or(0);
        let class_pos = class_counts.get(&class_id).copied().unwrap_or(0) + 1;
        class_counts.insert(class_id, class_pos);
        out.insert(
            d.car_idx,
            ResolvedPos {
                position: Some(next),
                class_position: Some(class_pos),
                provisional: true,
            },
        );
        used_overall.insert(next);
        next += 1;
    }
}

fn results_for_session(session: &SessionInfoMin, sn: i32) -> HashMap<u32, (u32, u32)> {
    session
        .session_positions
        .iter()
        .filter(|((s, _), _)| *s == sn)
        .map(|((_, car), pos)| (*car, *pos))
        .collect()
}

fn qualify_results(session: &SessionInfoMin) -> HashMap<u32, (u32, u32)> {
    let mut out = HashMap::new();
    for (sn, label) in &session.session_types {
        if !label.eq_ignore_ascii_case("Qualify") {
            continue;
        }
        for ((s, car), pos) in &session.session_positions {
            if s == sn {
                out.insert(*car, *pos);
            }
        }
    }
    out
}

fn cmp_car_number(a: Option<&str>, b: Option<&str>) -> std::cmp::Ordering {
    match (parse_car_num(a), parse_car_num(b)) {
        (Some(na), Some(nb)) => na.cmp(&nb),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.unwrap_or("").cmp(b.unwrap_or("")),
    }
}

fn parse_car_num(s: Option<&str>) -> Option<i32> {
    s.and_then(|raw| {
        let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            None
        } else {
            digits.parse().ok()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionInfoMin;
    use std::collections::HashSet;

    fn driver(idx: u32, num: &str, class: u32) -> DriverPosInput {
        DriverPosInput {
            car_idx: idx,
            car_number: Some(num.into()),
            car_class_id: Some(class),
            live_position: None,
            live_class_position: None,
        }
    }

    fn assert_complete_and_unique_overall(map: &HashMap<u32, ResolvedPos>) {
        let mut overall = HashSet::new();
        for r in map.values() {
            assert!(r.position.is_some(), "every car needs overall");
            assert!(r.class_position.is_some(), "every car needs class");
            let p = r.position.unwrap();
            assert!(overall.insert(p), "duplicate overall position {p}");
        }
    }

    #[test]
    fn car_number_order_when_no_results() {
        let session = SessionInfoMin::default();
        let drivers = vec![
            driver(2, "44", 1),
            driver(0, "7", 1),
            driver(1, "12", 1),
        ];
        let map = resolve_field_positions(&drivers, &session, Some(0));
        assert_eq!(map[&0].position, Some(1));
        assert_eq!(map[&1].position, Some(2));
        assert_eq!(map[&2].position, Some(3));
        assert!(map[&0].provisional);
        assert_complete_and_unique_overall(&map);
    }

    #[test]
    fn yaml_zero_position_falls_through_to_car_number() {
        let mut session = SessionInfoMin::default();
        // Simulate a stale map entry that somehow kept a zero overall.
        session.session_positions.insert((0, 5), (0, 0));
        let drivers = vec![driver(5, "92", 1), driver(6, "4", 1)];
        let map = resolve_field_positions(&drivers, &session, Some(0));
        assert_complete_and_unique_overall(&map);
        assert!(map[&5].provisional);
        assert!(map[&6].provisional);
        // Car #4 before #92 by number order when both need fallback.
        assert_eq!(map[&6].position, Some(1));
        assert_eq!(map[&5].position, Some(2));
    }

    #[test]
    fn live_telemetry_not_provisional() {
        let session = SessionInfoMin::default();
        let drivers = vec![DriverPosInput {
            car_idx: 0,
            car_number: Some("4".into()),
            car_class_id: Some(1),
            live_position: Some(3),
            live_class_position: Some(2),
        }];
        let map = resolve_field_positions(&drivers, &session, Some(0));
        assert_eq!(map[&0].position, Some(3));
        assert_eq!(map[&0].class_position, Some(2));
        assert!(!map[&0].provisional);
    }

    #[test]
    fn yaml_results_are_provisional() {
        let mut session = SessionInfoMin::default();
        session.session_positions.insert((0, 5), (1, 1));
        let drivers = vec![driver(5, "92", 1), driver(6, "4", 1)];
        let map = resolve_field_positions(&drivers, &session, Some(0));
        assert_eq!(map[&5].position, Some(1));
        assert!(map[&5].provisional);
        assert!(map[&6].provisional);
        assert_complete_and_unique_overall(&map);
    }

    #[test]
    fn live_class_only_fills_overall_without_colliding_fallback() {
        let session = SessionInfoMin::default();
        let drivers = vec![
            DriverPosInput {
                car_idx: 0,
                car_number: Some("1".into()),
                car_class_id: Some(1),
                live_position: None,
                live_class_position: Some(27),
            },
            DriverPosInput {
                car_idx: 1,
                car_number: Some("99".into()),
                car_class_id: Some(1),
                live_position: None,
                live_class_position: None,
            },
        ];
        let map = resolve_field_positions(&drivers, &session, Some(0));
        assert_eq!(map[&0].class_position, Some(27));
        assert!(map[&0].position.is_some());
        assert!(!map[&0].provisional);
        assert!(map[&1].provisional);
        // Relative prefers class: live shows 27, fallback shows its own class.
        assert_ne!(
            map[&0].class_position.or(map[&0].position),
            map[&1].class_position.or(map[&1].position)
        );
        // Standings overall prefers position: both set and unique.
        assert_ne!(map[&0].position, map[&1].position);
        assert_complete_and_unique_overall(&map);
    }

    #[test]
    fn live_plus_yaml_does_not_duplicate() {
        let mut session = SessionInfoMin::default();
        session.session_positions.insert((0, 1), (27, 5));
        let drivers = vec![
            DriverPosInput {
                car_idx: 0,
                car_number: Some("1".into()),
                car_class_id: Some(1),
                live_position: Some(27),
                live_class_position: Some(4),
            },
            DriverPosInput {
                car_idx: 1,
                car_number: Some("99".into()),
                car_class_id: Some(1),
                live_position: None,
                live_class_position: None,
            },
        ];
        let map = resolve_field_positions(&drivers, &session, Some(0));
        assert_eq!(map[&0].position, Some(27));
        assert!(!map[&0].provisional);
        assert!(map[&1].provisional);
        assert_complete_and_unique_overall(&map);
    }
}
