import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FileAudio,
  Mic,
  RefreshCw,
  Sparkles,
  Square,
  Upload,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import {
  commands,
  events,
  type MeetingMinutes,
  type MeetingProgressEvent,
  type MeetingSession,
  type MeetingTemplate,
  type TranscriptSegment,
} from "@/bindings";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import {
  defaultMeetingPreferences,
  loadMeetingPreferences,
  meetingProfile,
  saveMeetingPreferences,
  type MeetingLlmProfile,
} from "./meetingPreferences";
import { formatMeetingTime } from "./meetingTime";

/** Render the independent meeting workspace and offline import controls. */
export const MeetingSettings: React.FC = () => {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<MeetingSession[]>([]);
  const [templates, setTemplates] = useState<MeetingTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [progress, setProgress] = useState<MeetingProgressEvent | null>(null);
  const [preferences, setPreferences] = useState(defaultMeetingPreferences);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const { providerId, templateId } = preferences;
  const { apiKey, baseUrl, model } = meetingProfile(preferences, providerId);
  const [loading, setLoading] = useState(false);
  const [liveRecording, setLiveRecording] = useState(false);
  const [liveText, setLiveText] = useState("");

  const loadSessions = useCallback(async () => {
    const result = await commands.listMeetings(50);
    if (result.status === "ok") {
      setSessions(result.data);
      if (!selectedId && result.data[0]) {
        setSelectedId(result.data[0].id);
      }
    }
  }, [selectedId]);

  const loadTemplates = useCallback(async () => {
    const result = await commands.listMeetingTemplates();
    if (result.status === "ok") {
      setTemplates(result.data);
      if (result.data[0] && templateId === "standard") {
        setPreferences((current) => ({
          ...current,
          templateId: result.data[0].id,
        }));
      }
    }
  }, [templateId]);

  useEffect(() => {
    let active = true;
    void loadMeetingPreferences()
      .then((saved) => {
        if (active) setPreferences(saved);
      })
      .catch(() => {
        if (active) toast.error(t("settings.meeting.preferencesFailed"));
      })
      .finally(() => {
        if (active) setPreferencesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [t]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    const timer = window.setTimeout(() => {
      void saveMeetingPreferences(preferences).catch(() =>
        toast.error(t("settings.meeting.preferencesFailed")),
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [preferences, preferencesLoaded, t]);

  /** Update one provider profile while retaining other providers' credentials. */
  const updateProfile = (changes: Partial<MeetingLlmProfile>) => {
    setPreferences((current) => ({
      ...current,
      profiles: {
        ...current.profiles,
        [current.providerId]: {
          ...meetingProfile(current, current.providerId),
          ...changes,
        },
      },
    }));
  };

  useEffect(() => {
    void loadSessions();
    void loadTemplates();
  }, [loadSessions, loadTemplates]);

  useEffect(() => {
    let active = true;
    setSegments([]);
    setMinutes(null);
    if (!selectedId) {
      return;
    }
    void (async () => {
      const [segmentResult, minutesResult] = await Promise.all([
        commands.getMeetingSegments(selectedId),
        commands.getMeetingMinutes(selectedId),
      ]);
      if (!active) return;
      if (segmentResult.status === "ok") setSegments(segmentResult.data);
      if (minutesResult.status === "ok") setMinutes(minutesResult.data);
    })();
    return () => {
      active = false;
    };
  }, [selectedId]);

  useEffect(() => {
    const unlisten = events.meetingProgressEvent.listen((event) => {
      setProgress(event.payload);
      if (
        event.payload.phase === "failed" &&
        !(generatingRef.current && event.payload.meeting_id === selectedId)
      ) {
        toast.error(t("settings.meeting.importFailed"), {
          description: event.payload.message ?? undefined,
        });
      }
      if (
        event.payload.phase === "completed" ||
        event.payload.phase === "transcribed"
      ) {
        void loadSessions();
      }
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [loadSessions, selectedId, t]);

  useEffect(() => {
    const unlisten = events.streamTextEvent.listen((event) => {
      const { committed, tentative } = event.payload;
      setLiveText([committed, tentative].filter(Boolean).join(" "));
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  /** Open the native file picker and enqueue an offline transcription job. */
  const importAudio = async () => {
    const selection = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg"],
        },
      ],
    });
    const path = typeof selection === "string" ? selection : null;
    if (!path) return;

    setLoading(true);
    const result = await commands.importMeetingAudio(path, null, templateId);
    setLoading(false);
    if (result.status === "ok") {
      setSessions((current) => [result.data, ...current]);
      setSelectedId(result.data.id);
      toast.success(t("settings.meeting.importStarted"));
    } else {
      toast.error(t("settings.meeting.importFailed"), {
        description: result.error,
      });
    }
  };

  /** Start a microphone meeting backed by Handy's streaming ASR pipeline. */
  const startLiveMeeting = async () => {
    setLoading(true);
    const result = await commands.startLiveMeeting(null, templateId);
    setLoading(false);
    if (result.status === "ok") {
      setSessions((current) => [result.data, ...current]);
      setSelectedId(result.data.id);
      setLiveText("");
      setLiveRecording(true);
      toast.success(t("settings.meeting.liveStarted"));
    } else {
      toast.error(t("settings.meeting.liveFailed"), {
        description: result.error,
      });
    }
  };

  /** Stop the current microphone meeting and refresh its saved transcript. */
  const stopLiveMeeting = async () => {
    setLoading(true);
    const result = await commands.stopLiveMeeting();
    setLoading(false);
    setLiveRecording(false);
    if (result.status === "ok") {
      setSessions((current) =>
        current.map((session) =>
          session.id === result.data.id ? result.data : session,
        ),
      );
      const segmentResult = await commands.getMeetingSegments(result.data.id);
      if (segmentResult.status === "ok") setSegments(segmentResult.data);
      setLiveText("");
      toast.success(t("settings.meeting.liveStopped"));
    } else {
      toast.error(t("settings.meeting.liveFailed"), {
        description: result.error,
      });
    }
  };

  /** Ask the selected LLM provider to generate minutes from saved segments. */
  const generateMinutes = async () => {
    if (generatingRef.current || !selectedId) return;
    if (providerId !== "ollama" && !apiKey.trim()) {
      toast.error(t("settings.meeting.apiKeyRequired"));
      return;
    }
    generatingRef.current = true;
    setGenerating(true);
    try {
      try {
        await saveMeetingPreferences(preferences);
      } catch {
        toast.error(t("settings.meeting.preferencesFailed"));
      }
      const result = await commands.generateMeetingMinutes(
        selectedId,
        templateId,
        providerId,
        baseUrl,
        apiKey,
        model,
      );
      if (result.status === "ok") {
        setMinutes(result.data);
        toast.success(t("settings.meeting.minutesGenerated"));
        void loadSessions();
      } else {
        toast.error(t("settings.meeting.minutesFailed"), {
          description: result.error,
        });
      }
    } catch (error) {
      toast.error(t("settings.meeting.minutesFailed"), {
        description: String(error),
      });
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  };

  const selectedSession = sessions.find((session) => session.id === selectedId);

  return (
    <div className="max-w-4xl w-full mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xs font-medium text-mid-gray uppercase tracking-wide">
            {t("settings.meeting.title")}
          </h2>
          <p className="text-sm text-text/60 mt-1">
            {t("settings.meeting.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={liveRecording ? stopLiveMeeting : startLiveMeeting}
            disabled={loading}
            className="flex items-center gap-2"
          >
            {liveRecording ? (
              <Square className="w-4 h-4" />
            ) : (
              <Mic className="w-4 h-4" />
            )}
            {t(
              liveRecording
                ? "settings.meeting.stopLive"
                : "settings.meeting.startLive",
            )}
          </Button>
          <Button
            onClick={importAudio}
            disabled={loading || liveRecording}
            className="flex items-center gap-2"
          >
            <Upload className="w-4 h-4" />
            {t("settings.meeting.importAudio")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[14rem_1fr] gap-4">
        <div className="border border-mid-gray/20 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-mid-gray/20 flex items-center justify-between">
            <span className="text-sm font-medium">
              {t("settings.meeting.history")}
            </span>
            <button
              type="button"
              onClick={() => void loadSessions()}
              title={t("settings.meeting.refresh")}
            >
              <RefreshCw className="w-4 h-4 text-text/60" />
            </button>
          </div>
          {sessions.length === 0 ? (
            <p className="p-3 text-sm text-text/50">
              {t("settings.meeting.empty")}
            </p>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => setSelectedId(session.id)}
                disabled={generating}
                className={`block w-full text-start px-3 py-2 border-b border-mid-gray/10 hover:bg-background-ui/30 ${selectedId === session.id ? "bg-logo-primary/20" : ""}`}
              >
                <span className="block text-sm truncate">{session.title}</span>
                <span className="block text-xs text-text/50">
                  {session.status}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="space-y-4">
          <div className="border border-mid-gray/20 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <FileAudio className="w-5 h-5 text-logo-primary" />
              <span className="font-medium">
                {selectedSession?.title ?? t("settings.meeting.noSelection")}
              </span>
            </div>
            {progress &&
              progress.meeting_id === selectedId &&
              progress.phase !== "completed" && (
                <p className="text-sm text-text/60">
                  {t("settings.meeting.progress", {
                    phase: t(`settings.meeting.phases.${progress.phase}`, {
                      defaultValue: progress.phase,
                    }),
                    percent: Math.round(progress.progress * 100),
                  })}
                </p>
              )}
            {liveRecording && selectedSession?.source === "microphone" && (
              <p className="text-sm text-text/60 whitespace-pre-wrap">
                {liveText || t("settings.meeting.liveListening")}
              </p>
            )}
            <div className="max-h-72 overflow-auto space-y-2 text-sm whitespace-pre-wrap">
              {segments.length === 0 ? (
                <p className="text-text/50">
                  {t("settings.meeting.noTranscript")}
                </p>
              ) : (
                segments.map((segment) => (
                  <p
                    key={
                      segment.id || `${segment.sequence}-${segment.start_ms}`
                    }
                  >
                    <span className="text-text/40">
                      {t("settings.meeting.timestamp", {
                        time: formatMeetingTime(segment.start_ms),
                      })}
                    </span>{" "}
                    {segment.text}
                  </p>
                ))
              )}
            </div>
          </div>

          <div className="border border-mid-gray/20 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-logo-primary" />
              <span className="font-medium">
                {t("settings.meeting.minutes")}
              </span>
            </div>
            <Select
              value={providerId}
              options={[
                {
                  value: "deepseek",
                  label: t("settings.meeting.providers.deepseek"),
                },
                {
                  value: "openai",
                  label: t("settings.meeting.providers.openai"),
                },
                {
                  value: "openrouter",
                  label: t("settings.meeting.providers.openrouter"),
                },
                {
                  value: "ollama",
                  label: t("settings.meeting.providers.ollama"),
                },
                {
                  value: "custom",
                  label: t("settings.meeting.providers.custom"),
                },
              ]}
              isClearable={false}
              onChange={(value) => {
                const next = value ?? "deepseek";
                setPreferences((current) => ({ ...current, providerId: next }));
              }}
            />
            <Input
              value={baseUrl}
              onChange={(event) =>
                updateProfile({ baseUrl: event.target.value })
              }
              placeholder={t("settings.meeting.baseUrl")}
            />
            <Select
              value={templateId}
              options={templates.map((template) => ({
                value: template.id,
                label: t(`settings.meeting.templates.${template.id}`, {
                  defaultValue: template.name,
                }),
              }))}
              isClearable={false}
              onChange={(value) =>
                setPreferences((current) => ({
                  ...current,
                  templateId: value ?? "standard",
                }))
              }
            />
            <Input
              type="password"
              value={apiKey}
              onChange={(event) =>
                updateProfile({ apiKey: event.target.value })
              }
              placeholder={t("settings.meeting.apiKey")}
            />
            <Input
              value={model}
              onChange={(event) => updateProfile({ model: event.target.value })}
              placeholder={t("settings.meeting.model")}
            />
            <Button
              onClick={generateMinutes}
              disabled={
                !selectedId ||
                segments.length === 0 ||
                generating ||
                !preferencesLoaded
              }
            >
              {generating && (
                <RefreshCw className="w-4 h-4 animate-spin mr-2" />
              )}
              {t(
                generating
                  ? "settings.meeting.generatingMinutes"
                  : "settings.meeting.generateMinutes",
              )}
            </Button>
            {generating && (
              <p
                className="text-sm text-text/60"
                role="status"
                aria-live="polite"
              >
                {t("settings.meeting.generatingHint")}
              </p>
            )}
            {minutes && (
              <article className="prose prose-sm max-w-none text-text/90">
                <ReactMarkdown
                  skipHtml
                  components={{
                    h1: ({ children }) => (
                      <h1 className="text-lg font-semibold mb-3">{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="text-base font-semibold mt-4 mb-2">
                        {children}
                      </h2>
                    ),
                    p: ({ children }) => (
                      <p className="text-sm leading-6 mb-2">{children}</p>
                    ),
                    ul: ({ children }) => (
                      <ul className="list-disc pl-5 space-y-1 mb-3">
                        {children}
                      </ul>
                    ),
                    li: ({ children }) => (
                      <li className="text-sm leading-6">{children}</li>
                    ),
                  }}
                >
                  {minutes.content_markdown}
                </ReactMarkdown>
              </article>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
