/** 本文件实现局部抖动工具的网格构建、固定步长 XPBD 约束和软体二次运动。 */

/** 软体网格数据。 */
export interface WobbleMesh {
  columns: number;
  rows: number;
  restPositions: Float64Array;
  positions: Float64Array;
  previousPositions: Float64Array;
  velocities: Float64Array;
  uvs: Float32Array;
  indices: Uint32Array;
  weights: Float64Array;
  inverseMasses: Float64Array;
}

/** 重力方向。 */
export type WobbleGravityDirection = 'none' | 'down' | 'up' | 'left' | 'right';

/** 由界面直接控制的软体参数。 */
export interface WobblePhysicsParameters {
  inputStrength: number;
  stretch: number;
  bounce: number;
  damping: number;
  cohesion: number;
  gravityDirection: WobbleGravityDirection;
  gravityStrength: number;
  variation: number;
  maxStretch: number;
}

/** 单次固定步长的外部输入。 */
export interface WobblePhysicsInput {
  frameDragging: boolean;
  frameTarget: Point;
  frameTravelLimit?: number;
}

type Point = { x: number; y: number };
type DistanceConstraint = { a: number; b: number; restLength: number };
type AreaConstraint = { a: number; b: number; c: number; minimumArea: number };
type ShapeCluster = { vertices: Uint32Array; restCenterX: number; restCenterY: number; previousRotation: number };

type Constraints = {
  distances: DistanceConstraint[];
  areas: AreaConstraint[];
  tetherX: Float64Array;
  tetherY: Float64Array;
  distanceLambdas: Float64Array;
  maximumDistanceLambdas: Float64Array;
  areaLambdas: Float64Array;
};

type ResolvedParameters = {
  inputGain: number;
  distanceCompliance: number;
  tetherCompliance: number;
  shapeStrength: number;
  dampingRate: number;
  gravityAcceleration: number;
  gravityTargetDisplacement: number;
  floatingAcceleration: number;
  fluctuationAcceleration: number;
  maximumStretchRatio: number;
  maximumDisplacement: number;
  maximumSpeed: number;
  secondaryMotionStrength: number;
  secondaryFrequency: number;
  secondaryDampingRatio: number;
  secondaryVerticalBias: number;
  secondaryPhaseSpread: number;
  elongationStrength: number;
  tremorStrength: number;
  tremorFrequency: number;
};

const EPSILON = 1e-9;
const FIXED_DELTA_TIME = 1 / 120;
const SOLVER_ITERATIONS = 4;
const MAX_CATCH_UP_STEPS = 4;
const SECONDARY_INPUT_SCALE = 1.6;

/** 按最长边 64 格构建与原图宽高比一致的三角网格，并从遮罩 alpha 采样顶点权重。 */
export function buildWobbleMesh(imageWidth: number, imageHeight: number, mask: ImageData, density = 64): WobbleMesh {
  if (imageWidth <= 0 || imageHeight <= 0) throw new RangeError('图片尺寸必须为正数');
  const columns = imageWidth >= imageHeight ? density : Math.max(4, Math.round(density * imageWidth / imageHeight));
  const rows = imageWidth >= imageHeight ? Math.max(4, Math.round(density * imageHeight / imageWidth)) : density;
  const columnCount = columns + 1;
  const rowCount = rows + 1;
  const vertexCount = columnCount * rowCount;
  const restPositions = new Float64Array(vertexCount * 2);
  const uvs = new Float32Array(vertexCount * 2);
  const weights = new Float64Array(vertexCount);
  const shortSide = Math.min(imageWidth, imageHeight);
  const aspectWidth = imageWidth / shortSide;
  const aspectHeight = imageHeight / shortSide;

  for (let row = 0; row < rowCount; row += 1) {
    const v = row / rows;
    for (let column = 0; column < columnCount; column += 1) {
      const u = column / columns;
      const vertex = row * columnCount + column;
      restPositions[vertex * 2] = (u - 0.5) * aspectWidth;
      restPositions[vertex * 2 + 1] = (v - 0.5) * aspectHeight;
      uvs[vertex * 2] = u;
      uvs[vertex * 2 + 1] = v;
      weights[vertex] = sampleMaskAlpha(mask, u, v);
    }
  }

  const indices = new Uint32Array(columns * rows * 6);
  let index = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = row * columnCount + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columnCount;
      const bottomRight = bottomLeft + 1;
      indices[index++] = topLeft;
      indices[index++] = topRight;
      indices[index++] = bottomRight;
      indices[index++] = topLeft;
      indices[index++] = bottomRight;
      indices[index++] = bottomLeft;
    }
  }

  return {
    columns,
    rows,
    restPositions,
    positions: restPositions.slice(),
    previousPositions: restPositions.slice(),
    velocities: new Float64Array(vertexCount * 2),
    uvs,
    indices,
    weights,
    inverseMasses: Float64Array.from(weights, (weight) => Number(weight > 0)),
  };
}

/** 计算自动运动需要乘入的有效遮罩覆盖权重。 */
export function averageActiveMaskWeight(weights: Float64Array): number {
  let total = 0;
  let count = 0;
  for (const weight of weights) {
    if (weight <= 0) continue;
    total += softenMaskWeight(weight);
    count += 1;
  }
  return count ? total / count : 0;
}

