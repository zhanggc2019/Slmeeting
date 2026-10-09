import { Store } from "@tauri-apps/plugin-store";

export interface MeetingLlmProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface MeetingPreferences {
  providerId: string;
  templateId: string;
  profiles: Record<string, MeetingLlmProfile>;
}

const STORE_PATH = "meeting-llm-preferences.json";

const PROVIDER_DEFAULTS: Record<string, MeetingLlmProfile> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    apiKey: "",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    apiKey: "",
  },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen3", apiKey: "" },
  custom: { baseUrl: "", model: "", apiKey: "" },
};

/** Return defaults for the meeting module without changing global app settings. */
export function defaultMeetingPreferences(): MeetingPreferences {
  return { providerId: "deepseek", templateId: "standard", profiles: {} };
}

/** Resolve a provider profile, preserving the configured API key per provider. */
export function meetingProfile(
  preferences: MeetingPreferences,
  providerId: string,
): MeetingLlmProfile {
  return {
    ...PROVIDER_DEFAULTS[providerId],
    ...preferences.profiles[providerId],
  };
}

/** Load locally saved meeting LLM preferences from the dedicated Tauri store. */
export async function loadMeetingPreferences(): Promise<MeetingPreferences> {
  const store = await Store.load(STORE_PATH);
  const saved = await store.get<MeetingPreferences>("preferences");
  if (!saved || !PROVIDER_DEFAULTS[saved.providerId] || !saved.profiles) {
    return defaultMeetingPreferences();
  }
  return saved;
}

/** Persist meeting LLM preferences for the next app launch. */
export async function saveMeetingPreferences(
  preferences: MeetingPreferences,
): Promise<void> {
  const store = await Store.load(STORE_PATH);
  await store.set("preferences", preferences);
  await store.save();
}
