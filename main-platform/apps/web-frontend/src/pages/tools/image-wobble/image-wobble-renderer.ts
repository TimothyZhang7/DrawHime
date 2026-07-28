/** 本文件连接软体物理与 WebGL2 网格渲染，并实现与原版一致的手动和自动运动轨迹。 */
import {
  averageActiveMaskWeight,
  buildWobbleMesh,
  WobbleSimulator,
  type WobbleMesh,
  type WobblePhysicsParameters,
} from './image-wobble-physics';

/** 自动运动类型。 */
export type WobbleAutoMotion = 'none' | 'sway' | 'hop' | 'orbit';

/** 页面每帧传入的完整渲染参数。 */
export interface WobbleRenderParameters extends WobblePhysicsParameters {
  motionX: number;
  motionY: number;
  dragging: boolean;
  active: boolean;
  autoMotion: WobbleAutoMotion;
  autoIntensity: number;
  periodMs: number;
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
uniform vec2 u_scale;
uniform vec2 u_translation;
uniform float u_content_scale;
out vec2 v_uv;
void main() {
  vec2 clip = (a_position * u_content_scale + u_translation) * u_scale;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_image;
uniform vec2 u_blur_radius_uv;
uniform float u_blur_mix;
uniform float u_gradient_mix;
uniform vec4 u_edge_top;
uniform vec4 u_edge_right;
uniform vec4 u_edge_bottom;
uniform vec4 u_edge_left;
in vec2 v_uv;
out vec4 out_color;
vec2 nearest_edge_uv(vec2 uv) {
  float nearest = uv.x;
  vec2 result = vec2(0.002, uv.y);
  if (1.0 - uv.x < nearest) { nearest = 1.0 - uv.x; result = vec2(0.998, uv.y); }
  if (uv.y < nearest) { nearest = uv.y; result = vec2(uv.x, 0.002); }
  if (1.0 - uv.y < nearest) { result = vec2(uv.x, 0.998); }
  return clamp(result, vec2(0.002), vec2(0.998));
}
vec2 nearest_edge_tangent(vec2 uv) {
  float horizontal_edge = min(uv.x, 1.0 - uv.x);
  float vertical_edge = min(uv.y, 1.0 - uv.y);
  return horizontal_edge < vertical_edge ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
}
void main() {
  float backdrop = max(u_blur_mix, u_gradient_mix);
  vec2 sample_uv = mix(v_uv, nearest_edge_uv(v_uv), backdrop);
  vec2 blur_offset = nearest_edge_tangent(v_uv) * u_blur_radius_uv;
  vec4 sharp = texture(u_image, sample_uv);
  vec4 blurred = sharp * 0.24;
  blurred += texture(u_image, sample_uv + blur_offset) * 0.10;
  blurred += texture(u_image, sample_uv - blur_offset) * 0.10;
  blurred += texture(u_image, sample_uv + blur_offset * 0.72) * 0.12;
  blurred += texture(u_image, sample_uv - blur_offset * 0.72) * 0.12;
  blurred += texture(u_image, sample_uv + blur_offset * 0.38) * 0.16;
  blurred += texture(u_image, sample_uv - blur_offset * 0.38) * 0.16;
  vec4 horizontal = mix(u_edge_left, u_edge_right, smoothstep(0.0, 1.0, v_uv.x));
  vec4 vertical = mix(u_edge_top, u_edge_bottom, smoothstep(0.0, 1.0, v_uv.y));
  vec4 edge_gradient = mix(horizontal, vertical, 0.5);
  vec3 bright_blur = mix(blurred.rgb, vec3(1.0), 0.36);
  vec4 hybrid = mix(edge_gradient, vec4(bright_blur, 1.0), 0.80);
  out_color = mix(sharp, hybrid, backdrop);
}`;

/** WebGL2 软体网格渲染器；图片、遮罩和录制数据始终只存在于浏览器。 */
export class WobbleRenderer {
  private readonly scene: MeshSceneRenderer;
  private simulator: WobbleSimulator | null = null;
  private mesh: WobbleMesh | null = null;
  private imageSource: HTMLCanvasElement | null = null;
  private averageMaskWeight = 0;
  private previousTime: number | null = null;
  private automaticElapsed = 0;
  private wasActive = false;
  private parametersKey = '';

  /** 初始化 WebGL2；不支持时抛出明确错误。 */
  constructor(private readonly canvas: HTMLCanvasElement) {
    this.scene = new MeshSceneRenderer(canvas);
  }

  /** 上传图片并同步预览画布尺寸，最长边由解码阶段限制为 960。 */
  loadImage(image: ImageBitmap, width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const context = source.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法创建图片工作画布');
    context.drawImage(image, 0, 0, width, height);
    this.imageSource = source;
    this.scene.setImage(source);
  }

  /** 从当前遮罩重建顶点权重；真实形变发生在网格顶点而不是纹理采样偏移。 */
  updateMask(maskCanvas: HTMLCanvasElement): void {
    if (!this.imageSource) return;
    const context = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法读取抖动区域遮罩');
    const mask = context.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    this.mesh = buildWobbleMesh(this.imageSource.width, this.imageSource.height, mask, 64);
    this.averageMaskWeight = averageActiveMaskWeight(this.mesh.weights);
    this.simulator = new WobbleSimulator(this.mesh, defaultPhysicsParameters());
    this.scene.setMesh(this.mesh);
    this.parametersKey = '';
    this.previousTime = null;
    this.automaticElapsed = 0;
    this.wasActive = false;
  }

  /** 推进固定步长物理并绘制当前帧。 */
  render(timeSeconds: number, parameters: WobbleRenderParameters): void {
    if (!this.simulator || !this.mesh) return;
    const elapsed = this.previousTime === null ? 0 : clamp(timeSeconds - this.previousTime, 0, 0.05);
    this.previousTime = timeSeconds;
    const physicsParameters = pickPhysicsParameters(parameters);
    const parametersKey = JSON.stringify(physicsParameters);
    if (parametersKey !== this.parametersKey) {
      this.simulator.setParameters(physicsParameters);
      this.parametersKey = parametersKey;
    }

    if (!parameters.active) {
      if (this.wasActive) this.simulator.reset();
      this.wasActive = false;
      this.scene.render({ x: 0, y: 0 });
      return;
    }

    this.wasActive = true;
    if (!parameters.dragging) this.automaticElapsed += elapsed;
    const automaticAmplitude = mapAutomaticIntensity(parameters.autoIntensity);
    const automaticEnabled = parameters.autoMotion !== 'none' && automaticAmplitude > 0 && !parameters.dragging;
    const automaticVector = automaticEnabled
      ? calculateAutomaticMotion(parameters.autoMotion, this.automaticElapsed, automaticAmplitude, parameters.periodMs / 1000)
      : { x: 0, y: 0 };
    const input = parameters.dragging
      ? { frameDragging: true, frameTarget: { x: parameters.motionX, y: parameters.motionY } }
      : automaticEnabled
        ? {
            frameDragging: true,
            frameTarget: { x: automaticVector.x * 0.16 * this.averageMaskWeight, y: automaticVector.y * 0.16 * this.averageMaskWeight },
            frameTravelLimit: 0.16,
          }
        : { frameDragging: false, frameTarget: { x: 0, y: 0 } };
    this.simulator.advance(elapsed, input);
    this.scene.render(this.simulator.frame.position);
  }

  /** 释放 GPU 资源。 */
  dispose(): void {
    this.scene.dispose();
    this.simulator = null;
    this.mesh = null;
    this.imageSource = null;
  }
}

type RenderUniforms = {
  scale: WebGLUniformLocation;
  translation: WebGLUniformLocation;
  contentScale: WebGLUniformLocation;
  blurRadius: WebGLUniformLocation;
  blurMix: WebGLUniformLocation;
  gradientMix: WebGLUniformLocation;
  edgeColors: WebGLUniformLocation[];
};

class MeshSceneRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly positionBuffer: WebGLBuffer;
  private readonly uvBuffer: WebGLBuffer;
  private readonly indexBuffer: WebGLBuffer;
  private readonly texture: WebGLTexture;
  private readonly uniforms: RenderUniforms;
  private mesh: WobbleMesh | null = null;
  private positionScratch: Float32Array | null = null;
  private edgeColors: number[][] = [[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2，无法运行局部抖动工具');
    this.gl = gl;
    this.program = createProgram(gl);
    const vertexArray = gl.createVertexArray();
    const positionBuffer = gl.createBuffer();
    const uvBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!vertexArray || !positionBuffer || !uvBuffer || !indexBuffer || !texture) throw new Error('无法创建 WebGL2 网格资源');
    this.vertexArray = vertexArray;
    this.positionBuffer = positionBuffer;
    this.uvBuffer = uvBuffer;
    this.indexBuffer = indexBuffer;
    this.texture = texture;
    this.uniforms = {
      scale: requireUniform(gl, this.program, 'u_scale'),
      translation: requireUniform(gl, this.program, 'u_translation'),
      contentScale: requireUniform(gl, this.program, 'u_content_scale'),
      blurRadius: requireUniform(gl, this.program, 'u_blur_radius_uv'),
      blurMix: requireUniform(gl, this.program, 'u_blur_mix'),
      gradientMix: requireUniform(gl, this.program, 'u_gradient_mix'),
      edgeColors: ['u_edge_top', 'u_edge_right', 'u_edge_bottom', 'u_edge_left'].map((name) => requireUniform(gl, this.program, name)),
    };
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);
  }

  setMesh(mesh: WobbleMesh): void {
    this.mesh = mesh;
    this.positionScratch = new Float32Array(mesh.positions.length);
    const gl = this.gl;
    gl.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positionScratch.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  setImage(source: HTMLCanvasElement): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.edgeColors = extractEdgeColors(source);
  }

  render(frameOffset: { x: number; y: number }): void {
    if (!this.mesh || !this.positionScratch) return;
    const gl = this.gl;
    const shortSide = Math.min(this.canvas.width, this.canvas.height);
    const aspectWidth = this.canvas.width / shortSide;
    const aspectHeight = this.canvas.height / shortSide;
    const scaleX = 2 / aspectWidth;
    const scaleY = 2 / aspectHeight;
    const overscan = 1 + 2 * (0.16 * 0.5 + 52 / Math.max(1, shortSide));
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.uniform2f(this.uniforms.scale, scaleX, scaleY);
    gl.uniform2f(this.uniforms.blurRadius, 52 / (Math.max(1, this.canvas.width) * overscan), 52 / (Math.max(1, this.canvas.height) * overscan));
    this.edgeColors.forEach((color, index) => gl.uniform4f(this.uniforms.edgeColors[index]!, color[0] ?? 1, color[1] ?? 1, color[2] ?? 1, color[3] ?? 1));

    // 第一遍用静止网格绘制边缘模糊背景，避免大幅形变时露出空白。
    copyPositions(this.mesh.restPositions, this.positionScratch);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.positionScratch);
    gl.uniform1f(this.uniforms.contentScale, overscan);
    gl.uniform1f(this.uniforms.blurMix, 1);
    gl.uniform1f(this.uniforms.gradientMix, 1);
    gl.uniform2f(this.uniforms.translation, frameOffset.x * 0.5, frameOffset.y * 0.5);
    gl.drawElements(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_INT, 0);

    // 第二遍上传当前物理顶点并绘制清晰前景。
    copyPositions(this.mesh.positions, this.positionScratch);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.positionScratch);
    gl.uniform1f(this.uniforms.contentScale, 1);
    gl.uniform1f(this.uniforms.blurMix, 0);
    gl.uniform1f(this.uniforms.gradientMix, 0);
    gl.uniform2f(this.uniforms.translation, frameOffset.x, frameOffset.y);
    gl.drawElements(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteBuffer(this.uvBuffer);
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteProgram(this.program);
  }

}

/** 把 0-100 自动强度映射为原版的非线性振幅。 */
export function mapAutomaticIntensity(value: number): number {
  const points = [[0, 0], [25, 0.3], [50, 0.6], [80, 0.84], [100, 1]] as const;
  const normalized = clamp(value, 0, 100);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (normalized > current[0]) continue;
    const ratio = (normalized - previous[0]) / (current[0] - previous[0]);
    return previous[1] + (current[1] - previous[1]) * ratio;
  }
  return 1;
}

function calculateAutomaticMotion(mode: WobbleAutoMotion, elapsed: number, amplitude: number, periodSeconds: number): { x: number; y: number } {
  const period = clamp(periodSeconds, 0.2, 1.8);
  const phase = elapsed / period * Math.PI * 2;
  if (mode === 'hop') return { x: Math.sin(phase) * (seededUnit(1347768917, 0) - 0.5) * 0.025 * amplitude, y: calculateHop(elapsed, period) * amplitude };
  if (mode === 'orbit') {
    const angle = phase + Math.sin(phase) * 0.22;
    const radius = amplitude * (0.89 + Math.sin(phase * 0.5) * 0.11);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }
  if (mode === 'sway') return { x: -Math.tanh(Math.cos(phase) * 2.2) / Math.tanh(2.2) * amplitude, y: 0 };
  return { x: 0, y: 0 };
}

function calculateHop(elapsed: number, period: number): number {
  const base = { period: 0.625, takeoffEnd: 0.14 / 1.6, hangEnd: 0.24 / 1.6, fallEnd: 0.48 / 1.6, compressionEnd: 0.56 / 1.6, firstRecoilEnd: 0.66 / 1.6, secondRecoilEnd: 0.74 / 1.6, settleEnd: 0.84 / 1.6 };
  const normalizedPeriod = clamp(period, 0.2, 1.8);
  let timing = base;
  if (normalizedPeriod < 0.5) {
    const ratio = normalizedPeriod / 0.5;
    const reference = calculateHopTiming(0.5, base);
    timing = { period: normalizedPeriod, takeoffEnd: reference.takeoffEnd * ratio, hangEnd: reference.hangEnd * ratio, fallEnd: reference.fallEnd * ratio, compressionEnd: reference.compressionEnd * ratio, firstRecoilEnd: reference.firstRecoilEnd * ratio, secondRecoilEnd: reference.secondRecoilEnd * ratio, settleEnd: reference.settleEnd * ratio };
  } else timing = calculateHopTiming(normalizedPeriod, base);
  const time = ((elapsed % timing.period) + timing.period) % timing.period;
  const fallVelocity = 6 * 1.6 * (timing.period < 0.5 ? 0.5 / timing.period : 1);
  if (time < timing.takeoffEnd) {
    const ratio = time / timing.takeoffEnd;
    return -(ratio ** 3 * (ratio * (ratio * 6 - 15) + 10));
  }
  if (time < timing.hangEnd) {
    const ratio = (time - timing.takeoffEnd) / (timing.hangEnd - timing.takeoffEnd);
    return -1 + (1 - Math.cos(ratio * Math.PI)) * 0.04;
  }
  if (time < timing.fallEnd) return hermite(time, timing.hangEnd, timing.fallEnd, -0.92, 0, 0, fallVelocity);
  if (time < timing.compressionEnd) return hermite(time, timing.fallEnd, timing.compressionEnd, 0, 0.22, fallVelocity, 0);
  if (time < timing.firstRecoilEnd) return hermite(time, timing.compressionEnd, timing.firstRecoilEnd, 0.22, -0.065, 0, 0);
  if (time < timing.secondRecoilEnd) return hermite(time, timing.firstRecoilEnd, timing.secondRecoilEnd, -0.065, 0.035, 0, 0);
  if (time < timing.settleEnd) return hermite(time, timing.secondRecoilEnd, timing.settleEnd, 0.035, 0, 0, 0);
  return 0;
}

function calculateHopTiming(period: number, base: ReturnType<typeof baseHopTiming>) {
  const extension = period - base.period;
  const shift = extension >= 0 ? extension * 0.25 : Math.min(0, extension + (base.period - base.settleEnd));
  return { period, takeoffEnd: base.takeoffEnd, hangEnd: base.hangEnd + shift, fallEnd: base.fallEnd + shift, compressionEnd: base.compressionEnd + shift, firstRecoilEnd: base.firstRecoilEnd + shift, secondRecoilEnd: base.secondRecoilEnd + shift, settleEnd: base.settleEnd + shift };
}

function baseHopTiming() { return { period: 0.625, takeoffEnd: 0.14 / 1.6, hangEnd: 0.24 / 1.6, fallEnd: 0.48 / 1.6, compressionEnd: 0.56 / 1.6, firstRecoilEnd: 0.66 / 1.6, secondRecoilEnd: 0.74 / 1.6, settleEnd: 0.84 / 1.6 }; }

function hermite(value: number, start: number, end: number, startValue: number, endValue: number, startSlope: number, endSlope: number): number {
  const duration = end - start;
  const ratio = (value - start) / duration;
  const squared = ratio * ratio;
  const cubed = squared * ratio;
  return (2 * cubed - 3 * squared + 1) * startValue + (cubed - 2 * squared + ratio) * duration * startSlope + (-2 * cubed + 3 * squared) * endValue + (cubed - squared) * duration * endSlope;
}

function seededUnit(seed: number, index: number): number {
  let value = (seed ^ Math.imul(index + 1, 2654435761)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 2146121005);
  value ^= value >>> 15;
  value = Math.imul(value, 2221713035);
  value ^= value >>> 16;
  return value / 4294967295;
}

function pickPhysicsParameters(parameters: WobbleRenderParameters): WobblePhysicsParameters {
  return {
    inputStrength: parameters.inputStrength,
    stretch: parameters.stretch,
    bounce: parameters.bounce,
    damping: parameters.damping,
    cohesion: parameters.cohesion,
    gravityDirection: parameters.gravityDirection,
    gravityStrength: parameters.gravityStrength,
    variation: parameters.variation,
    maxStretch: parameters.maxStretch,
  };
}

function defaultPhysicsParameters(): WobblePhysicsParameters {
  return { inputStrength: 82, stretch: 90, bounce: 28, damping: 8, cohesion: 8, gravityDirection: 'down', gravityStrength: 1, variation: 5, maxStretch: 100 };
}

function extractEdgeColors(source: HTMLCanvasElement): number[][] {
  const sample = document.createElement('canvas');
  sample.width = 32;
  sample.height = 32;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) return [[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]];
  context.drawImage(source, 0, 0, 32, 32);
  const image = context.getImageData(0, 0, 32, 32);
  const thickness = 3;
  const areas = [{ x0: 0, y0: 0, x1: 32, y1: thickness }, { x0: 32 - thickness, y0: 0, x1: 32, y1: 32 }, { x0: 0, y0: 32 - thickness, x1: 32, y1: 32 }, { x0: 0, y0: 0, x1: thickness, y1: 32 }];
  return areas.map((area) => {
    const channels: number[][] = [[], [], []];
    for (let y = area.y0; y < area.y1; y += 1) {
      for (let x = area.x0; x < area.x1; x += 1) {
        const offset = (y * image.width + x) * 4;
        if ((image.data[offset + 3] ?? 0) < 16) continue;
        channels[0]!.push(image.data[offset] ?? 255);
        channels[1]!.push(image.data[offset + 1] ?? 255);
        channels[2]!.push(image.data[offset + 2] ?? 255);
      }
    }
    return [median(channels[0]!) / 255, median(channels[1]!) / 255, median(channels[2]!) / 255, 1];
  });
}

function median(values: number[]): number {
  if (!values.length) return 255;
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] ?? 255 : ((values[middle - 1] ?? 255) + (values[middle] ?? 255)) / 2;
}

function copyPositions(source: Float64Array, target: Float32Array): void {
  for (let index = 0; index < source.length; index += 1) target[index] = source[index] ?? 0;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 WebGL2 程序');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || '未知链接错误';
    gl.deleteProgram(program);
    throw new Error(`WebGL2 程序链接失败：${message}`);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 WebGL2 着色器');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || '未知着色器错误';
    gl.deleteShader(shader);
    throw new Error(`WebGL2 着色器编译失败：${message}`);
  }
  return shader;
}

function requireUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`WebGL2 uniform 不存在：${name}`);
  return location;
}

function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