/** 固定随机种子的 XPBD 软体模拟器。 */
export class WobbleSimulator {
  readonly frame = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, acceleration: { x: 0, y: 0 } };
  private readonly constraints: Constraints;
  private readonly clusters: ShapeCluster[];
  private readonly random: SeededRandom;
  private readonly secondaryOffsets: Float64Array;
  private readonly secondaryVelocities: Float64Array;
  private readonly vertexClusterIndices: Int32Array;
  private readonly automaticSpatialFactors: Float64Array;
  private readonly elongationXFactors: Float64Array;
  private readonly elongationYFactors: Float64Array;
  private readonly tetherTargetOffsets: Float64Array;
  private resolved: ResolvedParameters;
  private accumulator = 0;
  private tick = 0;
  private gravityElapsedSeconds = 0;

  /** 创建模拟器；固定种子保证相同输入的颤动轨迹可复现。 */
  constructor(readonly mesh: WobbleMesh, private parameters: WobblePhysicsParameters, private readonly seed = 1347768917) {
    this.resolved = resolveParameters(parameters);
    this.constraints = createConstraints(mesh);
    this.clusters = createShapeClusters(mesh);
    this.random = new SeededRandom(seed);
    this.secondaryOffsets = new Float64Array(mesh.positions.length);
    this.secondaryVelocities = new Float64Array(mesh.positions.length);
    this.vertexClusterIndices = new Int32Array(mesh.weights.length);
    this.vertexClusterIndices.fill(-1);
    this.automaticSpatialFactors = new Float64Array(mesh.weights.length);
    this.elongationXFactors = new Float64Array(mesh.weights.length);
    this.elongationYFactors = new Float64Array(mesh.weights.length);
    this.tetherTargetOffsets = new Float64Array(mesh.positions.length);
    this.initializeSpatialFields();
  }

  /** 热更新参数，不重建网格或清空当前惯性。 */
  setParameters(parameters: WobblePhysicsParameters): void {
    if (parameters.gravityDirection !== this.parameters.gravityDirection) this.gravityElapsedSeconds = 0;
    this.parameters = parameters;
    this.resolved = resolveParameters(parameters);
  }

  /** 按真实经过时间推进固定步长模拟，避免不同刷新率改变效果。 */
  advance(elapsedSeconds: number, input: WobblePhysicsInput): void {
    this.accumulator += Math.min(Math.max(elapsedSeconds, 0), 0.25);
    let steps = 0;
    while (this.accumulator + 1e-12 >= FIXED_DELTA_TIME && steps < MAX_CATCH_UP_STEPS) {
      this.step(input);
      this.accumulator -= FIXED_DELTA_TIME;
      steps += 1;
    }
    if (steps === MAX_CATCH_UP_STEPS && this.accumulator >= FIXED_DELTA_TIME) this.accumulator %= FIXED_DELTA_TIME;
  }

  /** 恢复静止网格，供涂抹态和换图时清除上一段运动。 */
  reset(): void {
    this.mesh.positions.set(this.mesh.restPositions);
    this.mesh.previousPositions.set(this.mesh.restPositions);
    this.mesh.velocities.fill(0);
    this.secondaryOffsets.fill(0);
    this.secondaryVelocities.fill(0);
    this.tetherTargetOffsets.fill(0);
    resetConstraintLambdas(this.constraints);
    Object.assign(this.frame.position, { x: 0, y: 0 });
    Object.assign(this.frame.velocity, { x: 0, y: 0 });
    Object.assign(this.frame.acceleration, { x: 0, y: 0 });
    this.accumulator = 0;
    this.tick = 0;
    this.gravityElapsedSeconds = 0;
    this.random.reset(this.seed);
  }

  private step(input: WobblePhysicsInput): void {
    const deltaTime = FIXED_DELTA_TIME;
    stepFrame(this.frame, input, deltaTime);
    resetConstraintLambdas(this.constraints);
    const gravity = gravityVector(this.parameters.gravityDirection, this.resolved.gravityAcceleration * gravityRamp(this.gravityElapsedSeconds));
    const gravityTarget = gravityVector(this.parameters.gravityDirection, this.resolved.gravityTargetDisplacement);
    const inertialInput = clampVector({
      x: -this.frame.acceleration.x * this.resolved.inputGain,
      y: -this.frame.acceleration.y * this.resolved.inputGain,
    }, 24);
    const primaryShare = 1 - this.resolved.secondaryMotionStrength * 0.52;

    for (let vertex = 0; vertex < this.mesh.weights.length; vertex += 1) {
      const offset = vertex * 2;
      const inverseMass = this.mesh.inverseMasses[vertex] ?? 0;
      this.mesh.previousPositions[offset] = this.mesh.positions[offset] ?? 0;
      this.mesh.previousPositions[offset + 1] = this.mesh.positions[offset + 1] ?? 0;
      if (inverseMass <= 0) {
        this.pinVertex(offset);
        continue;
      }

      const tremorSuppression = (1 - this.resolved.tremorStrength) ** 2;
      const randomX = this.random.nextSigned() * this.resolved.fluctuationAcceleration * tremorSuppression;
      const randomY = this.random.nextSigned() * this.resolved.fluctuationAcceleration * tremorSuppression;
      const floating = this.parameters.gravityDirection === 'none' ? this.floatingAccelerationForVertex(vertex) : { x: 0, y: 0 };
      const elongation = {
        x: inertialInput.x * this.resolved.elongationStrength * 1.8 * (this.elongationXFactors[vertex] ?? 0),
        y: inertialInput.y * this.resolved.elongationStrength * 1.8 * (this.elongationYFactors[vertex] ?? 0),
      };
      const tremorAcceleration = this.tremorAccelerationForVertex(vertex);
      const tremorTarget = this.tremorTargetForVertex(vertex);
      const weight = softenMaskWeight(this.mesh.weights[vertex] ?? 0);
      const elongationTarget = {
        x: inertialInput.x / 24 * this.resolved.elongationStrength * 0.04 * (this.elongationXFactors[vertex] ?? 0) * weight,
        y: inertialInput.y / 24 * this.resolved.elongationStrength * 0.04 * (this.elongationYFactors[vertex] ?? 0) * weight,
      };
      this.tetherTargetOffsets[offset] = tremorTarget.x + elongationTarget.x + gravityTarget.x * weight;
      this.tetherTargetOffsets[offset + 1] = tremorTarget.y + elongationTarget.y + gravityTarget.y * weight;
      const drive = clampVector({
        x: (inertialInput.x + elongation.x + tremorAcceleration.x) * weight,
        y: (inertialInput.y + elongation.y + tremorAcceleration.y) * weight,
      }, 24);
      const secondary = this.stepSecondaryMotion(vertex, drive, deltaTime);
      const accelerationX = (gravity.x + floating.x + randomX) * weight + drive.x * primaryShare + secondary.x;
      const accelerationY = (gravity.y + floating.y + randomY) * weight + drive.y * primaryShare + secondary.y;
      const velocity = clampVector({
        x: (this.mesh.velocities[offset] ?? 0) + accelerationX * inverseMass * deltaTime,
        y: (this.mesh.velocities[offset + 1] ?? 0) + accelerationY * inverseMass * deltaTime,
      }, this.resolved.maximumSpeed);
      this.mesh.velocities[offset] = velocity.x;
      this.mesh.velocities[offset + 1] = velocity.y;
      this.mesh.positions[offset] = (this.mesh.positions[offset] ?? 0) + velocity.x * deltaTime;
      this.mesh.positions[offset + 1] = (this.mesh.positions[offset + 1] ?? 0) + velocity.y * deltaTime;
      this.clampVertexDisplacement(vertex);
    }

    // 约束顺序和迭代次数会直接改变观感，保持 tether→距离→限长→面积→整体形状。
    for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
      solveTether(this.mesh, this.constraints, this.resolved.tetherCompliance, deltaTime, this.tetherTargetOffsets);
      solveDistances(this.mesh, this.constraints, this.resolved.distanceCompliance, deltaTime);
      solveMaximumDistances(this.mesh, this.constraints, this.resolved.maximumStretchRatio, 1e-9, deltaTime);
      solveMinimumAreas(this.mesh, this.constraints, 1e-10, deltaTime);
      solveShapeMatching(this.mesh, this.clusters, this.resolved.shapeStrength);
    }
    solveMaximumDistances(this.mesh, this.constraints, this.resolved.maximumStretchRatio, 0, deltaTime);
    solveMinimumAreas(this.mesh, this.constraints, 0, deltaTime);

    const damping = Math.exp(-this.resolved.dampingRate * deltaTime);
    for (let vertex = 0; vertex < this.mesh.weights.length; vertex += 1) {
      const offset = vertex * 2;
      if ((this.mesh.inverseMasses[vertex] ?? 0) <= 0) {
        this.pinVertex(offset);
        continue;
      }
      this.clampVertexDisplacement(vertex);
      const velocity = clampVector({
        x: ((this.mesh.positions[offset] ?? 0) - (this.mesh.previousPositions[offset] ?? 0)) / deltaTime * damping,
        y: ((this.mesh.positions[offset + 1] ?? 0) - (this.mesh.previousPositions[offset + 1] ?? 0)) / deltaTime * damping,
      }, this.resolved.maximumSpeed);
      this.mesh.velocities[offset] = velocity.x;
      this.mesh.velocities[offset + 1] = velocity.y;
    }
    this.gravityElapsedSeconds += deltaTime;
    this.tick += 1;
  }

  private pinVertex(offset: number): void {
    this.mesh.positions[offset] = this.mesh.restPositions[offset] ?? 0;
    this.mesh.positions[offset + 1] = this.mesh.restPositions[offset + 1] ?? 0;
    this.mesh.velocities[offset] = 0;
    this.mesh.velocities[offset + 1] = 0;
  }

  private clampVertexDisplacement(vertex: number): void {
    const offset = vertex * 2;
    const displacement = clampVector({
      x: (this.mesh.positions[offset] ?? 0) - (this.mesh.restPositions[offset] ?? 0),
      y: (this.mesh.positions[offset + 1] ?? 0) - (this.mesh.restPositions[offset + 1] ?? 0),
    }, this.resolved.maximumDisplacement);
    this.mesh.positions[offset] = (this.mesh.restPositions[offset] ?? 0) + displacement.x;
    this.mesh.positions[offset + 1] = (this.mesh.restPositions[offset + 1] ?? 0) + displacement.y;
  }

  private stepSecondaryMotion(vertex: number, drive: Point, deltaTime: number): Point {
    const offset = vertex * 2;
    const strength = this.resolved.secondaryMotionStrength;
    if (strength <= 0) {
      this.secondaryOffsets[offset] = 0;
      this.secondaryOffsets[offset + 1] = 0;
      this.secondaryVelocities[offset] = 0;
      this.secondaryVelocities[offset + 1] = 0;
      return { x: 0, y: 0 };
    }
    const restX = this.mesh.restPositions[offset] ?? 0;
    const restY = this.mesh.restPositions[offset + 1] ?? 0;
    const spatial = Math.sin(restX * 8.37 + restY * 5.19);
    const frequency = this.resolved.secondaryFrequency * (1 + spatial * this.resolved.secondaryPhaseSpread);
    const angularFrequency = Math.PI * 2 * frequency;
    const damping = 2 * this.resolved.secondaryDampingRatio * angularFrequency;
    const verticalMix = drive.x * spatial * 0.22 * this.resolved.secondaryVerticalBias;
    const targets = [drive.x * 0.045 * (1 - this.resolved.secondaryVerticalBias * 0.45), (drive.y + verticalMix) * 0.06];
    const result = { x: 0, y: 0 };
    for (let axis = 0; axis < 2; axis += 1) {
      const axisOffset = offset + axis;
      const currentOffset = this.secondaryOffsets[axisOffset] ?? 0;
      const currentVelocity = this.secondaryVelocities[axisOffset] ?? 0;
      const acceleration = ((targets[axis] ?? 0) * strength - currentOffset) * angularFrequency ** 2 - currentVelocity * damping;
      const velocity = clamp(currentVelocity + acceleration * deltaTime, -12, 12);
      const nextOffset = clamp(currentOffset + velocity * deltaTime, -1.5, 1.5);
      this.secondaryVelocities[axisOffset] = velocity;
      this.secondaryOffsets[axisOffset] = nextOffset;
      if (axis === 0) result.x = nextOffset * strength * 9;
      else result.y = nextOffset * strength * 9;
    }
    return result;
  }

  private floatingAccelerationForVertex(vertex: number): Point {
    const cluster = this.vertexClusterIndices[vertex] ?? -1;
    if (cluster < 0) return { x: 0, y: 0 };
    const offset = vertex * 2;
    const restX = this.mesh.restPositions[offset] ?? 0;
    const restY = this.mesh.restPositions[offset + 1] ?? 0;
    const time = this.tick * FIXED_DELTA_TIME;
    const phase = this.seed % 65521 / 65521 * Math.PI * 2 + cluster * 2.399963229728653;
    const spatial = restX * 1.7 + restY * 1.13;
    return {
      x: (Math.sin(time * 0.83 + phase) * 0.75 + Math.sin(time * 0.83 + phase + spatial) * 0.25) * this.resolved.floatingAcceleration,
      y: (Math.cos(time * 0.61 + phase * 1.37) * 0.75 + Math.cos(time * 0.61 + phase * 1.37 - spatial * 0.72) * 0.25) * this.resolved.floatingAcceleration * 0.72,
    };
  }

  private tremorAccelerationForVertex(vertex: number): Point {
    const strength = this.resolved.tremorStrength;
    const spatial = this.automaticSpatialFactors[vertex] ?? 0;
    const cluster = this.vertexClusterIndices[vertex] ?? -1;
    if (strength <= 0 || spatial === 0 || cluster < 0) return { x: 0, y: 0 };
    const phase = this.tremorPhase(cluster);
    return { x: Math.sin(phase) * strength * 2 * spatial, y: Math.cos(phase) * strength * 0.7 * spatial };
  }

  private tremorTargetForVertex(vertex: number): Point {
    const strength = this.resolved.tremorStrength;
    const spatial = this.automaticSpatialFactors[vertex] ?? 0;
    const cluster = this.vertexClusterIndices[vertex] ?? -1;
    if (strength <= 0 || spatial === 0 || cluster < 0) return { x: 0, y: 0 };
    const phase = this.tremorPhase(cluster);
    const weight = softenMaskWeight(this.mesh.weights[vertex] ?? 0);
    return { x: Math.sin(phase) * strength * 0.45 * spatial * weight, y: Math.cos(phase) * strength * 0.165 * spatial * weight };
  }

  private tremorPhase(cluster: number): number {
    const time = this.tick * FIXED_DELTA_TIME;
    const offset = cluster * 1.618033988749895 + this.seed % 8191 / 8191 * Math.PI * 2;
    return time * Math.PI * 2 * this.resolved.tremorFrequency + offset;
  }

  private initializeSpatialFields(): void {
    const normalizeField = (cluster: ShapeCluster, target: Float64Array, read: (vertex: number) => number) => {
      let squaredTotal = 0;
      let weightTotal = 0;
      for (const vertex of cluster.vertices) {
        const weight = this.mesh.weights[vertex] ?? 0;
        const value = read(vertex);
        squaredTotal += value * value * weight;
        weightTotal += weight;
      }
      const scale = Math.sqrt(squaredTotal / Math.max(weightTotal, EPSILON));
      if (scale < EPSILON) return;
      for (const vertex of cluster.vertices) target[vertex] = read(vertex) / scale;
    };
    this.clusters.forEach((cluster, clusterIndex) => {
      for (const vertex of cluster.vertices) this.vertexClusterIndices[vertex] = clusterIndex;
      const localX = (vertex: number) => (this.mesh.restPositions[vertex * 2] ?? 0) - cluster.restCenterX;
      const localY = (vertex: number) => (this.mesh.restPositions[vertex * 2 + 1] ?? 0) - cluster.restCenterY;
      normalizeField(cluster, this.automaticSpatialFactors, (vertex) => localX(vertex) + localY(vertex) * 0.63);
      normalizeField(cluster, this.elongationXFactors, localX);
      normalizeField(cluster, this.elongationYFactors, localY);
    });
  }
}

