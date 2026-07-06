//! Le Mans Ultimate connector — reads the rF2 shared-memory mappings LMU
//! publishes (via the community rF2 Shared Memory Map Plugin) and normalizes
//! them into [`overlay_core::TelemetrySnapshot`].
//!
//! This is the **first listener**: it proves the pipe and surfaces the player's
//! fast-path physics + basic session state. See `crate::rf2` for the layout
//! reference and calibration notes, and `connector.rs` for what's decoded vs.
//! deferred. LMU is Windows-only; off-Windows this crate is an always-
//! `NotRunning` stub so the workspace still builds (see `docs/ADDING_A_SIM.md`).
//!
//! Reference used for *structure and layout only* (no code copied): TheIronWolf's
//! `rF2SharedMemoryMapPlugin` (`rF2State.h`).

pub mod rf2;

#[cfg(windows)]
mod connector;
#[cfg(windows)]
pub use connector::LmuConnector;

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use stub::LmuConnector;
