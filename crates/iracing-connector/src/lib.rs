//! iRacing connector: reads the iRacing SDK shared-memory region and normalizes
//! it into [`overlay_core::TelemetrySnapshot`].
//!
//! The entire implementation is Windows-only (iRacing is Windows-only). On other
//! platforms this crate is intentionally empty so the workspace still builds and
//! developers can iterate on the UI against the mock/replay sources.
//!
//! Reference implementations cribbed for *structure and quirk-handling only*
//! (no code copied): IRSDKSharper (C#), pyirsdk (Python), node-irsdk (Node).

#![cfg(windows)]

mod connector;
mod irsdk;
mod session;
mod track_map;

pub use connector::IRacingConnector;
pub use track_map::merge_external;
