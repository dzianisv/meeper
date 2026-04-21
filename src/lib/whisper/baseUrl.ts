const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export const DEFAULT_WHISPER_BASE_URL = "https://api.openai.com/v1";

export function isSafeWhisperBaseUrl(value: string) {
  try {
    const parsed = new URL(value);
    return HTTP_PROTOCOLS.has(parsed.protocol) && Boolean(parsed.host);
  } catch {
    return false;
  }
}

export function normalizeWhisperBaseUrl(baseUrl?: string | null) {
  const value = baseUrl?.trim();
  if (!value || !isSafeWhisperBaseUrl(value)) {
    return DEFAULT_WHISPER_BASE_URL;
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
