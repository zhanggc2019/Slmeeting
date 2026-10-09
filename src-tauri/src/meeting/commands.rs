use crate::audio_toolkit::VadPolicy;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::TranscriptionManager;
use crate::meeting::audio::{decode_audio_file, resample_to_16khz};
use crate::meeting::db::{builtin_templates, MeetingManager};
use crate::meeting::domain::{
    MeetingMinutes, MeetingProgressEvent, MeetingSession, MeetingSource, MeetingStatus,
    MeetingTemplate, TranscriptSegment,
};
use crate::meeting::llm::{generate_minutes, MeetingLlmConfig};
use chrono::Utc;
use log::{error, info};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_specta::Event;

static MEETING_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Create a monotonic, human-readable meeting identifier.
fn new_meeting_id() -> String {
    let sequence = MEETING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("meeting-{}-{}", Utc::now().timestamp_millis(), sequence)
}

/// Emit one background meeting progress update.
fn emit_progress(
    app: &AppHandle,
    meeting_id: &str,
    phase: &str,
    progress: f32,
    message: Option<String>,
) {
    let event = MeetingProgressEvent {
        meeting_id: meeting_id.to_string(),
        phase: phase.to_string(),
        progress: progress.clamp(0.0, 1.0),
        message,
    };
    if let Err(error) = event.emit(app) {
        error!("failed to emit meeting progress: {}", error);
    }
}

/// Create a new empty meeting session.
#[tauri::command]
#[specta::specta]
pub fn create_meeting(
    manager: State<'_, Arc<MeetingManager>>,
    title: Option<String>,
    source: MeetingSource,
    template_id: Option<String>,
) -> Result<MeetingSession, String> {
    manager
        .create_session(
            new_meeting_id(),
            title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Untitled meeting".to_string()),
            source,
            template_id,
        )
        .map_err(|error| error.to_string())
}

/// List recent meeting sessions for the meeting history page.
#[tauri::command]
#[specta::specta]
pub fn list_meetings(
    manager: State<'_, Arc<MeetingManager>>,
    limit: Option<usize>,
) -> Result<Vec<MeetingSession>, String> {
    manager
        .list_sessions(limit.unwrap_or(50).clamp(1, 500))
        .map_err(|error| error.to_string())
}

/// Delete a saved meeting and its generated content.
#[tauri::command]
#[specta::specta]
pub fn delete_meeting(
    manager: State<'_, Arc<MeetingManager>>,
    meeting_id: String,
) -> Result<(), String> {
    manager
        .delete_session(&meeting_id)
        .map_err(|error| error.to_string())
}

/// Load all transcript segments belonging to one meeting.
#[tauri::command]
#[specta::specta]
pub fn get_meeting_segments(
    manager: State<'_, Arc<MeetingManager>>,
    meeting_id: String,
) -> Result<Vec<TranscriptSegment>, String> {
    manager
        .list_segments(&meeting_id)
        .map_err(|error| error.to_string())
}

/// Load the latest generated minutes for one meeting.
#[tauri::command]
#[specta::specta]
pub fn get_meeting_minutes(
    manager: State<'_, Arc<MeetingManager>>,
    meeting_id: String,
) -> Result<Option<MeetingMinutes>, String> {
    let mut minutes = manager
        .get_minutes(&meeting_id)
        .map_err(|error| error.to_string())?;
    if let Some(saved) = minutes.as_mut() {
        saved.content_markdown = render_markdown(&saved.content_json).unwrap_or_else(|error| {
            error!("failed to render saved meeting minutes: {}", error);
            saved.content_markdown.clone()
        });
    }
    Ok(minutes)
}

/// Save a generated Word document at the path selected by the user.
#[tauri::command]
#[specta::specta]
pub fn save_meeting_word_document(path: String, contents: Vec<u8>) -> Result<(), String> {
    let destination = std::path::Path::new(&path);
    let is_docx = destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("docx"));
    if !is_docx || contents.is_empty() {
        return Err("A nonempty .docx document and destination are required".to_string());
    }
    std::fs::write(destination, contents).map_err(|error| error.to_string())
}

/// Return the built-in minutes templates.
#[tauri::command]
#[specta::specta]
pub fn list_meeting_templates() -> Vec<MeetingTemplate> {
    builtin_templates()
}

