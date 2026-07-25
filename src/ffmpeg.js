import { spawn } from 'node:child_process';

export function runCommand(command, args, { signal, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; onStderr?.(String(d)); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${command} exited with code ${code}: ${stderr.slice(-4000)}`), { code, stderr }));
    });
  });
}

export async function probeAudio(input, options = {}) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration,size,bit_rate:stream=index,codec_name,codec_type,sample_rate,channels,bit_rate',
    '-of', 'json', input
  ], options);
  const data = JSON.parse(stdout);
  const stream = data.streams?.find((s) => s.codec_type === 'audio') || {};
  return {
    duration: Number(data.format?.duration || 0),
    size: Number(data.format?.size || 0),
    bitrate: Number(stream.bit_rate || data.format?.bit_rate || 0),
    codec: stream.codec_name || 'unknown',
    sampleRate: Number(stream.sample_rate || 0),
    channels: Number(stream.channels || 0)
  };
}

function parseLoudnormJson(stderr) {
  const matches = [...stderr.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)];
  if (!matches.length) throw new Error('Could not parse FFmpeg loudness analysis');
  const raw = JSON.parse(matches.at(-1)[0]);
  const num = (v) => Number.parseFloat(v);
  return {
    inputI: num(raw.input_i), inputTp: num(raw.input_tp), inputLra: num(raw.input_lra),
    inputThresh: num(raw.input_thresh), outputI: num(raw.output_i), outputTp: num(raw.output_tp),
    outputLra: num(raw.output_lra), outputThresh: num(raw.output_thresh),
    targetOffset: num(raw.target_offset), normalizationType: raw.normalization_type
  };
}

export async function analyzeLoudness(input, targets = {}, options = {}) {
  const I = Number(targets.targetLufs ?? -16);
  const LRA = Number(targets.lra ?? 7);
  const TP = Number(targets.truePeak ?? -1.5);
  const { stderr } = await runCommand('ffmpeg', [
    '-hide_banner', '-nostdin', '-i', input,
    '-af', `loudnorm=I=${I}:LRA=${LRA}:TP=${TP}:print_format=json`,
    '-f', 'null', '-'
  ], options);
  return parseLoudnormJson(stderr);
}

export function classifyLoudness(lufs, truePeak) {
  if (!Number.isFinite(lufs)) return 'unable_to_analyze';
  if (truePeak > -0.1) return 'clipping_risk';
  if (lufs < -24) return 'very_quiet';
  if (lufs < -19) return 'quiet';
  if (lufs <= -14) return 'normal';
  if (lufs <= -10) return 'loud';
  return 'very_loud';
}
