import { describe, expect, it } from 'vitest';
import { productDistanceMatrix, activeDimensions, distanceGradient, productDistance, productStep, projectEmbedding, squaredProductDistance, validateKeywordVector } from '../src/embedding/geometry.js';
import type { KeywordVector, ProductGeometry } from '../src/types.js';

const geometry: ProductGeometry = { hyperbolicDimensions: 4, euclideanDimensions: 4 };
const vector = (embedding: number[]): KeywordVector => ({ keywordId: 'x', geometry, embedding, x: 0, y: 0, updatedAt: 1 });

describe('product geometry', () => {
  it('uses the configured active dimensions and rejects malformed coordinates', () => {
    expect(activeDimensions(geometry)).toBe(8);
    expect(() => activeDimensions({ hyperbolicDimensions: 1, euclideanDimensions: 4 })).toThrow();
    expect(() => activeDimensions({ hyperbolicDimensions: 4, euclideanDimensions: 1.5 })).toThrow();
    expect(() => validateKeywordVector(vector(Array(8).fill(0)))).not.toThrow();
    expect(() => validateKeywordVector(vector(Array(9).fill(0)))).toThrow();
    expect(() => validateKeywordVector(vector([NaN, ...Array(7).fill(0)]))).toThrow();
  });

  it('matches both coordinate gradients to central finite differences', () => {
    for (const scale of [0.001, 0.3, 3]) {
      const a = Array.from({ length: 8 }, (_, k) => scale * Math.sin(k + 1));
      const b = Array.from({ length: 8 }, (_, k) => scale * Math.cos(2 * k + 1));
      const gradients = distanceGradient(a, b, geometry);
      for (let side = 0; side < 2; side++) for (let k = 0; k < 8; k++) {
        const plus = [a.slice(), b.slice()], minus = [a.slice(), b.slice()];
        const epsilon = 1e-5;
        plus[side]![k]! += epsilon;
        minus[side]![k]! -= epsilon;
        const numerical = (squaredProductDistance(plus[0]!, plus[1]!, geometry) - squaredProductDistance(minus[0]!, minus[1]!, geometry)) / (2 * epsilon);
        expect(gradients[side]![k]).toBeCloseTo(numerical, 6);
      }
    }
  });

  it('agrees with analytic radial hyperbolic distances and Euclidean factors', () => {
    const origin = Array(8).fill(0);
    for (const radius of [0.01, 0.5, 2, 4]) {
      const radial = [Math.sinh(radius), 0, 0, 0, 3, 4, 0, 0];
      expect(squaredProductDistance(origin, radial, geometry)).toBeCloseTo((radius ** 2 + 25) / 2, 10);
      const opposite = [-Math.sinh(radius), 0, 0, 0, 3, 4, 0, 0];
      expect(squaredProductDistance(radial, opposite, geometry)).toBeCloseTo(2 * radius ** 2, 10);
    }
  });

  it('obeys identity, symmetry, and triangle inequality on independent points', () => {
    const points = Array.from({ length: 24 }, (_, i) => vector(Array.from({ length: 8 }, (_, k) => 2 * Math.sin((i + 1) * (k + 0.7)))));
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 7) % points.length]!, c = points[(i + 13) % points.length]!;
      expect(productDistance(a, a)).toBeLessThan(1e-6);
      expect(productDistance(a, b)).toBeCloseTo(productDistance(b, a), 12);
      expect(productDistance(a, c)).toBeLessThanOrEqual(productDistance(a, b) + productDistance(b, c) + 1e-10);
    }
    expect(() => productDistance(points[0]!, { ...points[1]!, geometry: { hyperbolicDimensions: 2, euclideanDimensions: 6 } })).toThrow();
  });

  it('takes a finite descent step and projects inside the Poincare disk', () => {
    const a = [0.5, -0.3, 0.2, 0.1, 0.6, -0.2, 0.1, 0.2];
    const b = [-0.3, 0.2, 0.6, 0.4, 0.1, 0.4, -0.1, -0.2];
    const [gradient] = distanceGradient(a, b, geometry);
    const next = productStep(a, gradient, 0.01, geometry);
    expect(next.every(Number.isFinite)).toBe(true);
    expect(squaredProductDistance(next, b, geometry)).toBeLessThan(squaredProductDistance(a, b, geometry));
    expect(Math.hypot(...projectEmbedding(next, geometry))).toBeLessThan(1);
    expect(productStep(a, Array(8).fill(0), 1, geometry)).toEqual(a);
  });
});


it('cached symmetric matrix agrees with pair distances across active geometries', () => {
  for (const dimensions of [2, 4, 8]) {
    const vectors = Array.from({ length: 17 }, (_, index) => ({
      keywordId: String(index),
      geometry: { hyperbolicDimensions: dimensions, euclideanDimensions: dimensions },
      embedding: Array.from({ length: dimensions * 2 }, (_, coordinate) => Math.sin(index * 7 + coordinate) / 4),
      x: 0, y: 0, updatedAt: 0,
    }));
    const matrix = productDistanceMatrix(vectors);
    for (let left = 0; left < vectors.length; left++) {
      expect(matrix[left]![left]).toBe(0);
      for (let right = left + 1; right < vectors.length; right++) {
        expect(matrix[left]![right]).toBe(productDistance(vectors[left]!, vectors[right]!));
        expect(matrix[right]![left]).toBe(matrix[left]![right]);
      }
    }
  }
});