function sampleMaskAlpha(mask: ImageData, u: number, v: number): number {
  const x = clamp(u * (mask.width - 1), 0, mask.width - 1);
  const y = clamp(v * (mask.height - 1), 0, mask.height - 1);
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.min(mask.width - 1, left + 1);
  const bottom = Math.min(mask.height - 1, top + 1);
  const horizontal = x - left;
  const vertical = y - top;
  const alpha = (pixelAlpha(mask, left, top) * (1 - horizontal) + pixelAlpha(mask, right, top) * horizontal) * (1 - vertical)
    + (pixelAlpha(mask, left, bottom) * (1 - horizontal) + pixelAlpha(mask, right, bottom) * horizontal) * vertical;
  return alpha / 255;
}

function pixelAlpha(mask: ImageData, x: number, y: number): number {
  return mask.data[(y * mask.width + x) * 4 + 3] ?? 0;
}

function resolveParameters(parameters: WobblePhysicsParameters): ResolvedParameters {
  const stretch = percent(parameters.stretch);
  const bounce = percent(parameters.bounce);
  const damping = percent(parameters.damping);
  const cohesion = percent(parameters.cohesion);
  const inputStrength = percent(parameters.inputStrength);
  const fluctuation = percent(parameters.variation);
  const maximumStretchRatio = 1.02 + percent(parameters.maxStretch) * 0.98;
  const secondaryMotionStrength = clamp((bounce ** 2 * (1 - damping) * (0.25 + stretch) + (1 - cohesion) ** 4 * (1 - damping) - 0.08) * 2.1, 0, 1);
  const elongationStrength = stretch ** 2 * (1 - cohesion) ** 1.2 * (0.65 + stretch * 1.8) * (1 + bounce * 1.4) * 1.33;
  const tremorStrength = clamp(fluctuation ** 2 * (1 - stretch) * (0.4 + bounce * 0.6) * 20, 0, 1);
  return {
    inputGain: 0.6 + inputStrength * 4.8,
    distanceCompliance: 2e-7 + stretch ** 2 * 9e-4,
    tetherCompliance: 1e-6 + (1 - bounce) ** 2 * 0.0032 + secondaryMotionStrength * 7e-4,
    shapeStrength: 0.01 + cohesion ** 4 * 0.6,
    dampingRate: (0.25 + damping ** 2 * 18) * (0.04 + cohesion ** 3 * 0.96),
    gravityAcceleration: clamp(parameters.gravityStrength, 0, 2) * 0.6,
    gravityTargetDisplacement: clamp(parameters.gravityStrength, 0, 2) * 0.035,
    floatingAcceleration: (3.5 + stretch * 5) * (1 - damping * 0.45),
    fluctuationAcceleration: fluctuation * 0.08,
    maximumStretchRatio,
    maximumDisplacement: 0.16 + stretch * 0.6,
    maximumSpeed: 3.5 + stretch * 7,
    secondaryMotionStrength,
    secondaryFrequency: 1.7 + bounce * 1.1,
    secondaryDampingRatio: 0.025 + damping * 0.18 + cohesion * 0.18,
    secondaryVerticalBias: 0.65 + secondaryMotionStrength * 0.25,
    secondaryPhaseSpread: 0.025 + secondaryMotionStrength * 0.13 + fluctuation * 0.025,
    elongationStrength,
    tremorStrength,
    tremorFrequency: 8 + cohesion * 2 + bounce * 1.5,
  };
}

