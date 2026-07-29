# Backend Connection Verification

## 1. Health

```bash
curl -i https://YOUR-RAILWAY-DOMAIN/health
```

Expected: HTTP 200 with `status: "ok"`, plus both `ffmpeg` and `ffprobe` versions. HTTP 503 means the media tools are unavailable.

## 2. HTTPS

An HTTPS frontend must call an HTTPS backend. Browsers block mixed-content requests to an HTTP backend.

## 3. CORS

Set Railway `CORS_ORIGIN` to the frontend origin exactly, without a trailing slash. Multiple origins are comma-separated.

```text
CORS_ORIGIN=https://preview.example,https://www.example.com
```

Preflight check:

```bash
curl -i -X OPTIONS \
  -H 'Origin: https://preview.example' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  https://YOUR-RAILWAY-DOMAIN/jobs
```

## 4. Analyze upload

```bash
curl -i -F 'file=@sample.mp3;type=audio/mpeg' \
  https://YOUR-RAILWAY-DOMAIN/analyze
```

The frontend must send `FormData` and must not manually set `Content-Type`; the browser adds the multipart boundary.

## 5. Job event contract

After `POST /jobs` returns `{ "jobId": "..." }`, connect to:

```text
GET /jobs/<jobId>/events
```

Events are `progress`, `file`, and terminal `done`. The `done` payload includes `status`, `success`, and `error`. A disconnected client can recover current state from `GET /jobs/<jobId>`.

## 6. Download contract

`GET /jobs/<jobId>/download` returns:

- 200 only when every output passed verification;
- 409 while processing, after cancellation, or after any file failure;
- 404 after retention cleanup or for an invalid ID.

The CSV report can still be downloaded for failed jobs.

## 7. Railway settings

- Root directory: the directory containing this Dockerfile.
- Health path: `/health`.
- Public networking: enabled.
- `PORT`: Railway supplies it automatically.
- Optional persistent volume: mount at `/app/work`.
- Do not use the old Lovable-only package registry URLs; this package lock uses the public npm registry.
