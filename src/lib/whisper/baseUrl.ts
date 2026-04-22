const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export const DEFAULT_WHISPER_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_TYPEWHISPER_BASE_URL = "http://127.0.0.1:8978/v1";

export function isSafeWhisperBaseUrl(value: string) {
  try {
    const parsed = new URL(value);
    return HTTP_PROTOCOLS.has(parsed.protocol) && Boolean(parsed.host);
  } catch {
    return false;
  }
}

export function normalizeWhisperBaseUrl(
  baseUrl?: string | null,
  fallbackBaseUrl: string = DEFAULT_WHISPER_BASE_URL,
) {
  const value = baseUrl?.trim();
  if (!value || !isSafeWhisperBaseUrl(value)) {
    return fallbackBaseUrl;
  }

  const parsed = new URL(value);
  parsed.search = "";
  parsed.hash = "";

  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname) {
    pathname = "/v1";
  }

  return `${parsed.origin}${pathname}`;
}
