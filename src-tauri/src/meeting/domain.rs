use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// Describes how a meeting transcript was created.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MeetingSource {
    Microphone,
    AudioFile,
}

/// Tracks the lifecycle of a meeting and its background jobs.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MeetingStatus {
    Draft,
    Recording,
    Processing,
    Transcribed,
    GeneratingMinutes,
    Completed,
    Failed,
    Cancelled,
}

/// A persisted meeting session shown in the meeting history UI.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingSession {
    pub id: String,
    pub title: String,
    pub source: MeetingSource,
    pub status: MeetingStatus,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub template_id: Option<String>,
}

/// A stable or provisional piece of a meeting transcript.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct TranscriptSegment {
    pub id: i64,
    pub meeting_id: String,
    pub sequence: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub is_final: bool,
    pub speaker_id: Option<String>,
}

/// A built-in or user-defined meeting minutes template.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub is_builtin: bool,
}

/// Stores the structured minutes returned by an LLM as JSON and Markdown.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingMinutes {
    pub id: i64,
    pub meeting_id: String,
    pub template_id: String,
    pub provider_id: String,
    pub model: String,
    pub content_json: String,
    pub content_markdown: String,
    pub created_at: i64,
}

/// Reports progress from offline transcription and minutes generation.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
pub struct MeetingProgressEvent {
    pub meeting_id: String,
    pub phase: String,
    pub progress: f32,
    pub message: Option<String>,
}