/// Start a microphone meeting and forward its audio to Handy's live ASR stream.
#[tauri::command]
#[specta::specta]
pub fn start_live_meeting(
    app: AppHandle,
    manager: State<'_, Arc<MeetingManager>>,
    recording_manager: State<'_, Arc<AudioRecordingManager>>,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    title: Option<String>,
    template_id: Option<String>,
) -> Result<MeetingSession, String> {
    if recording_manager.is_recording() {
        return Err("another microphone recording is already active".to_string());
    }
    let session = manager
        .create_session(
            new_meeting_id(),
            title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Live meeting".to_string()),
            MeetingSource::Microphone,
            template_id,
        )
        .map_err(|error| error.to_string())?;

    transcription_manager.initiate_model_load();
    transcription_manager.start_stream();
    let cancel_generation = recording_manager.cancel_generation();
    if let Err(error) = recording_manager.try_start_recording("meeting", VadPolicy::Streaming) {
        transcription_manager.cancel_stream();
        return Err(error);
    }
    if let Err(error) = manager.start_live_meeting(session.id.clone(), cancel_generation) {
        recording_manager.cancel_recording();
        transcription_manager.cancel_stream();
        return Err(error.to_string());
    }
    manager
        .update_status(
            &session.id,
            MeetingStatus::Recording,
            Some(Utc::now().timestamp_millis()),
            None,
            None,
        )
        .map_err(|error| error.to_string())?;
    emit_progress(&app, &session.id, "recording", 0.0, None);
    manager
        .get_session(&session.id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "started meeting session could not be loaded".to_string())
}

/// Stop the active live meeting and persist its finalized transcript.
#[tauri::command]
#[specta::specta]
pub async fn stop_live_meeting(
    app: AppHandle,
    manager: State<'_, Arc<MeetingManager>>,
    recording_manager: State<'_, Arc<AudioRecordingManager>>,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
) -> Result<MeetingSession, String> {
    let (meeting_id, cancel_generation) = manager
        .finish_live_meeting()
        .map_err(|error| error.to_string())?;
    let samples = recording_manager
        .stop_recording("meeting", cancel_generation)
        .unwrap_or_default();
    emit_progress(&app, &meeting_id, "finalizing", 0.95, None);

    let transcription_manager_for_job = Arc::clone(&transcription_manager);
    let fallback_samples = samples.clone();
    let text = tauri::async_runtime::spawn_blocking(move || {
        match transcription_manager_for_job.finalize_stream()? {
            Some(text) => Ok::<String, anyhow::Error>(text),
            None if fallback_samples.is_empty() => Ok(String::new()),
            None => transcription_manager_for_job.transcribe(fallback_samples),
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?
    .trim()
    .to_string();

    let duration_ms = (samples.len() as i64 * 1000) / 16_000;
    if !text.is_empty() {
        manager
            .insert_segment(&TranscriptSegment {
                id: 0,
                meeting_id: meeting_id.clone(),
                sequence: 0,
                start_ms: 0,
                end_ms: duration_ms,
                text,
                is_final: true,
                speaker_id: None,
            })
            .map_err(|error| error.to_string())?;
    }
    manager
        .update_status(
            &meeting_id,
            MeetingStatus::Processing,
            None,
            Some(Utc::now().timestamp_millis()),
            Some(duration_ms),
        )
        .map_err(|error| error.to_string())?;
    emit_progress(&app, &meeting_id, "transcribed", 1.0, None);
    manager
        .get_session(&meeting_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "stopped meeting session could not be loaded".to_string())
}

/// Start an asynchronous offline transcription job for an audio file.
#[tauri::command]
#[specta::specta]
pub fn import_meeting_audio(
    app: AppHandle,
    manager: State<'_, Arc<MeetingManager>>,
    path: String,
    title: Option<String>,
    template_id: Option<String>,
) -> Result<MeetingSession, String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_file() {
        return Err(format!("audio file does not exist: {}", path.display()));
    }

    let session = manager
        .create_session(
            new_meeting_id(),
            title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Imported meeting")
                        .to_string()
                }),
            MeetingSource::AudioFile,
            template_id,
        )
        .map_err(|error| error.to_string())?;

    let meeting_id = session.id.clone();
    let manager = Arc::clone(&manager);
    let manager_for_error = Arc::clone(&manager);
    let transcription_manager = Arc::clone(&*app.state::<Arc<TranscriptionManager>>());
    let app_for_job = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_offline_job(
            app_for_job.clone(),
            manager,
            transcription_manager,
            meeting_id.clone(),
            path,
        )
        .await
        {
            error!("meeting '{}' offline job failed: {}", meeting_id, error);
            let _ = manager_for_error.update_status(
                &meeting_id,
                MeetingStatus::Failed,
                None,
                Some(Utc::now().timestamp_millis()),
                None,
            );
            emit_progress(
                &app_for_job,
                &meeting_id,
                "failed",
                1.0,
                Some(error.to_string()),
            );
        }
    });

    Ok(session)
}

