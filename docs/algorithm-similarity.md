# Similarity Supervision Algorithm

This document describes the current similarity engine used by Labby.

## Goal

Maintain a dynamic metric space for up to large active sets while supporting fast updates:

- insert and delete nodes
- pair pull/push updates
- triplet preference updates
- incremental 2D projection for UI

We represent points in a 64D Euclidean latent space so metric properties are preserved by geometry.

## Mathematical and Informatics Principles

- Metric axioms we rely on: non-negativity/identity, symmetry, triangle inequality.
- Instead of storing an explicit N x N distance matrix, we store N x 64 coordinates.
- In Euclidean space, distance validity is structural, so we avoid global triangle-check passes after each local update.
- Update rules are local SGD-style steps, so per-update write cost stays O(1) with respect to N (only touched nodes are mutated).

## Scope

In scope:

- 64D embedding lifecycle and supervision updates
- stability controls after local updates
- 64D to 2D incremental projection and calibration

Out of scope:

- scheduling optimization logic in packages/core/src/solver.ts

## Runtime Path

64D engine (packages/core/native/src/engine.rs):

- lifecycle: hydrate, insert, delete, flush dirty nodes
- supervision: pair and triplet updates (single and batch)
- stability: anchor preservation, optional rigid compensation, touched-node finalize

2D projector (packages/core/native/src/autoencoder.rs):

- lifecycle: hydrate, upsert/remove, incremental dirty apply
- training: full + incremental linear autoencoder training
- quality path: replay sampling, rank consistency step, calibration refresh

FFI and consumers:

- export bridge: packages/core/native/src/lib.rs
- server consumer: packages/server/src/lib/embedding-service.ts
- web consumer: packages/web/src/lib/embedding-engine.ts

## Update Logic (Simple View)

1. Apply local gradient update on affected nodes in 64D.
2. Apply anchor-preservation correction around touched nodes.
3. Measure local drift on touched nodes.
4. If drift is high enough, run global rigid compensation using sampled control points.
5. Finalize touched nodes: norm rebalance, ANN refresh, adaptive global normalization checks.
6. On flush through FFI runtime, feed dirty 64D nodes into projector and emit (id, 64D, 2D).

Triplet loss form:

$$
L = \max(0, \|x_a - x_b\|_2^2 - \|x_a - x_c\|_2^2 + m)
$$

Pair loss form:

$$
L = (\|x_a - x_b\|_2 - t)^2
$$

Note:

- Triplet step includes a small smooth-hinge tail near the satisfied boundary to reduce abrupt "only one side moves" behavior.

## Stability and Quality Gates

64D drift gates:

- soft budget: 0.06
- hard budget: 0.12
- heavy compensation trigger: local drift >= 0.045

Adaptive global checks:

- drift refresh threshold: 0.06
- stable threshold for relaxing check cadence: 0.015

2D projection gates:

- rank margin: 0.02
- rank loss weight: 0.12
- sampled quantile cap: 512
- calibration smoothing alpha: 0.18

Required tests:

- native Rust tests in packages/core/native pass
- rank sanity: d2(anchor, near) < d2(anchor, far)
- post-update max calibrated radius < 3.2

## Notes

- This document is intentionally concise and implementation-oriented.
- Scheduling details are documented separately in docs/algorithm-scheduling.md.
