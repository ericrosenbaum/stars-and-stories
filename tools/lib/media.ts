import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import sharp from 'sharp';

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d.toString();
    });
    proc.on('error', (e) =>
      reject(new Error(`Failed to launch ffmpeg (is it installed? \`brew install ffmpeg\`): ${e.message}`)),
    );
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`)),
    );
  });
}

/** Re-encode to mono low-bitrate AAC (.m4a). Intelligibility over fidelity. */
export async function optimizeAudio(src: string, dest: string, bitrate = '40k'): Promise<void> {
  await runFfmpeg([
    '-y',
    '-i', src,
    '-vn',
    '-ac', '1',
    '-c:a', 'aac',
    '-b:a', bitrate,
    '-movflags', '+faststart',
    dest,
  ]);
}

/** Convert a PNG header to a width-capped WebP. */
export async function optimizeImage(
  src: string,
  dest: string,
  width = 1280,
  quality = 72,
): Promise<void> {
  await sharp(src).resize({ width, withoutEnlargement: true }).webp({ quality }).toFile(dest);
}

export function sha256File(file: string): string {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function ffprobe(src: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', src],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}