/// Decode and transcribe an imported audio file in bounded ASR chunks.
async fn run_offline_job(
    app: AppHandle,
    manager: Arc<MeetingManager>,
    transcription_manager: Arc<TranscriptionManager>,
    meeting_id: String,
    path: std::path::PathBuf,
) -> anyhow::Result<()> {
    manager.update_status(
        &meeting_id,
        MeetingStatus::Processing,
        Some(Utc::now().timestamp_millis()),
        None,
        None,
    )?;
    emit_progress(&app, &meeting_id, "decoding", 0.02, None);

    transcription_manager.initiate_model_load();
    let app_for_worker = app.clone();
    let manager_for_worker = Arc::clone(&manager);
    let meeting_id_for_worker = meeting_id.clone();
    let transcription_manager_for_worker = Arc::clone(&transcription_manager);
    let decoded = tauri::async_runtime::spawn_blocking(move || {
        let decoded = decode_audio_file(&path)?;
        let samples = resample_to_16khz(&decoded.samples, decoded.sample_rate)?;
        Ok::<Vec<f32>, anyhow::Error>(samples)
    })
    .await??;

    let total_samples = decoded.len().max(1);
    let chunk_samples = 30 * 16_000;
    let mut sequence = 0_i64;
    let mut offset = 0_usize;

    while offset < decoded.len() {
        let end = (offset + chunk_samples).min(decoded.len());
        let chunk = decoded[offset..end].to_vec();
        let tm = Arc::clone(&transcription_manager_for_worker);
        let text = tauri::async_runtime::spawn_blocking(move || tm.transcribe(chunk)).await??;
        let text = text.trim().to_string();
        if !text.is_empty() {
            manager_for_worker.insert_segment(&TranscriptSegment {
                id: 0,
                meeting_id: meeting_id_for_worker.clone(),
                sequence,
                start_ms: (offset as i64 * 1000) / 16_000,
                end_ms: (end as i64 * 1000) / 16_000,
                text,
                is_final: true,
                speaker_id: None,
            })?;
            sequence += 1;
        }
        offset = end;
        emit_progress(
            &app_for_worker,
            &meeting_id_for_worker,
            "transcribing",
            0.05 + 0.9 * (offset as f32 / total_samples as f32),
            None,
        );
    }

    let ended_at = Utc::now().timestamp_millis();
    manager_for_worker.update_status(
        &meeting_id_for_worker,
        MeetingStatus::Processing,
        None,
        Some(ended_at),
        Some((decoded.len() as i64 * 1000) / 16_000),
    )?;
    emit_progress(
        &app_for_worker,
        &meeting_id_for_worker,
        "transcribed",
        1.0,
        None,
    );
    info!(
        "offline meeting '{}' transcription completed",
        meeting_id_for_worker
    );
    Ok(())
}

/// Generate minutes for a completed transcript with an OpenAI-compatible LLM.
#[tauri::command]
#[specta::specta]
pub async fn generate_meeting_minutes(
    app: AppHandle,
    manager: State<'_, Arc<MeetingManager>>,
    meeting_id: String,
    template_id: String,
    provider_id: Option<String>,
    base_url: Option<String>,
    api_key: String,
    model: Option<String>,
) -> Result<MeetingMinutes, String> {
    let template = builtin_templates()
        .into_iter()
        .find(|template| template.id == template_id)
        .ok_or_else(|| format!("unknown meeting template: {}", template_id))?;
    let transcript = manager
        .transcript_text(&meeting_id)
        .map_err(|error| error.to_string())?;

    manager
        .update_status(
            &meeting_id,
            MeetingStatus::GeneratingMinutes,
            None,
            None,
            None,
        )
        .map_err(|error| error.to_string())?;
    emit_progress(&app, &meeting_id, "generating_minutes", 0.0, None);

    let config = MeetingLlmConfig {
        provider_id: provider_id.unwrap_or_else(|| "deepseek".to_string()),
        base_url: base_url.unwrap_or_else(|| "https://api.deepseek.com".to_string()),
        api_key,
        model: model.unwrap_or_else(|| "deepseek-flash".to_string()),
    };
    let content_json = match generate_minutes(&config, &template.system_prompt, &transcript).await {
        Ok(content) => content,
        Err(error) => {
            let _ = manager.update_status(
                &meeting_id,
                MeetingStatus::Failed,
                None,
                Some(Utc::now().timestamp_millis()),
                None,
            );
            emit_progress(&app, &meeting_id, "failed", 1.0, Some(error.to_string()));
            return Err(error.to_string());
        }
    };
    let content_markdown = render_markdown(&content_json).map_err(|error| error.to_string())?;
    let minutes = manager
        .save_minutes(
            &meeting_id,
            &template.id,
            &config.provider_id,
            &config.model,
            &content_json,
            &content_markdown,
        )
        .map_err(|error| error.to_string())?;
    manager
        .update_status(&meeting_id, MeetingStatus::Completed, None, None, None)
        .map_err(|error| error.to_string())?;
    emit_progress(&app, &meeting_id, "completed", 1.0, None);
    Ok(minutes)
}