function createConstraints(mesh: WobbleMesh): Constraints {
  const distances: DistanceConstraint[] = [];
  const areas: AreaConstraint[] = [];
  const columnCount = mesh.columns + 1;
  const addDistance = (a: number, b: number) => {
    if ((mesh.inverseMasses[a] ?? 0) <= 0 && (mesh.inverseMasses[b] ?? 0) <= 0) return;
    distances.push({ a, b, restLength: vertexDistance(mesh.restPositions, a, b) });
  };
  const addArea = (a: number, b: number, c: number) => {
    if ((mesh.inverseMasses[a] ?? 0) <= 0 && (mesh.inverseMasses[b] ?? 0) <= 0 && (mesh.inverseMasses[c] ?? 0) <= 0) return;
    areas.push({ a, b, c, minimumArea: signedArea(mesh.restPositions, a, b, c) * 0.08 });
  };
  for (let row = 0; row <= mesh.rows; row += 1) {
    for (let column = 0; column <= mesh.columns; column += 1) {
      const vertex = row * columnCount + column;
      if (column < mesh.columns) addDistance(vertex, vertex + 1);
      if (row < mesh.rows) addDistance(vertex, vertex + columnCount);
      if (column < mesh.columns && row < mesh.rows) {
        addDistance(vertex, vertex + columnCount + 1);
        addDistance(vertex + 1, vertex + columnCount);
        addArea(vertex, vertex + 1, vertex + columnCount + 1);
        addArea(vertex, vertex + columnCount + 1, vertex + columnCount);
      }
    }
  }
  return {
    distances,
    areas,
    tetherX: new Float64Array(mesh.weights.length),
    tetherY: new Float64Array(mesh.weights.length),
    distanceLambdas: new Float64Array(distances.length),
    maximumDistanceLambdas: new Float64Array(distances.length),
    areaLambdas: new Float64Array(areas.length),
  };
}

