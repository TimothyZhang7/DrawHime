/** 本文件在独立线程中逐帧量化并编码 GIF，避免阻塞软体预览动画。 */
import { GIFEncoder, applyPalette, quantize } from 'gifenc';

type GifWorkerRequest =
  | { type: 'init'; width: number; height: number; delayMs: number }
  | { type: 'frame'; pixels: ArrayBuffer }
  | { type: 'finish' };

type GifWorkerResponse =
  | { type: 'progress'; encodedFrames: number }
  | { type: 'done'; bytes: ArrayBuffer }
  | { type: 'error'; message: string };

type GifWorkerScope = {
  onmessage: ((event: MessageEvent<GifWorkerRequest>) => void) | null;
  postMessage(message: GifWorkerResponse, transfer?: Transferable[]): void;
};

const workerScope = globalThis as unknown as GifWorkerScope;
let encoder: ReturnType<typeof GIFEncoder> | null = null;
let width = 0;
let height = 0;
let delayMs = 0;
let encodedFrames = 0;

workerScope.onmessage = (event) => {
  try {
    if (event.data.type === 'init') {
      width = event.data.width;
      height = event.data.height;
      delayMs = event.data.delayMs;
      encodedFrames = 0;
      encoder = GIFEncoder();
      return;
    }
    if (!encoder || width < 1 || height < 1) throw new Error('GIF 编码器尚未初始化');
    if (event.data.type === 'frame') {
      const pixels = new Uint8ClampedArray(event.data.pixels);
      const palette = quantize(pixels, 256, { format: 'rgb565' });
      const indexed = applyPalette(pixels, palette, 'rgb565');
      encoder.writeFrame(indexed, width, height, { palette, delay: delayMs, repeat: 0 });
      encodedFrames += 1;
      workerScope.postMessage({ type: 'progress', encodedFrames });
      return;
    }
    encoder.finish();
    const bytes = encoder.bytes();
    const transferable = Uint8Array.from(bytes).buffer;
    workerScope.postMessage({ type: 'done', bytes: transferable }, [transferable]);
  } catch (reason) {
    workerScope.postMessage({ type: 'error', message: reason instanceof Error ? reason.message : 'GIF 编码失败' });
  }
};
