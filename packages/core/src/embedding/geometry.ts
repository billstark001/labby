import type { KeywordVector, ProductGeometry } from '../types.js';

export const DEFAULT_GEOMETRY: Readonly<ProductGeometry> = Object.freeze({
  hyperbolicDimensions: 8,
  euclideanDimensions: 8,
});

const MAX_STEP_LENGTH = 0.25;
const MAX_HYPERBOLIC_RADIUS = Math.sinh(4);
const MAX_EUCLIDEAN_COORDINATE = 8;

export function activeDimensions(geometry: ProductGeometry): number {
  const { hyperbolicDimensions, euclideanDimensions } = geometry;
  if (
    !Number.isInteger(hyperbolicDimensions) ||
    hyperbolicDimensions < 2 ||
    !Number.isInteger(euclideanDimensions) ||
    euclideanDimensions < 1 ||
    hyperbolicDimensions + euclideanDimensions > 64
  ) {
    throw new Error('Invalid product geometry');
  }
  return hyperbolicDimensions + euclideanDimensions;
}

export function sameGeometry(a: ProductGeometry, b: ProductGeometry): boolean {
  return (
    a.hyperbolicDimensions === b.hyperbolicDimensions &&
    a.euclideanDimensions === b.euclideanDimensions
  );
}

export function validateKeywordVector(vector: KeywordVector): void {
  const dimensions = activeDimensions(vector.geometry);
  if (
    !vector.keywordId ||
    !Array.isArray(vector.embedding) ||
    vector.embedding.length !== dimensions ||
    !vector.embedding.every(Number.isFinite) ||
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(vector.updatedAt)
  ) {
    throw new Error('Invalid keyword embedding');
  }
  if (Math.hypot(...vector.embedding) > 1e4) throw new Error('Embedding exceeds numerical radius');
}

/** Curvature -1: the implicit Lorentz time coordinate is sqrt(1 + spatial norm²). */
export function squaredProductDistance(
  a: readonly number[],
  b: readonly number[],
  geometry: ProductGeometry,
): number {
  const dimensions = geometry.hyperbolicDimensions;
  let normA = 1;
  let normB = 1;
  let dot = 0;
  let euclideanSquared = 0;
  for (let coordinate = 0; coordinate < dimensions; coordinate++) {
    normA += a[coordinate]! ** 2;
    normB += b[coordinate]! ** 2;
    dot += a[coordinate]! * b[coordinate]!;
  }
  // Rounding can put the Lorentz inner product slightly below acosh's domain.
  const innerProduct = Math.max(1, Math.sqrt(normA * normB) - dot);
  const hyperbolicDistance = Math.acosh(innerProduct);
  for (let coordinate = dimensions; coordinate < a.length; coordinate++) {
    euclideanSquared += (a[coordinate]! - b[coordinate]!) ** 2;
  }
  return (hyperbolicDistance ** 2 + euclideanSquared) / 2;
}

export function productDistance(a: KeywordVector, b: KeywordVector): number {
  if (!sameGeometry(a.geometry, b.geometry))
    throw new Error('Cannot compare different product geometries');
  return Math.sqrt(squaredProductDistance(a.embedding, b.embedding, a.geometry));
}

/** Coordinate derivatives of squaredProductDistance, one gradient per endpoint. */
export function distanceGradient(
  a: readonly number[],
  b: readonly number[],
  geometry: ProductGeometry,
): [number[], number[]] {
  const dimensions = geometry.hyperbolicDimensions;
  let normA = 1;
  let normB = 1;
  let dot = 0;
  for (let coordinate = 0; coordinate < dimensions; coordinate++) {
    normA += a[coordinate]! ** 2;
    normB += b[coordinate]! ** 2;
    dot += a[coordinate]! * b[coordinate]!;
  }
  const timeA = Math.sqrt(normA);
  const timeB = Math.sqrt(normB);
  const innerProduct = Math.max(1, timeA * timeB - dot);
  // acosh(s) / sqrt(s² - 1) tends to 1 as s tends to 1.
  const factor =
    innerProduct - 1 < 1e-8 ? 1 : Math.acosh(innerProduct) / Math.sqrt(innerProduct ** 2 - 1);
  const gradientA = new Array<number>(a.length);
  const gradientB = new Array<number>(a.length);
  for (let coordinate = 0; coordinate < a.length; coordinate++) {
    if (coordinate < dimensions) {
      gradientA[coordinate] = factor * ((timeB / timeA) * a[coordinate]! - b[coordinate]!);
      gradientB[coordinate] = factor * ((timeA / timeB) * b[coordinate]! - a[coordinate]!);
    } else {
      gradientA[coordinate] = a[coordinate]! - b[coordinate]!;
      gradientB[coordinate] = b[coordinate]! - a[coordinate]!;
    }
  }
  return [gradientA, gradientB];
}

