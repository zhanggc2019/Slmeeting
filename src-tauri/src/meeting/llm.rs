use anyhow::{anyhow, Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Configuration for a meeting minutes LLM provider.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MeetingLlmConfig {
    pub provider_id: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl Default for MeetingLlmConfig {
    fn default() -> Self {
        Self {
            provider_id: "deepseek".to_string(),
            base_url: "https://api.deepseek.com".to_string(),
            api_key: String::new(),
            model: "deepseek-flash".to_string(),
        }
    }
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    stream: bool,
    response_format: ResponseFormat,
}

#[derive(Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    format_type: &'static str,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessageResponse,
}

#[derive(Deserialize)]
struct ChatMessageResponse {
    content: Option<String>,
}

/// Generate structured meeting minutes through an OpenAI-compatible endpoint.
pub async fn generate_minutes(
    config: &MeetingLlmConfig,
    system_prompt: &str,
    transcript: &str,
) -> Result<String> {
    if config.api_key.trim().is_empty() && config.provider_id != "ollama" {
        return Err(anyhow!("meeting LLM API key is empty"));
    }
    if config.model.trim().is_empty() {
        return Err(anyhow!("meeting LLM model is empty"));
    }

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if !config.api_key.trim().is_empty() {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", config.api_key))
                .context("invalid LLM API key")?,
        );
    }

    let system = format!("{system_prompt}\n\n只返回有效的 JSON，不要使用 Markdown 代码块。JSON 键名保持模板指定的英文，自然语言内容全部使用简体中文。");
    let request = ChatRequest {
        model: &config.model,
        messages: vec![
            ChatMessage {
                role: "system",
                content: &system,
            },
            ChatMessage {
                role: "user",
                content: transcript,
            },
        ],
        stream: false,
        response_format: ResponseFormat {
            format_type: "json_object",
        },
    };

    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let response = reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .context("failed to create LLM HTTP client")?
        .post(url)
        .json(&request)
        .send()
        .await
        .context("meeting LLM request failed")?;
    let status = response.status();
    let body = response
        .text()
        .await
        .context("failed to read meeting LLM response")?;
    if !status.is_success() {
        return Err(anyhow!("meeting LLM returned HTTP {}: {}", status, body));
    }

    let parsed: ChatResponse = serde_json::from_str(&body)
        .with_context(|| format!("failed to parse meeting LLM response: {body}"))?;
    let content = parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.clone())
        .ok_or_else(|| anyhow!("meeting LLM response contained no content"))?;
    let value: Value = serde_json::from_str(&content)
        .with_context(|| "meeting LLM returned invalid JSON".to_string())?;
    serde_json::to_string_pretty(&value).context("failed to normalize meeting minutes JSON")
}
