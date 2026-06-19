# Adding a sim

A sim is a swappable data source behind one trait. Adding one = implement
`SimConnector` + a normalization mapping. Nothing above the connector boundary
changes — widgets only ever see the normalized `TelemetrySnapshot` (§10).

See `crates/lmu-connector` for a stubbed example with implementation notes, and
`crates/iracing-connector` for a complete, real one.

## 1. Create the crate

`crates/<sim>-connector` depending on `overlay-core`. Gate OS-specific code:
most sims expose shared memory on Windows, so put the reader behind
`#![cfg(windows)]` and a target-gated dependency (see iRacing's `Cargo.toml`),
leaving the crate empty elsewhere so the workspace still builds on macOS.

Add the crate to the workspace `members` in the root `Cargo.toml`.

## 2. Implement `SimConnector` (`overlay-core::connector`)

```rust
fn sim_id(&self) -> SimId;
fn connect(&mut self) -> Result<(), ConnectError>;   // open shared memory/event
fn is_connected(&self) -> bool;
fn capabilities(&self) -> Capabilities;              // what this sim can provide
fn poll(&mut self) -> Option<TelemetrySnapshot>;     // block briefly, return a frame
```

Follow the iRacing connector's hot-path discipline (§3):

- Open the memory map **once** and keep the handle.
- Wait on the sim's "data ready" event instead of busy-polling.
- Build the variable/offset map and parse session metadata **only when the
  session changes**, never per frame.
- Per frame: pick the freshest buffer, do a **single copy**, guard against torn
  frames (re-check the version/tick across the copy), index by precomputed
  offsets.
- Add a `SimId` variant in `overlay-core::snapshot` for the new sim.

## 3. Normalize into `TelemetrySnapshot`

Convert to the documented SI units (speed m/s, angles rad, pedals 0..1, times s,
temps °C). Mark anything the sim doesn't provide as `None` — never fake it; set
`Capabilities` honestly so widgets hide unsupported fields. Populate `cars[]`
(from the per-car arrays) and `player.car_idx` for the Relative/Standings
widgets.

## 4. Wire it into source selection

Add the connector to `build_connector` in `src-tauri/src/main.rs` (and
`crates/overlay-cli/src/main.rs`) behind a `OVERLAY_SOURCE` value, and add it to
auto-detection (presence of its shared memory / process).

## Testing without the sim

You usually can't run the sim in CI / on macOS. Two tactics, both used by the
iRacing connector:

- **Unit-test the fiddly parsing** (e.g. the tolerant session-YAML parser in
  `session.rs`) against sample fixtures.
- **Record & replay**: capture a real session with
  `overlay-cli --source <sim> --record fixtures/<name>.jsonl`, then develop
  against it anywhere with `--source replay --replay fixtures/<name>.jsonl`.
