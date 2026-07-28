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

---

# Round 2: "some files are still too quiet to hear"

## Problem found
1. `settings.verifyOutput === false` (sent by the frontend) skipped the audibility
   check entirely — nothing stopped a whisper-quiet file from shipping if that flag
   was ever set or defaulted wrong on the client.
2. The near-silence thresholds (`maxPeak < -30dB`, `rms < -42dB`) only caught
   *near-total silence*. A file could measure within LUFS tolerance on paper
   (long pauses skew integrated-loudness gating) while still sounding much
   quieter than other files in the batch.
3. When a file failed verification twice, it was simply **dropped** from the
   output zip (only listed in `failed_files.txt`/`report.csv`) instead of being
   fixed — easy to miss if you're not checking those.

## Fixes
- Added a hard, non-bypassable audibility floor (`outputIsHardSilent`,
  `HARD_MIN_MAX_PEAK_DB = -18`, `HARD_MIN_RMS_DB = -30`) that always runs,
  even when `verifyOutput: false` is sent — that setting now only relaxes the
  LUFS-target comparison, not this floor.
- Added a third, last-resort repair pass: if a file is still inaudible after
  the dynamic-loudnorm retry, apply a direct `volume` gain boost (computed
  from the file's actually-measured peak, pushed up to just under the limiter
  ceiling) instead of failing the file outright.
- The file now only fails (and gets excluded/reported) if the source is
  genuinely silent/corrupted and even the forced gain pass can't recover it.

## Result
Files are amplified up to an audible level instead of being silently dropped
from the batch when normal loudnorm undershoots on unusual source audio.