function createShapeClusters(mesh: WobbleMesh): ShapeCluster[] {
  const visited = new Uint8Array(mesh.weights.length);
  const clusters: ShapeCluster[] = [];
  const columnCount = mesh.columns + 1;
  const neighbors = (vertex: number) => {
    const row = Math.floor(vertex / columnCount);
    const column = vertex % columnCount;
    const result: number[] = [];
    if (column > 0) result.push(vertex - 1);
    if (column < mesh.columns) result.push(vertex + 1);
    if (row > 0) result.push(vertex - columnCount);
    if (row < mesh.rows) result.push(vertex + columnCount);
    return result;
  };
  for (let start = 0; start < mesh.weights.length; start += 1) {
    if ((visited[start] ?? 0) !== 0 || (mesh.weights[start] ?? 0) <= 0.05) continue;
    const pending = [start];
    const vertices: number[] = [];
    visited[start] = 1;
    while (pending.length) {
      const vertex = pending.pop();
      if (vertex === undefined) break;
      vertices.push(vertex);
      for (const neighbor of neighbors(vertex)) {
        if ((visited[neighbor] ?? 0) !== 0 || (mesh.weights[neighbor] ?? 0) <= 0.05) continue;
        visited[neighbor] = 1;
        pending.push(neighbor);
      }
    }
    let totalWeight = 0;
    let centerX = 0;
    let centerY = 0;
    for (const vertex of vertices) {
      const weight = mesh.weights[vertex] ?? 0;
      totalWeight += weight;
      centerX += (mesh.restPositions[vertex * 2] ?? 0) * weight;
      centerY += (mesh.restPositions[vertex * 2 + 1] ?? 0) * weight;
    }
    clusters.push({ vertices: Uint32Array.from(vertices), restCenterX: centerX / Math.max(totalWeight, EPSILON), restCenterY: centerY / Math.max(totalWeight, EPSILON), previousRotation: 0 });
  }
  return clusters;
}

