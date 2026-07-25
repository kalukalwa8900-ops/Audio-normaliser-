import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { analyzeLoudness, classifyLoudness, probeAudio, runCommand } from './ffmpeg.js';
import { assertNotCancelled, updateJob } from './jobs.js';
import { ensureDirs, zipDirectory, csvEscape } from './files.js';

const PRESETS = {
  original: [],
  voice_focus: ['highpass=f=80', 'equalizer=f=300:t=q:w=1:g=-2', 'equalizer=f=3000:t=q:w=1:g=2', 'acompressor=threshold=-20dB:ratio=2:attack=15:release=180:makeup=1'],
  clear_narration: ['highpass=f=75', 'afftdn=nf=-28:tn=1', 'equalizer=f=280:t=q:w=1:g=-2', 'equalizer=f=3200:t=q:w=1:g=1.5', 'deesser=i=0.25:m=0.5:f=0.5', 'acompressor=threshold=-21dB:ratio=2.2:attack=12:release=160:makeup=1'],
  sweet_voice: ['highpass=f=70', 'equalizer=f=180:t=q:w=1:g=1.2', 'equalizer=f=4500:t=q:w=1:g=-1', 'deesser=i=0.18:m=0.4:f=0.5', 'acompressor=threshold=-22dB:ratio=1.8:attack=18:release=220:makeup=1'],
  deep_narration: ['highpass=f=65', 'equalizer=f=160:t=q:w=1:g=1.5', 'equalizer=f=5000:t=q:w=1:g=-1.2', 'acompressor=threshold=-21dB:ratio=2:attack=18:release=200:makeup=1'],
  bright_voice: ['highpass=f=80', 'equalizer=f=300:t=q:w=1:g=-2', 'equalizer=f=3500:t=q:w=1:g=2', 'deesser=i=0.22:m=0.45:f=0.5'],
  podcast_voice: ['highpass=f=80', 'afftdn=nf=-30:tn=1', 'equalizer=f=250:t=q:w=1:g=-1.5', 'equalizer=f=2800:t=q:w=1:g=1.5', 'deesser=i=0.25:m=0.5:f=0.5', 'acompressor=threshold=-22dB:ratio=2.5:attack=10:release=160:makeup=1'],
  noisy_repair: ['highpass=f=90', 'afftdn=nf=-25:tn=1', 'adeclick', 'acompressor=threshold=-22dB:ratio=2:attack=15:release=180:makeup=1']
};

function atempoChain(speed) {
  let value = Number(speed || 1);
  if (!(value >= 0.5 && value <= 2)) throw new Error('Speed must be between 0.5 and 2.0');
  return value === 1 ? [] : [`atempo=${value.toFixed(4)}`];
}

function finite(value, fallback) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function ff(value) { return finite(value, 0).toFixed(2); }

export async function analyzeJob(job, entries, settings = {}) {
  job.files = entries.map((e) => ({ ...e, status: 'pending' }));
  updateJob(job, { status: 'analyzing', stage: 'analyzing', progress: 1 });
  const concurrency = Math.max(1, finite(process.env.PROCESS_CONCURRENCY, 2));
  const limit = pLimit(concurrency);
  let done = 0;

  await Promise.all(job.files.map((file) => limit(async () => {
    assertNotCancelled(job);
    try {
      const [metadata, loudness] = await Promise.all([
        probeAudio(file.absolutePath), analyzeLoudness(file.absolutePath, settings)
      ]);
      Object.assign(file, { metadata, original: loudness, classification: classifyLoudness(loudness.inputI, loudness.inputTp), status: 'analyzed' });
    } catch (error) {
      Object.assign(file, { status: 'analysis_failed', error: error.message });
      job.errors.push({ file: file.relativePath, stage: 'analysis', error: error.message });
    }
    done += 1;
    updateJob(job, { progress: Math.round((done / job.files.length) * 100), currentFile: file.relativePath });
  })));

  updateJob(job, { status: 'analyzed', stage: 'ready', progress: 100, currentFile: null }, 'analyzed');
}

function buildPreFilters(settings) {
  const preset = PRESETS[settings.preset] || PRESETS.original;
  return [...preset, ...atempoChain(settings.speed)];
}

