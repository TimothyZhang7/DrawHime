/** 本文件补充 gifenc 公开编码接口的 TypeScript 类型，声明内容与 1.0.3 实际实现一致。 */
declare module 'gifenc' {
  /** GIF 调色板中的 RGB 颜色。 */
  export type GifPaletteColor = [number, number, number];

  /** GIF 编码器实例。 */
  export interface GifEncoderInstance {
    /** 写入一帧索引图。 */
    writeFrame(index: Uint8Array, width: number, height: number, options: { palette: GifPaletteColor[]; delay?: number; repeat?: number }): void;
    /** 写入 GIF 结束标记。 */
    finish(): void;
    /** 返回当前完整编码字节。 */
    bytes(): Uint8Array;
  }

  /** 创建 GIF 编码器。 */
  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GifEncoderInstance;
  /** 将 RGBA 像素量化为最多指定数量的 RGB 颜色。 */
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: 'rgb565' | 'rgb444' }): GifPaletteColor[];
  /** 将 RGBA 像素映射为指定调色板索引。 */
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: GifPaletteColor[], format?: 'rgb565' | 'rgb444'): Uint8Array;
}