function solveTether(mesh: WobbleMesh, constraints: Constraints, compliance: number, deltaTime: number, targets: Float64Array): void {
  const alpha = compliance / deltaTime ** 2;
  for (let vertex = 0; vertex < mesh.weights.length; vertex += 1) {
    const inverseMass = mesh.inverseMasses[vertex] ?? 0;
    if (inverseMass <= 0) continue;
    for (let axis = 0; axis < 2; axis += 1) {
      const offset = vertex * 2 + axis;
      const lambdas = axis === 0 ? constraints.tetherX : constraints.tetherY;
      const target = (mesh.restPositions[offset] ?? 0) + (targets[offset] ?? 0);
      const delta = (-((mesh.positions[offset] ?? 0) - target) - alpha * (lambdas[vertex] ?? 0)) / (inverseMass + alpha);
      lambdas[vertex] = (lambdas[vertex] ?? 0) + delta;
      mesh.positions[offset] = (mesh.positions[offset] ?? 0) + inverseMass * delta;
    }
  }
}

function solveDistances(mesh: WobbleMesh, constraints: Constraints, compliance: number, deltaTime: number): void {
  const alpha = compliance / deltaTime ** 2;
  constraints.distances.forEach((constraint, index) => {
    const ax = mesh.positions[constraint.a * 2] ?? 0;
    const ay = mesh.positions[constraint.a * 2 + 1] ?? 0;
    const bx = mesh.positions[constraint.b * 2] ?? 0;
    const by = mesh.positions[constraint.b * 2 + 1] ?? 0;
    const dx = ax - bx;
    const dy = ay - by;
    const distance = Math.hypot(dx, dy);
    if (distance < EPSILON) return;
    const massA = mesh.inverseMasses[constraint.a] ?? 0;
    const massB = mesh.inverseMasses[constraint.b] ?? 0;
    const denominator = massA + massB + alpha;
    if (denominator < EPSILON) return;
    const lambda = constraints.distanceLambdas[index] ?? 0;
    const delta = (-(distance - constraint.restLength) - alpha * lambda) / denominator;
    constraints.distanceLambdas[index] = lambda + delta;
    const normalX = dx / distance;
    const normalY = dy / distance;
    mesh.positions[constraint.a * 2] = ax + massA * normalX * delta;
    mesh.positions[constraint.a * 2 + 1] = ay + massA * normalY * delta;
    mesh.positions[constraint.b * 2] = bx - massB * normalX * delta;
    mesh.positions[constraint.b * 2 + 1] = by - massB * normalY * delta;
  });
}

