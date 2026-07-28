/** 本文件负责从 MP4 首个可解码视频帧生成轻量 WebP 封面，图库无需预加载视频文件。 */
import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import sharp from 'sharp';

const POSTER_TIMEOUT_MS = 20_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

/** 视频首帧封面生成结果。 */
export type VideoPosterResult = {
  /** 已缩放和压缩的 WebP 封面。 */
  buffer: Buffer;
  /** 封面的真实 MIME。 */
  mimeType: 'image/webp';
  /** 封面像素宽度。 */
  width: number;
  /** 封面像素高度。 */
  height: number;
};

/** 使用随应用安装的 FFmpeg 解码首帧，再由 Sharp 统一输出轻量 WebP。 */
export class VideoPosterService {
  /** 从完整 MP4 字节生成首帧封面，不写文件。 */
  async generate(videoBuffer: Buffer): Promise<VideoPosterResult> {
    if (videoBuffer.length < 12 || videoBuffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
      throw new Error('视频首帧提取收到的 MP4 内容不正确');
    }
    const frame = await extractFirstFrame(videoBuffer);
    const output = await sharp(frame, { failOn: 'error', limitInputPixels: 100_000_000 })
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (!output.info.width || !output.info.height || output.data.length <= 0) {
      throw new Error('视频首帧封面生成结果为空');
    }
    return {
      buffer: output.data,
      mimeType: 'image/webp',
      width: output.info.width,
      height: output.info.height,
    };
  }
}

/** 调用 FFmpeg 从时间零点读取首个视频帧，并限制执行时间和内存输出。 */
async function extractFirstFrame(videoBuffer: Buffer): Promise<Buffer> {
  const ffmpegPath = ffmpegInstaller.path;
  if (!ffmpegPath) throw new Error('FFmpeg 可执行文件未安装');
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-map', '0:v:0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, frame?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(frame ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('视频首帧提取超时'));
    }, POSTER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_FRAME_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('视频首帧解码结果过大'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const currentBytes = errorChunks.reduce((sum, item) => sum + item.length, 0);
      if (currentBytes < MAX_ERROR_BYTES) errorChunks.push(chunk.subarray(0, MAX_ERROR_BYTES - currentBytes));
    });
    child.on('error', (error) => finish(new Error(`视频首帧提取启动失败：${error.message}`)));
    child.on('close', (code) => {
      const frame = Buffer.concat(chunks);
      if (code === 0 && frame.length > 0) return finish(undefined, frame);
      const detail = Buffer.concat(errorChunks).toString('utf8').trim().slice(0, 500);
      finish(new Error(detail ? `视频首帧提取失败：${detail}` : `视频首帧提取失败：退出码 ${code ?? -1}`));
    });
    // FFmpeg 提前结束输入时会触发 EPIPE；最终成功与否统一由 close 和输出帧判断。
    child.stdin.on('error', () => undefined);
    child.stdin.end(videoBuffer);
  });
}
