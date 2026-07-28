# Loudness Safety Fix

## Problem found
The output verification only retried when `finalAnalysis.lufs` was a valid number and outside tolerance. If FFmpeg produced an almost silent MP3 whose LUFS could not be measured, verification remained successful. Invalid loudnorm measurements such as `-inf` could also be passed into the linear second pass.

## Fixes
- Validate every loudnorm first-pass measurement before using linear two-pass normalization.
- Treat missing/unmeasurable LUFS as a verification failure.
- Detect near-silent output using peak and RMS safety thresholds.
- Retry failed output with dynamic loudnorm (`linear=false`).
- If the retry is still inaudible, fail that individual file instead of packaging a silent replacement.
- Added the same fail-safe to the currently unused optimized pipeline so it is safe if enabled later.

## Result
A file can no longer be marked successful when its normalized output is effectively silent.
