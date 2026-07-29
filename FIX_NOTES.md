# Correctness Changes

The previous implementation could mark outputs successful without satisfying the requested loudness contract. It allowed a single-pass fallback, configurable verification tolerance, a relaxed retry tolerance, and a forced-gain path that accepted merely audible output. It also placed a limiter after loudnorm, did not enforce the true-peak verification requirement, and packaged partial failures as a ready job.

The canonical pipeline now:

- enforces -16 LUFS ±0.3 LU and true peak ≤ -1.5 dBTP;
- requires finite Pass One measurements and always supplies them to Pass Two;
- applies all tonal/dynamic processing before normalization;
- preconditions recoverable below-gate audio before Pass One while rejecting digital silence;
- remeasures the encoded MP3;
- retries only with another complete measured two-pass attempt;
- creates no ZIP when any file fails;
- aborts FFmpeg on cancellation;
- deletes staging directories in `finally` blocks;
- uses batch-wide export settings;
- preserves metadata;
- bounds child-process output and adds process timeouts.
