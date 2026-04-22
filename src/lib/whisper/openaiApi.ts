import axios, { RawAxiosRequestHeaders } from "axios";
import {
  DEFAULT_TYPEWHISPER_BASE_URL,
  DEFAULT_WHISPER_BASE_URL,
  normalizeWhisperBaseUrl,
} from "./baseUrl";

type WhisperApiProvider = "openai" | "typewhisper" | "custom";

type WhisperRequestOptions = {
  provider?: WhisperApiProvider;
  baseUrl?: string | null;
  apiKey?: string | null;
  language?: string;
  prompt?: string;
  response_format?: string;
  temperature?: number;
};

export async function requestWhisperOpenaiApi(
  file: File,
  mode: "transcriptions" | "translations" = "transcriptions",
  opts: WhisperRequestOptions = {},
) {
  const provider = opts.provider ?? "openai";

  if (provider === "typewhisper") {
    return requestTypeWhisperApi(file, mode, opts);
  }

  return requestOpenAiCompatibleApi(file, mode, opts);
}

async function requestOpenAiCompatibleApi(
  file: File,
  mode: "transcriptions" | "translations",
  opts: WhisperRequestOptions,
) {
  // Whisper only accept multipart/form-data currently
  const body = new FormData();
  body.append("file", file);
  body.append("model", "gpt-4o-transcribe");

  if (mode === "transcriptions" && opts.language) {
    body.append("language", opts.language);
  }
  if (opts.prompt) {
    body.append("prompt", opts.prompt);
  }
  if (opts.response_format) {
    body.append("response_format", opts.response_format);
  }
  if (opts.temperature) {
    body.append("temperature", `${opts.temperature}`);
  }

  const headers: RawAxiosRequestHeaders = {};
  headers["Content-Type"] = "multipart/form-data";
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const baseUrl = normalizeWhisperBaseUrl(opts.baseUrl, DEFAULT_WHISPER_BASE_URL);

  const response = await axios.post(`${baseUrl}/audio/${mode}`, body, {
    headers,
    timeout: 30_000,
  });

  return response.data.text as string;
}

async function requestTypeWhisperApi(
  file: File,
  mode: "transcriptions" | "translations",
  opts: WhisperRequestOptions,
) {
  const body = new FormData();
  body.append("file", file);

  if (opts.language) {
    body.append("language", opts.language);
  }

  if (mode === "translations") {
    body.append("task", "translate");
  }

  const headers: RawAxiosRequestHeaders = {};
  headers["Content-Type"] = "multipart/form-data";
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const baseUrl = normalizeWhisperBaseUrl(
    opts.baseUrl,
    DEFAULT_TYPEWHISPER_BASE_URL,
  );

  const response = await axios.post(`${baseUrl}/transcribe`, body, {
    headers,
    timeout: 30_000,
  });

  const text = response?.data?.text;
  if (typeof text !== "string") {
    throw new Error("TypeWhisper API response does not contain text");
  }

  return text;
}
