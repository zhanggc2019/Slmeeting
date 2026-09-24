use crate::meeting::domain::{
    MeetingMinutes, MeetingSession, MeetingSource, MeetingStatus, MeetingTemplate,
    TranscriptSegment,
};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

/// Tracks the microphone recorder generation for the active live meeting.
struct LiveMeetingState {
    meeting_id: String,
    cancel_generation: u64,
}

/// Database schema owned by the meeting feature.
static MIGRATIONS: &[M] = &[
    M::up(
        "CREATE TABLE IF NOT EXISTS meeting_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            ended_at INTEGER,
            duration_ms INTEGER,
            template_id TEXT
        );",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS meeting_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            text TEXT NOT NULL,
            is_final INTEGER NOT NULL DEFAULT 1,
            speaker_id TEXT,
            UNIQUE(meeting_id, sequence),
            FOREIGN KEY(meeting_id) REFERENCES meeting_sessions(id) ON DELETE CASCADE
        );",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS meeting_minutes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL,
            template_id TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            model TEXT NOT NULL,
            content_json TEXT NOT NULL,
            content_markdown TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(meeting_id) REFERENCES meeting_sessions(id) ON DELETE CASCADE
        );",
    ),
];

/// Owns meeting persistence and the meeting audio directory.
pub struct MeetingManager {
    app_handle: AppHandle,
    db_path: PathBuf,
    meetings_dir: PathBuf,
    live_meeting: Mutex<Option<LiveMeetingState>>,
}

impl MeetingManager {
    /// Create the meeting store and apply all meeting-specific migrations.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let app_data_dir = crate::portable::app_data_dir(app_handle)?;
        let meetings_dir = app_data_dir.join("meetings");
        let db_path = app_data_dir.join("meetings.db");
        fs::create_dir_all(&meetings_dir)
            .with_context(|| format!("failed to create {}", meetings_dir.display()))?;