/// Translate the known schema keys into readable Chinese section labels.
fn minutes_label(key: &str) -> &str {
    match key {
        "executive_summary" | "summary" => "会议摘要",
        "key_topics" => "讨论要点",
        "decisions" => "会议决定",
        "action_items" => "待办事项",
        "risks" => "风险",
        "open_questions" => "待确认事项",
        "attendees" => "参会人员",
        "business_impact" => "业务影响",
        "requests_for_decision" => "待决策事项",
        "next_steps" | "follow_up" => "后续安排",
        "blockers" => "阻碍事项",
        "task" => "任务",
        "owner" => "负责人",
        "due_date" => "截止时间",
        "priority" => "优先级",
        "status" => "状态",
        "evidence" => "依据",
        "title" => "标题",
        _ => key,
    }
}

/// Turn nested JSON values into readable text without exposing serialized objects.
fn minutes_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) if text.trim().is_empty() => None,
        Value::String(text) => Some(text.to_string()),
        Value::Bool(value) => Some(if *value { "是" } else { "否" }.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::Array(items) => {
            let values: Vec<_> = items.iter().filter_map(minutes_value).collect();
            (!values.is_empty()).then(|| values.join("；"))
        }
        Value::Object(fields) => {
            let values: Vec<_> = fields
                .iter()
                .filter_map(|(key, value)| {
                    minutes_value(value).map(|text| format!("{}：{}", minutes_label(key), text))
                })
                .collect();
            (!values.is_empty()).then(|| values.join("；"))
        }
    }
}

/// Render the normalized minutes JSON as readable Chinese Markdown.
fn render_markdown(content_json: &str) -> anyhow::Result<String> {
    let value: Value = serde_json::from_str(content_json)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("meeting minutes JSON must be an object"))?;
    let mut markdown = String::new();
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("会议纪要");
    markdown.push_str(&format!("# {title}\n\n"));
    let order = [
        "executive_summary",
        "summary",
        "key_topics",
        "decisions",
        "action_items",
        "business_impact",
        "risks",
        "blockers",
        "open_questions",
        "requests_for_decision",
        "next_steps",
        "follow_up",
        "attendees",
    ];
    let keys = order
        .iter()
        .filter_map(|key| object.get_key_value(*key))
        .chain(
            object
                .iter()
                .filter(|(key, _)| key != &"title" && !order.contains(&key.as_str())),
        );
    for (key, value) in keys {
        if value.is_null() || value.as_array().is_some_and(Vec::is_empty) {
            continue;
        }
        markdown.push_str(&format!("## {}\n\n", minutes_label(key)));
        match value {
            Value::String(text) => markdown.push_str(&format!("{text}\n\n")),
            Value::Array(items) => {
                for item in items {
                    if let Some(text) = minutes_value(item) {
                        markdown.push_str(&format!("- {text}\n"));
                    }
                }
                markdown.push('\n');
            }
            other => {
                if let Some(text) = minutes_value(other) {
                    markdown.push_str(&format!("{text}\n\n"));
                }
            }
        }
    }
    Ok(markdown)
}

#[cfg(test)]
mod minutes_render_tests {
    use super::render_markdown;

    /// Verify saved structured minutes are readable in Chinese without raw JSON.
    #[test]
    fn renders_chinese_sections_and_action_items() {
        let json = r#"{"title":"项目例会","executive_summary":"确认发布计划","action_items":[{"task":"完成测试","owner":"张三","due_date":"周五","priority":null}],"risks":[]}"#;
        let markdown = render_markdown(json).expect("valid minutes JSON");
        assert!(markdown.contains("# 项目例会"));
        assert!(markdown.contains("## 会议摘要"));
        assert!(markdown.contains("## 待办事项"));
        assert!(markdown.contains("完成测试"));
        assert!(markdown.contains("张三"));
        assert!(!markdown.contains("{\""));
        assert!(!markdown.contains("null"));
    }
}
