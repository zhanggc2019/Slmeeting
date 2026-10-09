import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Link2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import {
  defaultMeetingPreferences,
  loadMeetingPreferences,
  meetingProfile,
  saveMeetingPreferences,
  type MeetingLlmProfile,
} from "./meetingPreferences";

/** Configure the provider and credentials used only for meeting minutes. */
export const MeetingModelSettings: React.FC = () => {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState(defaultMeetingPreferences);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const latest = useRef(preferences);
  const loadedRef = useRef(false);
  latest.current = preferences;
  const { providerId } = preferences;
  const profile = meetingProfile(preferences, providerId);

  useEffect(() => {
    let active = true;
    void loadMeetingPreferences()
      .then((value) => {
        if (active) {
          setPreferences(value);
          setLoaded(true);
          loadedRef.current = true;
        }
      })
      .catch(() => toast.error(t("settings.meeting.preferencesFailed")));
    return () => {
      active = false;
    };
  }, [t]);

  useEffect(() => {
    if (!loaded) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      void saveMeetingPreferences(preferences)
        .then(() => setSaved(true))
        .catch(() => toast.error(t("settings.meeting.preferencesFailed")));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [loaded, preferences, t]);

  useEffect(
    () => () => {
      if (loadedRef.current) void saveMeetingPreferences(latest.current);
    },
    [],
  );

  /** Update the selected provider while preserving credentials for the others. */
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

  return (
    <section className="overflow-hidden rounded-2xl border border-mid-gray/20 bg-background shadow-[0_14px_36px_-30px_rgba(13,48,100,0.5)]">
      <div className="border-b border-mid-gray/15 bg-gradient-to-r from-logo-primary/15 to-transparent px-5 py-5">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-logo-primary/20 p-2 text-logo-primary">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-semibold text-text">
              {t("settings.models.tabs.minutes")}
            </h2>
            <p className="text-sm text-text/60">
              {t("settings.models.minutesDescription")}
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-5 p-5 sm:grid-cols-2">
        <label className="space-y-2 sm:col-span-2">
          <span className="text-sm font-medium text-text/75">
            {t("settings.models.minutesProvider")}
          </span>
          <Select
            value={providerId}
            options={[
              "deepseek",
              "openai",
              "openrouter",
              "ollama",
              "custom",
            ].map((provider) => ({
              value: provider,
              label: t(`settings.meeting.providers.${provider}`),
            }))}
            isClearable={false}
            onChange={(value) =>
              setPreferences((current) => ({
                ...current,
                providerId: value ?? "deepseek",
              }))
            }
          />
        </label>
        <label className="space-y-2 sm:col-span-2">
          <span className="flex items-center gap-2 text-sm font-medium text-text/75">
            <Link2 className="h-4 w-4 text-logo-primary" />
            {t("settings.meeting.baseUrl")}
          </span>
          <Input
            value={profile.baseUrl}
            onChange={(event) => updateProfile({ baseUrl: event.target.value })}
            placeholder={t("settings.meeting.baseUrl")}
            className="w-full font-normal"
          />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-text/75">
            {t("settings.meeting.model")}
          </span>
          <Input
            value={profile.model}
            onChange={(event) => updateProfile({ model: event.target.value })}
            placeholder={t("settings.meeting.model")}
            className="w-full font-normal"
          />
        </label>
        {providerId !== "ollama" && (
          <label className="space-y-2">
            <span className="flex items-center gap-2 text-sm font-medium text-text/75">
              <KeyRound className="h-4 w-4 text-logo-primary" />
              {t("settings.meeting.apiKey")}
            </span>
            <Input
              type="password"
              value={profile.apiKey}
              onChange={(event) =>
                updateProfile({ apiKey: event.target.value })
              }
              placeholder={t("settings.meeting.apiKey")}
              className="w-full font-normal"
            />
          </label>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-mid-gray/15 px-5 py-3 text-xs text-text/55">
        {saved && <CheckCircle2 className="h-4 w-4 text-logo-primary" />}
        {t(
          saved
            ? "settings.models.minutesSaved"
            : "settings.models.minutesAutosave",
        )}
      </div>
    </section>
  );
};
