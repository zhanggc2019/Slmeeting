import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FileAudio,
  FileDown,
  FileCode2,
  Mic,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
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
import { Select } from "../../ui/Select";
import {
  defaultMeetingPreferences,
  loadMeetingPreferences,
  meetingProfile,
  saveMeetingPreferences,
} from "./meetingPreferences";
import { formatMeetingTime } from "./meetingTime";
import { MeetingMinutesView } from "./MeetingMinutesView";

/** Render the independent meeting workspace and offline import controls. */
export const MeetingSettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [sessions, setSessions] = useState<MeetingSession[]>([]);
  const [templates, setTemplates] = useState<MeetingTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [progress, setProgress] = useState<MeetingProgressEvent | null>(null);
  const [preferences, setPreferences] = useState(defaultMeetingPreferences);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const preferencesRef = useRef(preferences);
  const preferencesLoadedRef = useRef(false);
  preferencesRef.current = preferences;
  const [generating, setGenerating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [exportingWord, setExportingWord] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const generatingRef = useRef(false);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const minutesRef = useRef<HTMLDivElement>(null);
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

  /** Reload the selected meeting's transcript and latest minutes from storage. */
  const loadMeetingDetails = useCallback(async (meetingId: string) => {
    const [segmentResult, minutesResult] = await Promise.all([
      commands.getMeetingSegments(meetingId),
      commands.getMeetingMinutes(meetingId),
    ]);
    if (selectedIdRef.current !== meetingId) return;
    if (segmentResult.status === "ok") setSegments(segmentResult.data);
    if (minutesResult.status === "ok") setMinutes(minutesResult.data);
  }, []);

  /** Refresh both the meeting list and the selected transcript. */
  const refreshMeetings = useCallback(async () => {
    await loadSessions();
    if (selectedIdRef.current) {
      await loadMeetingDetails(selectedIdRef.current);
    }
  }, [loadMeetingDetails, loadSessions]);

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
        if (active) {
          setPreferencesLoaded(true);
          preferencesLoadedRef.current = true;
        }
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

  useEffect(
    () => () => {
      if (preferencesLoadedRef.current) {
        void saveMeetingPreferences(preferencesRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    void loadSessions();
    void loadTemplates();
  }, [loadSessions, loadTemplates]);

  useEffect(() => {
    setSegments([]);
    setMinutes(null);
    if (selectedId) void loadMeetingDetails(selectedId);
  }, [selectedId, loadMeetingDetails]);

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
        event.payload.phase === "transcribed" ||
        event.payload.phase === "failed"
      ) {
        void loadSessions();
      }
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [loadSessions, selectedId, t]);

  useEffect(() => {
    if (
      selectedId &&
      progress?.meeting_id === selectedId &&
      ["transcribed", "completed", "failed"].includes(progress.phase)
    ) {
      void loadMeetingDetails(selectedId);
    }
  }, [loadMeetingDetails, progress, selectedId]);

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
    const meetingId = selectedId;
    generatingRef.current = true;
    setGenerating(true);
    try {
      const segmentResult = await commands.getMeetingSegments(meetingId);
      if (segmentResult.status === "error")
        throw new Error(segmentResult.error);
      setSegments(segmentResult.data);
      if (segmentResult.data.length === 0) {
        toast.error(t("settings.meeting.noTranscript"), {
          description: t("settings.meeting.noTranscriptHint"),
        });
        return;
      }
      if (providerId !== "ollama" && !apiKey.trim()) {
        toast.error(t("settings.meeting.apiKeyRequired"));
        return;
      }
      try {
        await saveMeetingPreferences(preferences);
      } catch {
        toast.error(t("settings.meeting.preferencesFailed"));
      }
      const result = await commands.generateMeetingMinutes(
        meetingId,
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
        window.setTimeout(
          () => minutesRef.current?.scrollIntoView({ behavior: "smooth" }),
          0,
        );
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

  /** Export the selected structured minutes to an editable Word document. */
  const exportWord = async () => {
    if (!minutes || exportingWord) return;
    const suggestedName = `${(selectedSession?.title || t("settings.meeting.minutes")).replace(/[<>:"/\\|?*]/g, "_")}.docx`;
    const path = await save({
      defaultPath: suggestedName,
      filters: [
        { name: t("settings.meeting.wordDocument"), extensions: ["docx"] },
      ],
    });
    if (!path) return;
    setExportingWord(true);
    try {
      const { createMeetingWordDocument } = await import("./meetingWordExport");
      const document = await createMeetingWordDocument(
        minutes,
        t,
        i18n.language,
      );
      const result = await commands.saveMeetingWordDocument(
        path,
        Array.from(document),
      );
      if (result.status === "error") throw new Error(result.error);
      toast.success(t("settings.meeting.wordExported"));
    } catch (error) {
      toast.error(t("settings.meeting.wordExportFailed"), {
        description: String(error),
      });
    } finally {
      setExportingWord(false);
    }
  };

  /** Export the selected minutes as a self-contained, styled HTML page. */
  const exportHtml = async () => {
    if (!minutes || exportingHtml) return;
    const suggestedName = `${(selectedSession?.title || t("settings.meeting.minutes")).replace(/[<>:"/\\|?*]/g, "_")}.html`;
    const path = await save({
      defaultPath: suggestedName,
      filters: [
        { name: t("settings.meeting.htmlDocument"), extensions: ["html"] },
      ],
    });
    if (!path) return;
    setExportingHtml(true);
    try {
      const { createMeetingHtmlDocument } = await import("./meetingHtmlExport");
      const html = createMeetingHtmlDocument(minutes, t, i18n.language);
      const result = await commands.saveMeetingHtmlDocument(path, html);
      if (result.status === "error") throw new Error(result.error);
      toast.success(t("settings.meeting.htmlExported"));
    } catch (error) {
      toast.error(t("settings.meeting.htmlExportFailed"), {
        description: String(error),
      });
    } finally {
      setExportingHtml(false);
    }
  };

  /** Confirm and remove a meeting, then select the next available record. */
  const deleteMeeting = async (session: MeetingSession) => {
    if (deletingId || generating) return;
    const confirmed = await ask(
      t("settings.meeting.deleteConfirm", { title: session.title }),
      {
        title: t("settings.meeting.deleteTitle"),
        kind: "warning",
      },
    );
    if (!confirmed) return;
    setDeletingId(session.id);
    try {
      const result = await commands.deleteMeeting(session.id);
      if (result.status === "error") {
        toast.error(t("settings.meeting.deleteFailed"), {
          description: result.error,
        });
        return;
      }
      setSessions((current) =>
        current.filter((item) => item.id !== session.id),
      );
      if (selectedId === session.id) {
        setSelectedId(
          sessions.find((item) => item.id !== session.id)?.id ?? null,
        );
        setProgress(null);
      }
      toast.success(t("settings.meeting.deleted"));
    } catch (error) {
      toast.error(t("settings.meeting.deleteFailed"), {
        description: String(error),
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="max-w-5xl w-full mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-medium text-mid-gray uppercase tracking-wide">
            {t("settings.meeting.title")}
          </h2>
          <p className="text-sm text-text/60 mt-1">
            {t("settings.meeting.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={liveRecording ? stopLiveMeeting : startLiveMeeting}
            disabled={loading}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap"
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
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap"
          >
            <Upload className="w-4 h-4" />
            {t("settings.meeting.importAudio")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="border border-mid-gray/20 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-mid-gray/20 flex items-center justify-between">
            <span className="text-sm font-medium">
              {t("settings.meeting.history")}
            </span>
            <button
              type="button"
              onClick={() => void refreshMeetings()}
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
              <div
                key={session.id}
                className={`flex items-center border-b border-mid-gray/10 hover:bg-background-ui/30 ${selectedId === session.id ? "bg-logo-primary/20" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(session.id)}
                  disabled={generating || deletingId === session.id}
                  className="min-w-0 flex-1 text-start px-3 py-2"
                >
                  <span className="block text-sm truncate">
                    {session.title}
                  </span>
                  <span className="block text-xs text-text/50">
                    {t(`settings.meeting.statuses.${session.status}`)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void deleteMeeting(session)}
                  disabled={
                    generating ||
                    deletingId !== null ||
                    (liveRecording && session.id === selectedId)
                  }
                  className="p-2 mr-1 text-text/50 hover:text-red-500 disabled:opacity-40"
                  aria-label={t("settings.meeting.deleteTitle")}
                  title={t("settings.meeting.deleteTitle")}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="min-w-0 space-y-4">
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

          <div className="border border-mid-gray/20 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-logo-primary" />
                <span className="font-medium">
                  {t("settings.meeting.minutes")}
                </span>
              </div>
              <span className="rounded-full bg-logo-primary/10 px-2.5 py-1 text-xs text-text/65">
                {t(`settings.meeting.providers.${providerId}`)} · {model}
              </span>
            </div>
            <p className="text-xs text-text/55">
              {t("settings.meeting.modelSettingsHint")}
            </p>
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
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button
                onClick={generateMinutes}
                disabled={!selectedId || generating || !preferencesLoaded}
                className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap"
              >
                {generating && <RefreshCw className="h-4 w-4 animate-spin" />}
                {t(
                  generating
                    ? "settings.meeting.generatingMinutes"
                    : "settings.meeting.generateMinutes",
                )}
              </Button>
            </div>
            {generating && (
              <p
                className="text-sm text-text/60"
                role="status"
                aria-live="polite"
              >
                {t("settings.meeting.generatingHint")}
              </p>
            )}
          </div>
        </div>
      </div>
      {minutes && (
        <div ref={minutesRef}>
          <div className="mb-3 flex flex-wrap justify-end gap-2">
            <Button
              onClick={exportHtml}
              disabled={exportingHtml}
              variant="secondary"
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap"
            >
              <FileCode2 className="h-4 w-4" />
              {t(
                exportingHtml
                  ? "settings.meeting.exportingHtml"
                  : "settings.meeting.exportHtml",
              )}
            </Button>
            <Button
              onClick={exportWord}
              disabled={exportingWord}
              variant="secondary"
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap"
            >
              <FileDown className="h-4 w-4" />
              {t(
                exportingWord
                  ? "settings.meeting.exportingWord"
                  : "settings.meeting.exportWord",
              )}
            </Button>
          </div>
          <MeetingMinutesView minutes={minutes} />
        </div>
      )}
    </div>
  );
};