        let manager = Self {
            app_handle: app_handle.clone(),
            db_path,
            meetings_dir,
            live_meeting: Mutex::new(None),
        };
        manager.initialize_database()?;
        Ok(manager)
    }

    /// Return the application handle used for background task events.
    pub fn app_handle(&self) -> &AppHandle {
        &self.app_handle
    }

    /// Return the root directory reserved for meeting audio and exports.
    pub fn meetings_dir(&self) -> &Path {
        &self.meetings_dir
    }

    /// Mark a meeting as the only active microphone recording session.
    pub fn start_live_meeting(&self, meeting_id: String, cancel_generation: u64) -> Result<()> {
        let mut state = self
            .live_meeting
            .lock()
            .map_err(|_| anyhow!("live meeting state lock was poisoned"))?;
        if state.is_some() {
            return Err(anyhow!("a live meeting is already recording"));
        }
        *state = Some(LiveMeetingState {
            meeting_id,
            cancel_generation,
        });
        Ok(())
    }

    /// Take ownership of the current live meeting while it is being finalized.
    pub fn finish_live_meeting(&self) -> Result<(String, u64)> {
        let mut state = self
            .live_meeting
            .lock()
            .map_err(|_| anyhow!("live meeting state lock was poisoned"))?;
        let active = state
            .take()
            .ok_or_else(|| anyhow!("no live meeting is currently recording"))?;
        Ok((active.meeting_id, active.cancel_generation))
    }

    /// Initialize the independent meetings database.
    fn initialize_database(&self) -> Result<()> {
        let mut connection = Connection::open(&self.db_path)
            .with_context(|| format!("failed to open {}", self.db_path.display()))?;
        let migrations = Migrations::new(MIGRATIONS.to_vec());
        #[cfg(debug_assertions)]
        migrations.validate().expect("invalid meeting migrations");
        migrations.to_latest(&mut connection)?;
        Ok(())
    }

    /// Open a short-lived SQLite connection for one operation.
    fn connection(&self) -> Result<Connection> {
        Connection::open(&self.db_path).context("failed to open meeting database")
    }

    /// Create a meeting session before recording or importing audio.
    pub fn create_session(
        &self,
        id: String,
        title: String,
        source: MeetingSource,
        template_id: Option<String>,
    ) -> Result<MeetingSession> {
        let created_at = Utc::now().timestamp_millis();
        let source_value = source_to_string(&source);
        let status = MeetingStatus::Draft;
        let status_value = status_to_string(&status);
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO meeting_sessions (id, title, source, status, created_at, template_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                title,
                source_value,
                status_value,
                created_at,
                template_id
            ],
        )?;
        self.get_session(&id)?
            .ok_or_else(|| anyhow!("created meeting session could not be loaded"))
    }

    /// Update the lifecycle state of one meeting session.
    pub fn update_status(
        &self,
        meeting_id: &str,
        status: MeetingStatus,
        started_at: Option<i64>,
        ended_at: Option<i64>,
        duration_ms: Option<i64>,
    ) -> Result<()> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE meeting_sessions
             SET status = ?1,
                 started_at = COALESCE(?2, started_at),
                 ended_at = COALESCE(?3, ended_at),
                 duration_ms = COALESCE(?4, duration_ms)
             WHERE id = ?5",
            params![
                status_to_string(&status),
                started_at,
                ended_at,
                duration_ms,
                meeting_id
            ],
        )?;
        if changed == 0 {
            return Err(anyhow!("meeting session '{}' was not found", meeting_id));
        }
        Ok(())
    }

    /// Insert one final transcript segment.
    pub fn insert_segment(&self, segment: &TranscriptSegment) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO meeting_segments
             (meeting_id, sequence, start_ms, end_ms, text, is_final, speaker_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                segment.meeting_id,
                segment.sequence,
                segment.start_ms,
                segment.end_ms,
                segment.text,
                segment.is_final,
                segment.speaker_id
            ],
        )?;
        Ok(())
    }

    /// Load a meeting session by its stable identifier.
    pub fn get_session(&self, meeting_id: &str) -> Result<Option<MeetingSession>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, title, source, status, created_at, started_at, ended_at,
                        duration_ms, template_id
                 FROM meeting_sessions WHERE id = ?1",
                params![meeting_id],
                map_session,
            )
            .optional()
            .context("failed to load meeting session")
    }

    /// Load recent meeting sessions for the meeting history page.
    pub fn list_sessions(&self, limit: usize) -> Result<Vec<MeetingSession>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, title, source, status, created_at, started_at, ended_at,
                    duration_ms, template_id
             FROM meeting_sessions ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], map_session)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to list meeting sessions")
    }

    /// Load all final transcript segments in playback order.
    pub fn list_segments(&self, meeting_id: &str) -> Result<Vec<TranscriptSegment>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, meeting_id, sequence, start_ms, end_ms, text, is_final, speaker_id
             FROM meeting_segments WHERE meeting_id = ?1 ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map(params![meeting_id], map_segment)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to list meeting transcript segments")
    }

    /// Assemble the transcript into a prompt-friendly text representation.
    pub fn transcript_text(&self, meeting_id: &str) -> Result<String> {
        let segments = self.list_segments(meeting_id)?;
        if segments.is_empty() {
            return Err(anyhow!("meeting has no transcript segments"));
        }
        Ok(segments
            .iter()
            .map(|segment| {
                let speaker = segment
                    .speaker_id
                    .as_deref()
                    .map(|value| format!("[{value}] "))
                    .unwrap_or_default();
                format!(
                    "[{}-{} ms] {}{}",
                    segment.start_ms, segment.end_ms, speaker, segment.text
                )
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }

    /// Persist the latest generated meeting minutes.
    pub fn save_minutes(
        &self,
        meeting_id: &str,
        template_id: &str,
        provider_id: &str,
        model: &str,
        content_json: &str,
        content_markdown: &str,
    ) -> Result<MeetingMinutes> {
        let created_at = Utc::now().timestamp_millis();
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO meeting_minutes
             (meeting_id, template_id, provider_id, model, content_json, content_markdown, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                meeting_id,
                template_id,
                provider_id,
                model,
                content_json,
                content_markdown,
                created_at
            ],
        )?;
        let id = connection.last_insert_rowid();
        Ok(MeetingMinutes {
            id,
            meeting_id: meeting_id.to_string(),
            template_id: template_id.to_string(),
            provider_id: provider_id.to_string(),
            model: model.to_string(),
            content_json: content_json.to_string(),
            content_markdown: content_markdown.to_string(),
            created_at,
        })
    }

    /// Load the most recent generated minutes for a meeting.
    pub fn get_minutes(&self, meeting_id: &str) -> Result<Option<MeetingMinutes>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, meeting_id, template_id, provider_id, model, content_json,
                        content_markdown, created_at
                 FROM meeting_minutes WHERE meeting_id = ?1
                 ORDER BY created_at DESC LIMIT 1",
                params![meeting_id],
                map_minutes,
            )
            .optional()
            .context("failed to load meeting minutes")
    }
}

