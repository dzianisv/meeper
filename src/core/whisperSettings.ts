import memoizeOne from "memoize-one";
import { decrypt, encrypt } from "../lib/encryption";
import {
  getOpenAiApiKey,
  validateApiKey,
} from "./openaiApiKey";
import {
  DEFAULT_WHISPER_BASE_URL,
  normalizeWhisperBaseUrl,
} from "../lib/whisper/baseUrl";

const WHISPER_SETTINGS = "_whisper_settings";

export type WhisperProviderMode = "openai" | "selfHosted";

export interface WhisperSettings {
  provider: WhisperProviderMode;
  baseUrl: string;
  apiKey: string | null;
}

type WhisperSettingsStored = {
  provider?: WhisperProviderMode;
  baseUrl?: string;
  apiKey?: string;
};

export const getWhisperSettings = memoizeOne(async (): Promise<WhisperSettings> => {
  const { [WHISPER_SETTINGS]: storedSettings } = await chrome.storage.local.get(
    WHISPER_SETTINGS,
  );

  const parsed = (storedSettings ?? null) as WhisperSettingsStored | null;
  const apiKey = await decryptApiKey(parsed?.apiKey);
  if (!isWhisperSettingsComplete(parsed)) {
    const legacyApiKey = await getOpenAiApiKey();
    return {
      provider: "openai",
      baseUrl: DEFAULT_WHISPER_BASE_URL,
      apiKey: legacyApiKey,
    };
  }

  const provider = parsed.provider;
  const baseUrl = normalizeWhisperBaseUrl(parsed.baseUrl);

  if (provider === "openai") {
    const openAiApiKey = apiKey ?? (await getOpenAiApiKey());
    await validateApiKey(openAiApiKey);

    return {
      provider,
      baseUrl,
      apiKey: openAiApiKey,
    };
  }

  return {
    provider,
    baseUrl,
    apiKey,
  };
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "WHISPER_SETTINGS_REFRESHED" || msg?.type === "APIKEY_REFRESHED") {
    getWhisperSettings.clear();
  }
});

export async function setWhisperSettings(settings: WhisperSettings | null) {
  if (!settings) {
    await chrome.storage.local.remove(WHISPER_SETTINGS);
    chrome.runtime.sendMessage({ type: "WHISPER_SETTINGS_REFRESHED" });
    return;
  }

  const encryptedApiKey = settings.apiKey ? await encrypt(settings.apiKey) : "";

  await chrome.storage.local.set({
    [WHISPER_SETTINGS]: {
      provider: settings.provider,
      baseUrl: normalizeWhisperBaseUrl(settings.baseUrl),
      apiKey: encryptedApiKey,
    },
  });

  chrome.runtime.sendMessage({ type: "WHISPER_SETTINGS_REFRESHED" });
}

async function decryptApiKey(encrypted?: string) {
  if (!encrypted) {
    return null;
  }

  return decrypt(encrypted).catch(() => null);
}

function isWhisperProvider(mode?: string): mode is WhisperProviderMode {
  return mode === "openai" || mode === "selfHosted";
}

function isWhisperSettingsComplete(
  settings: WhisperSettingsStored | null,
): settings is {
  provider: WhisperProviderMode;
  baseUrl: string;
} {
  if (!settings) {
    return false;
  }

  return (
    isWhisperProvider(settings.provider) &&
    typeof settings.baseUrl === "string" &&
    settings.baseUrl.trim().length > 0
  );
}