function solveMaximumDistances(mesh: WobbleMesh, constraints: Constraints, ratio: number, compliance: number, deltaTime: number): void {
  const alpha = compliance / deltaTime ** 2;
  constraints.distances.forEach((constraint, index) => {
    const ax = mesh.positions[constraint.a * 2] ?? 0;
    const ay = mesh.positions[constraint.a * 2 + 1] ?? 0;
    const bx = mesh.positions[constraint.b * 2] ?? 0;
    const by = mesh.positions[constraint.b * 2 + 1] ?? 0;
    const dx = ax - bx;
    const dy = ay - by;
    const distance = Math.hypot(dx, dy);
    if (distance < EPSILON) return;
    const constraintValue = constraint.restLength * ratio - distance;
    const massA = mesh.inverseMasses[constraint.a] ?? 0;
    const massB = mesh.inverseMasses[constraint.b] ?? 0;
    const lambda = constraints.maximumDistanceLambdas[index] ?? 0;
    if (constraintValue >= 0 && lambda <= 0) return;
    const nextLambda = Math.max(0, lambda + (-constraintValue - alpha * lambda) / (massA + massB + alpha));
    const delta = nextLambda - lambda;
    constraints.maximumDistanceLambdas[index] = nextLambda;
    const normalX = -dx / distance;
    const normalY = -dy / distance;
    mesh.positions[constraint.a * 2] = ax + massA * normalX * delta;
    mesh.positions[constraint.a * 2 + 1] = ay + massA * normalY * delta;
    mesh.positions[constraint.b * 2] = bx - massB * normalX * delta;
    mesh.positions[constraint.b * 2 + 1] = by - massB * normalY * delta;
  });
}

function solveMinimumAreas(mesh: WobbleMesh, constraints: Constraints, compliance: number, deltaTime: number): void {
  const alpha = compliance / deltaTime ** 2;
  constraints.areas.forEach((constraint, index) => {
    const ax = mesh.positions[constraint.a * 2] ?? 0;
    const ay = mesh.positions[constraint.a * 2 + 1] ?? 0;
    const bx = mesh.positions[constraint.b * 2] ?? 0;
    const by = mesh.positions[constraint.b * 2 + 1] ?? 0;
    const cx = mesh.positions[constraint.c * 2] ?? 0;
    const cy = mesh.positions[constraint.c * 2 + 1] ?? 0;
    const value = signedAreaFromCoordinates(ax, ay, bx, by, cx, cy) - constraint.minimumArea;
    const lambda = constraints.areaLambdas[index] ?? 0;
    if (value >= 0 && lambda <= 0) return;
    const gradients = [0.5 * (by - cy), 0.5 * (cx - bx), 0.5 * (cy - ay), 0.5 * (ax - cx), 0.5 * (ay - by), 0.5 * (bx - ax)];
    const vertices = [constraint.a, constraint.b, constraint.c];
    const masses = vertices.map((vertex) => mesh.inverseMasses[vertex] ?? 0);
    const denominator = masses.reduce((total, mass, vertex) => total + mass * ((gradients[vertex * 2] ?? 0) ** 2 + (gradients[vertex * 2 + 1] ?? 0) ** 2), alpha);
    if (denominator < EPSILON) return;
    const nextLambda = Math.max(0, lambda + (-value - alpha * lambda) / denominator);
    const delta = nextLambda - lambda;
    constraints.areaLambdas[index] = nextLambda;
    vertices.forEach((vertex, vertexIndex) => {
      const mass = masses[vertexIndex] ?? 0;
      mesh.positions[vertex * 2] = (mesh.positions[vertex * 2] ?? 0) + mass * (gradients[vertexIndex * 2] ?? 0) * delta;
      mesh.positions[vertex * 2 + 1] = (mesh.positions[vertex * 2 + 1] ?? 0) + mass * (gradients[vertexIndex * 2 + 1] ?? 0) * delta;
    });
  });
}

function solveShapeMatching(mesh: WobbleMesh, clusters: ShapeCluster[], strength: number): void {
  for (const cluster of clusters) {
    let totalWeight = 0;
    let centerX = 0;
    let centerY = 0;
    for (const vertex of cluster.vertices) {
      const weight = mesh.weights[vertex] ?? 0;
      totalWeight += weight;
      centerX += (mesh.positions[vertex * 2] ?? 0) * weight;
      centerY += (mesh.positions[vertex * 2 + 1] ?? 0) * weight;
    }
    if (totalWeight < EPSILON) continue;
    centerX /= totalWeight;
    centerY /= totalWeight;
    let covarianceXX = 0;
    let covarianceXY = 0;
    let covarianceYX = 0;
    let covarianceYY = 0;
    for (const vertex of cluster.vertices) {
      const weight = mesh.weights[vertex] ?? 0;
      const currentX = (mesh.positions[vertex * 2] ?? 0) - centerX;
      const currentY = (mesh.positions[vertex * 2 + 1] ?? 0) - centerY;
      const restX = (mesh.restPositions[vertex * 2] ?? 0) - cluster.restCenterX;
      const restY = (mesh.restPositions[vertex * 2 + 1] ?? 0) - cluster.restCenterY;
      covarianceXX += weight * currentX * restX;
      covarianceXY += weight * currentX * restY;
      covarianceYX += weight * currentY * restX;
      covarianceYY += weight * currentY * restY;
    }
    const numerator = covarianceYX - covarianceXY;
    const denominator = covarianceXX + covarianceYY;
    const rotation = Math.abs(numerator) + Math.abs(denominator) > EPSILON ? Math.atan2(numerator, denominator) : cluster.previousRotation;
    cluster.previousRotation = rotation;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    for (const vertex of cluster.vertices) {
      const weight = mesh.weights[vertex] ?? 0;
      const restX = (mesh.restPositions[vertex * 2] ?? 0) - cluster.restCenterX;
      const restY = (mesh.restPositions[vertex * 2 + 1] ?? 0) - cluster.restCenterY;
      const targetX = centerX + cosine * restX - sine * restY;
      const targetY = centerY + sine * restX + cosine * restY;
      const blend = strength * weight;
      mesh.positions[vertex * 2] = (mesh.positions[vertex * 2] ?? 0) + (targetX - (mesh.positions[vertex * 2] ?? 0)) * blend;
      mesh.positions[vertex * 2 + 1] = (mesh.positions[vertex * 2 + 1] ?? 0) + (targetY - (mesh.positions[vertex * 2 + 1] ?? 0)) * blend;
    }
  }
}

