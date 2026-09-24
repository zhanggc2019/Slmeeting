//! Meeting transcription and minutes generation.
//!
//! This module owns meeting-specific state and persistence. The existing
//! dictation history and shortcut pipeline remain independent so this feature
//! can be merged upstream with a small integration surface.

mod audio;
mod commands;
mod db;
mod domain;
mod llm;

pub use commands::*;
pub use db::MeetingManager;
pub use domain::{
    MeetingMinutes, MeetingProgressEvent, MeetingSession, MeetingSource, MeetingStatus,
    MeetingTemplate, TranscriptSegment,
};