/// Return the built-in templates shipped with the first meeting release.
pub fn builtin_templates() -> Vec<MeetingTemplate> {
    vec![
        MeetingTemplate {
            id: "standard".to_string(),
            name: "Standard meeting minutes".to_string(),
            description: "Summary, topics, decisions, action items, risks, and open questions."
                .to_string(),
            system_prompt: "Create structured meeting minutes from the transcript. Return a JSON object with these keys: title, executive_summary, key_topics, decisions, action_items, risks, open_questions, attendees. Each action item should include task, owner, due_date, and priority when present. Do not invent facts that are absent from the transcript.".to_string(),
            is_builtin: true,
        },
        MeetingTemplate {
            id: "action_items".to_string(),
            name: "Action-focused minutes".to_string(),
            description: "Ownership, deadlines, blockers, and follow-up actions.".to_string(),
            system_prompt: "Create action-focused meeting minutes from the transcript. Return a JSON object with these keys: title, summary, action_items, decisions, blockers, follow_up, attendees. Every action item must include task, owner, due_date, status, and evidence when those details appear in the transcript. Keep unknown fields as null and never invent facts.".to_string(),
            is_builtin: true,
        },
        MeetingTemplate {
            id: "executive_brief".to_string(),
            name: "Executive brief".to_string(),
            description: "Short outcome and risk briefing for leadership.".to_string(),
            system_prompt: "Create a concise executive meeting brief from the transcript. Return a JSON object with these keys: title, executive_summary, business_impact, decisions, risks, requests_for_decision, next_steps. Focus on outcomes, trade-offs, owners, and deadlines. Do not infer or invent facts missing from the transcript.".to_string(),
            is_builtin: true,
        },
    ]
}

/// Map a SQLite row into a meeting session.
fn map_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingSession> {
    Ok(MeetingSession {
        id: row.get("id")?,
        title: row.get("title")?,
        source: source_from_string(&row.get::<_, String>("source")?),
        status: status_from_string(&row.get::<_, String>("status")?),
        created_at: row.get("created_at")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        duration_ms: row.get("duration_ms")?,
        template_id: row.get("template_id")?,
    })
}

/// Map a SQLite row into a transcript segment.
fn map_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptSegment> {
    Ok(TranscriptSegment {
        id: row.get("id")?,
        meeting_id: row.get("meeting_id")?,
        sequence: row.get("sequence")?,
        start_ms: row.get("start_ms")?,
        end_ms: row.get("end_ms")?,
        text: row.get("text")?,
        is_final: row.get("is_final")?,
        speaker_id: row.get("speaker_id")?,
    })
}

/// Map a SQLite row into generated meeting minutes.
fn map_minutes(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingMinutes> {
    Ok(MeetingMinutes {
        id: row.get("id")?,
        meeting_id: row.get("meeting_id")?,
        template_id: row.get("template_id")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        content_json: row.get("content_json")?,
        content_markdown: row.get("content_markdown")?,
        created_at: row.get("created_at")?,
    })
}

/// Convert a public source enum to its stable database representation.
fn source_to_string(source: &MeetingSource) -> &'static str {
    match source {
        MeetingSource::Microphone => "microphone",
        MeetingSource::AudioFile => "audio_file",
    }
}

/// Convert a database source value back to the public enum.
fn source_from_string(source: &str) -> MeetingSource {
    match source {
        "audio_file" => MeetingSource::AudioFile,
        _ => MeetingSource::Microphone,
    }
}

/// Convert a public status enum to its stable database representation.
fn status_to_string(status: &MeetingStatus) -> &'static str {
    match status {
        MeetingStatus::Draft => "draft",
        MeetingStatus::Recording => "recording",
        MeetingStatus::Processing => "processing",
        MeetingStatus::GeneratingMinutes => "generating_minutes",
        MeetingStatus::Completed => "completed",
        MeetingStatus::Failed => "failed",
        MeetingStatus::Cancelled => "cancelled",
    }
}

/// Convert a database status value back to the public enum.
fn status_from_string(status: &str) -> MeetingStatus {
    match status {
        "recording" => MeetingStatus::Recording,
        "processing" => MeetingStatus::Processing,
        "generating_minutes" => MeetingStatus::GeneratingMinutes,
        "completed" => MeetingStatus::Completed,
        "failed" => MeetingStatus::Failed,
        "cancelled" => MeetingStatus::Cancelled,
        _ => MeetingStatus::Draft,
    }
}