/** Convert the coordinate gradient to a tangent vector, then apply the exponential map. */
export function productStep(
  position: readonly number[],
  gradient: readonly number[],
  rate: number,
  geometry: ProductGeometry,
): number[] {
  const dimensions = geometry.hyperbolicDimensions;
  let positionGradientDot = 0;
  let norm = 1;
  for (let coordinate = 0; coordinate < dimensions; coordinate++) {
    positionGradientDot += position[coordinate]! * gradient[coordinate]!;
    norm += position[coordinate]! ** 2;
  }
  const time = Math.sqrt(norm);
  const tangent = new Array<number>(dimensions);
  let timeTangent = 0;
  let spatialSquared = 0;
  for (let coordinate = 0; coordinate < dimensions; coordinate++) {
    // Inverse induced metric: I + x xᵀ.
    const component = -rate * (gradient[coordinate]! + position[coordinate]! * positionGradientDot);
    tangent[coordinate] = component;
    timeTangent += (position[coordinate]! * component) / time;
    spatialSquared += component ** 2;
  }
  const length = Math.sqrt(Math.max(0, spatialSquared - timeTangent ** 2));
  const limitedLength = Math.min(length, MAX_STEP_LENGTH);
  const scale = length > 1e-12 ? Math.sinh(limitedLength) / length : 1;
  const radialScale = Math.cosh(limitedLength);
  const result = new Array<number>(position.length);
  let radiusSquared = 0;
  for (let coordinate = 0; coordinate < dimensions; coordinate++) {
    const value = radialScale * position[coordinate]! + scale * tangent[coordinate]!;
    result[coordinate] = value;
    radiusSquared += value ** 2;
  }
  const radius = Math.sqrt(radiusSquared);
  if (radius > MAX_HYPERBOLIC_RADIUS) {
    const contraction = MAX_HYPERBOLIC_RADIUS / radius;
    for (let coordinate = 0; coordinate < dimensions; coordinate++)
      result[coordinate] *= contraction;
  }
  for (let coordinate = dimensions; coordinate < result.length; coordinate++) {
    const step = Math.max(
      -MAX_STEP_LENGTH,
      Math.min(MAX_STEP_LENGTH, rate * gradient[coordinate]!),
    );
    result[coordinate] = Math.max(
      -MAX_EUCLIDEAN_COORDINATE,
      Math.min(MAX_EUCLIDEAN_COORDINATE, position[coordinate]! - step),
    );
  }
  return result;
}

/** First two Poincaré coordinates are for display only, never for ranking. */
export function projectEmbedding(
  position: readonly number[],
  geometry: ProductGeometry,
): [number, number] {
  let norm = 1;
  for (let coordinate = 0; coordinate < geometry.hyperbolicDimensions; coordinate++) {
    norm += position[coordinate]! ** 2;
  }
  const denominator = Math.sqrt(norm) + 1;
  return [position[0]! / denominator, position[1]! / denominator];
}

/**
 * Symmetric distance matrix. Validate geometry once and reuse Lorentz squared
 * norms; each unordered pair is evaluated only once.
 */
export function productDistanceMatrix(vectors: readonly KeywordVector[]): Float64Array[] {
  const count = vectors.length;
  const matrix = Array.from({ length: count }, () => new Float64Array(count));
  if (!count) return matrix;
  const geometry = vectors[0]!.geometry;
  const hyperbolicDimensions = geometry.hyperbolicDimensions;
  const squaredNorms = vectors.map((vector) => {
    if (!sameGeometry(vector.geometry, geometry))
      throw new Error('Cannot compare different product geometries');
    let norm = 1;
    for (let coordinate = 0; coordinate < hyperbolicDimensions; coordinate++) {
      norm += vector.embedding[coordinate]! ** 2;
    }
    return norm;
  });
  for (let left = 0; left < count; left++) {
    const a = vectors[left]!.embedding;
    for (let right = left + 1; right < count; right++) {
      const b = vectors[right]!.embedding;
      let dot = 0;
      let euclideanSquared = 0;
      for (let coordinate = 0; coordinate < hyperbolicDimensions; coordinate++) {
        dot += a[coordinate]! * b[coordinate]!;
      }
      for (let coordinate = hyperbolicDimensions; coordinate < a.length; coordinate++) {
        euclideanSquared += (a[coordinate]! - b[coordinate]!) ** 2;
      }
      const hyperbolicDistance = Math.acosh(
        Math.max(1, Math.sqrt(squaredNorms[left]! * squaredNorms[right]!) - dot),
      );
      const distance = Math.sqrt((hyperbolicDistance ** 2 + euclideanSquared) / 2);
      matrix[left]![right] = distance;
      matrix[right]![left] = distance;
    }
  }
  return matrix;
}