async function processOne(job, file, settings) {
  assertNotCancelled(job);
  const targetLufs = finite(settings.targetLufs, -16);
  const lra = finite(settings.lra, 7);
  const truePeak = finite(settings.truePeak, -1.5);
  const bitrate = Math.max(64, Math.min(320, finite(settings.bitrateKbps, 192)));
  const preFilters = buildPreFilters(settings);
  const tempPre = path.join(job.workDir, 'pre', file.relativePath);
  const output = path.join(job.outputDir, file.relativePath);
  await ensureDirs(path.dirname(tempPre), path.dirname(output));

  let analysisInput = file.absolutePath;
  if (preFilters.length) {
    await runCommand('ffmpeg', ['-y', '-hide_banner', '-nostdin', '-i', file.absolutePath, '-af', preFilters.join(','), '-vn', '-c:a', 'pcm_s16le', tempPre.replace(/\.mp3$/i, '.wav')]);
    analysisInput = tempPre.replace(/\.mp3$/i, '.wav');
  }

  const measured = await analyzeLoudness(analysisInput, { targetLufs, lra, truePeak });
  const loudnorm = [
    `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${truePeak}`,
    `measured_I=${ff(measured.inputI)}`,
    `measured_LRA=${ff(measured.inputLra)}`,
    `measured_TP=${ff(measured.inputTp)}`,
    `measured_thresh=${ff(measured.inputThresh)}`,
    `offset=${ff(measured.targetOffset)}`,
    'linear=true:print_format=summary'
  ].join(':');

  await runCommand('ffmpeg', ['-y', '-hide_banner', '-nostdin', '-i', analysisInput, '-af', `${loudnorm},alimiter=limit=${Math.pow(10, truePeak / 20).toFixed(6)}`, '-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, output]);

  let verified = await analyzeLoudness(output, { targetLufs, lra, truePeak });
  const tolerance = finite(settings.toleranceLu, 0.5);
  if (Math.abs(verified.inputI - targetLufs) > tolerance) {
    await runCommand('ffmpeg', ['-y', '-hide_banner', '-nostdin', '-i', output, '-af', `loudnorm=I=${targetLufs}:LRA=${lra}:TP=${truePeak}:linear=false,alimiter=limit=${Math.pow(10, truePeak / 20).toFixed(6)}`, '-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, `${output}.retry.mp3`]);
    await fs.rename(`${output}.retry.mp3`, output);
    verified = await analyzeLoudness(output, { targetLufs, lra, truePeak });
  }

  const finalMeta = await probeAudio(output);
  return { output, final: verified, finalMetadata: finalMeta, pass: Math.abs(verified.inputI - targetLufs) <= tolerance && verified.inputTp <= truePeak + 0.2 };
}

export async function processJob(job, settings = {}) {
  updateJob(job, { status: 'processing', stage: 'processing', progress: 0, settings });
  const files = job.files.filter((f) => f.status === 'analyzed' && !f.excluded);
  const concurrency = Math.max(1, finite(process.env.PROCESS_CONCURRENCY, 2));
  const limit = pLimit(concurrency);
  let done = 0;

  await Promise.all(files.map((file) => limit(async () => {
    try {
      Object.assign(file, { status: 'processing' });
      const result = await processOne(job, file, settings);
      Object.assign(file, { ...result, status: result.pass ? 'completed' : 'needs_review' });
    } catch (error) {
      Object.assign(file, { status: error.code === 'JOB_CANCELLED' ? 'cancelled' : 'processing_failed', error: error.message });
      job.errors.push({ file: file.relativePath, stage: 'processing', error: error.message });
    }
    done += 1;
    updateJob(job, { progress: Math.round((done / Math.max(files.length, 1)) * 90), currentFile: file.relativePath });
  })));

  assertNotCancelled(job);
  updateJob(job, { stage: 'creating_report', progress: 92 });
  await writeReport(job);
  updateJob(job, { stage: 'creating_zip', progress: 95 });
  await zipDirectory(job.outputDir, job.outputZip);
  updateJob(job, { status: 'completed', stage: 'completed', progress: 100, currentFile: null }, 'completed');
}

async function writeReport(job) {
  const headers = ['sequence','filename','relative_path','duration_original','original_lufs','original_true_peak','classification','speed','preset','final_lufs','final_true_peak','duration_final','status','error'];
  const rows = job.files.map((f) => [
    f.sequence, f.filename, f.relativePath, f.metadata?.duration, f.original?.inputI, f.original?.inputTp,
    f.classification, job.settings?.speed ?? 1, job.settings?.preset ?? 'original', f.final?.inputI,
    f.final?.inputTp, f.finalMetadata?.duration, f.status, f.error || ''
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
  await fs.writeFile(job.reportPath, csv, 'utf8');
}
