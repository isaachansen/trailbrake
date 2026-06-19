//! `overlay-core` — the sim-agnostic heart of the overlay.
//!
//! Nothing in this crate knows about iRacing (or any specific sim). It defines:
//!
//! - [`TelemetrySnapshot`] and friends: the normalized, SI-unit data model every
//!   connector populates and every widget reads from.
//! - [`SimConnector`]: the minimal trait a sim data source implements.
//! - [`MockConnector`]: a synthetic source so the UI/pipeline runs anywhere
//!   (including macOS) without a sim attached.
//! - [`spawn_reader`]: runs a connector on its own thread and fans snapshots out
//!   over a channel, decoupling *reading* from *rendering* (perf non-negotiable #1).
//!
//! Extensibility guardrail: no sim-specific types ever appear above this boundary.
//! Adding a sim = implement [`SimConnector`] + a normalization mapping.

pub mod connector;
pub mod mock;
pub mod reader;
pub mod record;
pub mod replay;
pub mod snapshot;

pub use connector::{Capabilities, ConnectError, SimConnector};
pub use mock::MockConnector;
pub use reader::{spawn_reader, ReaderHandle};
pub use record::RecordingConnector;
pub use replay::ReplayConnector;
pub use snapshot::{
    CarState, ChangeFlags, ChatMessage, Meta, PlayerState, RaceControlMessage, Sectors,
    SessionState, SimId, TelemetrySnapshot, TirePressures, TrackTurn,
};
