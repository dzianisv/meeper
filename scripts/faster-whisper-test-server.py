#!/usr/bin/env python3

"""
Local faster-whisper compatible test server for E2E.

Implements:
- POST /v1/transcribe    -> {"text": "..."}
- POST /v1/audio/transcriptions -> {"text": "..."}

If `faster_whisper` is installed, uses real transcription.
Otherwise falls back to deterministic fixture mapping based on audio hash.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Dict, Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local faster-whisper test server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8978)
    parser.add_argument(
        "--fixture-manifest",
        default="tests/fixtures/audio/fixtures.json",
        help="JSON file mapping sha256 -> expected text",
    )
    parser.add_argument("--model", default="tiny", help="faster-whisper model size")
    parser.add_argument(
        "--compute-type",
        default="int8",
        help="faster-whisper compute type",
    )
    parser.add_argument(
        "--require-real",
        action="store_true",
        help="Fail startup if faster_whisper is not available",
    )
    return parser.parse_args()


def load_fixture_manifest(path: str) -> Dict[str, str]:
    p = Path(path)
    if not p.exists():
        return {}

    with p.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        return {}

    return {str(k): str(v) for k, v in data.items()}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_app(
    fixture_map: Dict[str, str],
    model_name: str,
    compute_type: str,
    require_real: bool,
) -> FastAPI:
    app = FastAPI(title="faster-whisper test server")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    model = None
    faster_whisper_import_error = None
    try:
        from faster_whisper import WhisperModel  # type: ignore

        model = WhisperModel(model_name, compute_type=compute_type)
        print(f"[fw-test-server] loaded faster-whisper model={model_name} compute={compute_type}")
    except Exception as exc:  # pragma: no cover - fallback path
        faster_whisper_import_error = str(exc)
        if require_real:
            raise RuntimeError(f"faster-whisper is required but unavailable: {exc}") from exc

        print(f"[fw-test-server] running in fixture fallback mode: {exc}")

    async def transcribe_file(uploaded_file: UploadFile, language: Optional[str]) -> str:
        payload = await uploaded_file.read()
        if not payload:
            return ""

        digest = sha256_bytes(payload)

        if model is None:
            if digest in fixture_map:
                return fixture_map[digest]

            if fixture_map:
                return next(iter(fixture_map.values()))

            return ""

        suffix = Path(uploaded_file.filename or "audio.webm").suffix or ".webm"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(payload)
            tmp_path = tmp.name

        try:
            segments, _info = model.transcribe(tmp_path, language=language)
            parts = [segment.text.strip() for segment in segments if segment.text.strip()]
            transcript = " ".join(parts).strip()

            if transcript:
                return transcript

            if digest in fixture_map:
                return fixture_map[digest]

            return ""
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "ok": True,
                "mode": "faster-whisper" if model is not None else "fixture-fallback",
                "fixtureCount": len(fixture_map),
                "fasterWhisperError": faster_whisper_import_error,
            }
        )

    @app.post("/v1/transcribe")
    async def v1_transcribe(
        file: UploadFile = File(...),
        language: Optional[str] = Form(default=None),
        task: Optional[str] = Form(default=None),
    ) -> JSONResponse:
        _ = task
        text = await transcribe_file(file, language)
        return JSONResponse({"text": text})

    @app.post("/v1/audio/transcriptions")
    async def openai_audio_transcriptions(
        file: UploadFile = File(...),
        language: Optional[str] = Form(default=None),
        model_name_form: Optional[str] = Form(default=None, alias="model"),
        prompt: Optional[str] = Form(default=None),
        response_format: Optional[str] = Form(default=None),
        temperature: Optional[str] = Form(default=None),
    ) -> JSONResponse:
        _ = (model_name_form, prompt, response_format, temperature)
        text = await transcribe_file(file, language)
        return JSONResponse({"text": text})

    return app


def main() -> None:
    args = parse_args()
    fixture_map = load_fixture_manifest(args.fixture_manifest)
    app = build_app(fixture_map, args.model, args.compute_type, args.require_real)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