function stepFrame(frame: WobbleSimulator['frame'], input: WobblePhysicsInput, deltaTime: number): void {
  const travelLimit = input.frameTravelLimit === undefined ? 0.08 : clamp(input.frameTravelLimit, 0.08, 0.16);
  const target = input.frameDragging ? clampVector(input.frameTarget, travelLimit) : { x: 0, y: 0 };
  if (input.frameDragging) {
    const previousVelocity = { ...frame.velocity };
    const blend = 1 - Math.exp(-(travelLimit > 0.08 ? 35 : 70) * deltaTime);
    const nextPosition = { x: frame.position.x + (target.x - frame.position.x) * blend, y: frame.position.y + (target.y - frame.position.y) * blend };
    frame.velocity = clampVector({ x: (nextPosition.x - frame.position.x) / deltaTime, y: (nextPosition.y - frame.position.y) / deltaTime }, 3);
    frame.acceleration = clampVector({ x: (frame.velocity.x - previousVelocity.x) / deltaTime, y: (frame.velocity.y - previousVelocity.y) / deltaTime }, 55);
    frame.position = clampVector(nextPosition, travelLimit);
    return;
  }
  frame.acceleration = clampVector({ x: -frame.position.x * 68 - frame.velocity.x * 8.5, y: -frame.position.y * 68 - frame.velocity.y * 8.5 }, 22);
  frame.velocity.x += frame.acceleration.x * deltaTime;
  frame.velocity.y += frame.acceleration.y * deltaTime;
  frame.velocity = clampVector(frame.velocity, 1.8);
  frame.position.x += frame.velocity.x * deltaTime;
  frame.position.y += frame.velocity.y * deltaTime;
  const positionLimit = Math.hypot(frame.position.x, frame.position.y) > 0.080000001 ? 0.16 : 0.08;
  const limitedPosition = clampVector(frame.position, positionLimit);
  if (limitedPosition.x === frame.position.x && limitedPosition.y === frame.position.y) return;
  const outwardVelocity = frame.velocity.x * limitedPosition.x + frame.velocity.y * limitedPosition.y;
  if (outwardVelocity > 0) {
    const squaredLength = limitedPosition.x ** 2 + limitedPosition.y ** 2;
    if (squaredLength > 0) {
      frame.velocity.x -= outwardVelocity / squaredLength * limitedPosition.x;
      frame.velocity.y -= outwardVelocity / squaredLength * limitedPosition.y;
    }
  }
  frame.position = limitedPosition;
}

function gravityVector(direction: WobbleGravityDirection, strength: number): Point {
  if (direction === 'down') return { x: 0, y: strength };
  if (direction === 'up') return { x: 0, y: -strength };
  if (direction === 'left') return { x: -strength, y: 0 };
  if (direction === 'right') return { x: strength, y: 0 };
  return { x: 0, y: 0 };
}

function gravityRamp(elapsedSeconds: number): number {
  return 1 + 22 * Math.exp(-Math.max(0, elapsedSeconds) * 5);
}

function softenMaskWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  if (weight >= 0.8) return Math.min(1, weight);
  const normalized = weight / 0.8;
  return weight * (0.35 + 0.65 * (normalized ** 2 * (3 - 2 * normalized)));
}

function resetConstraintLambdas(constraints: Constraints): void {
  constraints.tetherX.fill(0);
  constraints.tetherY.fill(0);
  constraints.distanceLambdas.fill(0);
  constraints.maximumDistanceLambdas.fill(0);
  constraints.areaLambdas.fill(0);
}

function signedArea(positions: Float64Array, a: number, b: number, c: number): number {
  return signedAreaFromCoordinates(positions[a * 2] ?? 0, positions[a * 2 + 1] ?? 0, positions[b * 2] ?? 0, positions[b * 2 + 1] ?? 0, positions[c * 2] ?? 0, positions[c * 2 + 1] ?? 0);
}

function signedAreaFromCoordinates(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return 0.5 * ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

function vertexDistance(positions: Float64Array, a: number, b: number): number {
  return Math.hypot((positions[a * 2] ?? 0) - (positions[b * 2] ?? 0), (positions[a * 2 + 1] ?? 0) - (positions[b * 2 + 1] ?? 0));
}

function clampVector(point: Point, maximumLength: number): Point {
  const length = Math.hypot(point.x, point.y);
  if (length <= maximumLength || length < EPSILON) return point;
  const scale = maximumLength / length;
  return { x: point.x * scale, y: point.y * scale };
}

function percent(value: number): number { return clamp(value, 0, 100) / 100; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  nextSigned(): number { return this.next() * 2 - 1; }
  reset(seed: number): void { this.state = seed >>> 0; }
  private next(): number {
    this.state = (this.state + 1831565813) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
}
