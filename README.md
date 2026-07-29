# Voice Batch Studio Backend — Strict Verified Normalization

This backend processes uploaded MP3 files with FFmpeg and does not expose a successful download unless every included output passes strict post-encode verification.

## Enforced audio contract

- Integrated loudness: **-16 LUFS**
- Allowed deviation: **±0.3 LU**
- True peak: **≤ -1.5 dBTP**
- Codec: **libmp3lame**
- Default batch-wide export: **192 kbps, 48 kHz, stereo**
- Presets, EQ, speed, compression, fades, noise processing, and optional limiting run **before** loudness measurement and normalization.

The target, tolerance, and true-peak limit cannot be disabled by frontend settings.

## Normalization workflow

1. Decode and apply all selected enhancement filters to a floating-point WAV using the final batch-wide channel count and sample rate.
2. For valid audio below EBU R128's absolute gate, apply a bounded preconditioning gain before measurement. Digital silence is rejected.
3. **Pass One:** measure `input_i`, `input_lra`, `input_tp`, `input_thresh`, and `target_offset` with `loudnorm`.
4. **Pass Two:** pass every measured value back to `loudnorm`; no gain-changing filter is placed after it.
5. Encode the MP3 with identical settings for the whole job and preserve source metadata.
6. Measure the encoded MP3 again.
7. Accept only when integrated loudness is within ±0.3 LU and true peak is at or below -1.5 dBTP.
8. A failed verification triggers a new measured two-pass attempt. There is no single-pass fallback and no forced-gain success path.
9. If any file fails, the job is `failed`, no result ZIP is created, and the CSV report remains available.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Verifies both FFmpeg and FFprobe; returns 503 if unavailable |
| POST | `/analyze` | Analyzes one multipart MP3 field named `file` |
| POST | `/jobs` | Creates a multipart batch job |
| GET | `/jobs/:id` | Current status and per-file results |
| GET | `/jobs/:id/events` | SSE progress, file, and terminal `done` events |
| GET | `/jobs/:id/download` | ZIP; available only for a fully verified `ready` job |
| GET | `/jobs/:id/report.csv` | Report for passed, failed, or cancelled jobs |
| POST | `/jobs/:id/cancel` | Aborts active and queued FFmpeg work |

### Job multipart format

- `payload`: JSON containing `settings` and `files`
- One file field per included descriptor: `file_<id>`
- IDs must contain only letters, digits, `_`, or `-`
- The browser must not manually set the multipart `Content-Type` header.

## Local run

Requirements: Node.js 20+, FFmpeg, FFprobe, and the `zip` utility.

```bash
npm ci
npm run check
npm test
npm start
```

The server listens on `process.env.PORT` or port 8080 and binds to `0.0.0.0` by default.

## Railway

The included Dockerfile installs FFmpeg, FFprobe, `zip`, and `tini`, uses `npm ci`, runs as the non-root `node` user, and stores jobs under `/app/work`.

Recommended variables:

```text
CORS_ORIGIN=https://your-frontend.example
MAX_UPLOAD_MB=4096
JOB_TTL_SECONDS=3600
FFMPEG_WORKERS=4
FFMPEG_TIMEOUT_MS=1800000
LOG_LEVEL=info
```

Use an HTTPS Railway public URL from an HTTPS frontend. A browser will block an HTTPS page from calling an HTTP backend.

## Tests and evidence

- `test/core-normalization.test.mjs`: real FFmpeg normalization, strict remeasurement, cancellation, cleanup, fail-closed job lifecycle, report and ZIP packaging.
- `test/e2e.test.mjs`: live HTTP, CORS, multipart upload, SSE, status, report, download, path validation, and corrupt-input contract.
- `VERIFICATION_RESULTS.json`: before/pass-one/after measurements from the executed core suite.
- `ENGINEERING_AUDIT_REPORT.md`: complete findings, modifications, and verification boundary.
