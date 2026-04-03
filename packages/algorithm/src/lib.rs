/**
 * Labby Algorithm Engine – Rust core.
 *
 * Implements a dynamic high-dimensional (64-D) embedding space with:
 *  - Triplet-loss SGD updates (O(d) per update, O(1) in N)
 *  - Pair push/pull updates
 *  - Exact k-NN search (O(N·d))
 *  - Separate 2-D projection maintained by the same triplet loss
 *  - Dirty-flag tracking for incremental persistence
 *
 * Compiled to both:
 *  - WebAssembly via wasm-bindgen  (`--features wasm`)
 *  - Native Node.js addon via napi-rs (`--features node`)
 */

#![allow(clippy::needless_range_loop)]

/// Latent-space dimensionality.
pub const DIMS: usize = 64;

const MARGIN: f32 = 0.2;
const DEFAULT_LR: f32 = 0.05;

// ---------------------------------------------------------------------------
// Core engine (no FFI dependencies)
// ---------------------------------------------------------------------------

/// Embedding engine that owns:
///   - an `N × DIMS` matrix of 32-bit floats (64-D latent coordinates)
///   - an `N × 2` matrix for the 2-D visualization projection
///   - a dirty-flag set tracking which rows were modified since last flush
pub struct EmbeddingEngineCore {
    pub n: usize,
    /// Row-major: row `i` starts at `i * DIMS`.
    pub embeddings: Vec<f32>,
    /// Row-major: row `i` starts at `i * 2`.
    pub positions2d: Vec<f32>,
    /// Indices of rows modified since the last `flush_dirty` call.
    pub dirty: Vec<bool>,
    /// Simple LCG state for deterministic-enough random init.
    rng: u64,
}

impl EmbeddingEngineCore {
    /// Create a new engine for `n` nodes.  All embeddings are initialised to
    /// random unit vectors and all 2-D positions to random points in [-1, 1]².
    pub fn new(n: usize) -> Self {
        let mut engine = EmbeddingEngineCore {
            n,
            embeddings: vec![0.0f32; n * DIMS],
            positions2d: vec![0.0f32; n * 2],
            dirty: vec![false; n],
            rng: 0x_dead_beef_cafe_babe,
        };
        for i in 0..n {
            engine.rand_init_embedding(i);
            engine.rand_init_position2d(i);
        }
        engine
    }

    // ------------------------------------------------------------------
    // RNG helpers
    // ------------------------------------------------------------------

    fn next_rng(&mut self) -> u64 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        self.rng
    }

    fn rand_f32(&mut self) -> f32 {
        // Map to (-1, 1)
        let v = (self.next_rng() & 0xFFFF_FFFF) as f32;
        v / 0x1_0000_0000_u64 as f32 * 2.0 - 1.0
    }

    fn rand_init_embedding(&mut self, i: usize) {
        let base = i * DIMS;
        let mut norm_sq = 0.0f32;
        for k in 0..DIMS {
            let v = self.rand_f32();
            self.embeddings[base + k] = v;
            norm_sq += v * v;
        }
        let norm = norm_sq.sqrt().max(1e-8);
        for k in 0..DIMS {
            self.embeddings[base + k] /= norm;
        }
    }

    fn rand_init_position2d(&mut self, i: usize) {
        self.positions2d[i * 2] = self.rand_f32();
        self.positions2d[i * 2 + 1] = self.rand_f32();
    }

    // ------------------------------------------------------------------
    // Distance helpers
    // ------------------------------------------------------------------

    /// Squared L2 distance between the 64-D embeddings of nodes `i` and `j`.
    fn sq_dist64(&self, i: usize, j: usize) -> f32 {
        let ai = &self.embeddings[i * DIMS..(i + 1) * DIMS];
        let bj = &self.embeddings[j * DIMS..(j + 1) * DIMS];
        ai.iter()
            .zip(bj.iter())
            .fold(0.0f32, |acc, (a, b)| acc + (a - b) * (a - b))
    }

    /// L2 distance between the 64-D embeddings of nodes `i` and `j`.
    fn dist64(&self, i: usize, j: usize) -> f32 {
        self.sq_dist64(i, j).sqrt()
    }

    /// L2 distance between the 2-D positions of nodes `i` and `j`.
    fn dist2d(&self, i: usize, j: usize) -> f32 {
        let xi = self.positions2d[i * 2];
        let yi = self.positions2d[i * 2 + 1];
        let xj = self.positions2d[j * 2];
        let yj = self.positions2d[j * 2 + 1];
        ((xi - xj) * (xi - xj) + (yi - yj) * (yi - yj)).sqrt()
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /// Overwrite the 64-D embedding of node `idx` with `data`.
    pub fn set_embedding(&mut self, idx: usize, data: &[f32]) {
        assert!(idx < self.n, "index out of range");
        assert_eq!(data.len(), DIMS, "data must have exactly DIMS elements");
        self.embeddings[idx * DIMS..(idx + 1) * DIMS].copy_from_slice(data);
        self.dirty[idx] = true;
    }

    /// Overwrite the 2-D position of node `idx`.
    pub fn set_position2d(&mut self, idx: usize, x: f32, y: f32) {
        assert!(idx < self.n, "index out of range");
        self.positions2d[idx * 2] = x;
        self.positions2d[idx * 2 + 1] = y;
        self.dirty[idx] = true;
    }

    /// Return a copy of the 64-D embedding of node `idx`.
    pub fn get_embedding(&self, idx: usize) -> Vec<f32> {
        self.embeddings[idx * DIMS..(idx + 1) * DIMS].to_vec()
    }

    /// Return the 2-D position of node `idx` as `(x, y)`.
    pub fn get_position2d(&self, idx: usize) -> (f32, f32) {
        (self.positions2d[idx * 2], self.positions2d[idx * 2 + 1])
    }

    /// Return the entire 2-D position array as a flat slice (length `2 * n`).
    pub fn all_positions2d(&self) -> &[f32] {
        &self.positions2d
    }

    /// Similarity between nodes `i` and `j` in 64-D space, mapped to (0, 1].
    pub fn similarity(&self, i: usize, j: usize) -> f32 {
        let d = self.dist64(i, j);
        1.0 / (1.0 + d)
    }

    /// Apply one triplet-loss gradient step to nodes `anchor`, `pos`, `neg`.
    ///
    /// Both the 64-D embeddings and the 2-D positions are updated using the
    /// same triplet-loss objective so the visualisation stays consistent.
    pub fn update_triplet(&mut self, anchor: usize, pos: usize, neg: usize, lr: f32) {
        self.update_triplet_64d(anchor, pos, neg, lr);
        self.update_triplet_2d(anchor, pos, neg, lr);
        self.dirty[anchor] = true;
        self.dirty[pos] = true;
        self.dirty[neg] = true;
    }

    fn update_triplet_64d(&mut self, anchor: usize, pos: usize, neg: usize, lr: f32) {
        let d_pos = self.dist64(anchor, pos);
        let d_neg = self.dist64(anchor, neg);
        let loss = (d_pos - d_neg + MARGIN).max(0.0);
        if loss == 0.0 {
            return;
        }
        if d_pos > 1e-8 {
            for k in 0..DIMS {
                let ga = self.embeddings[anchor * DIMS + k];
                let gp = self.embeddings[pos * DIMS + k];
                let grad = lr * (ga - gp) / d_pos;
                self.embeddings[anchor * DIMS + k] -= grad;
                self.embeddings[pos * DIMS + k] += grad;
            }
        }
        if d_neg > 1e-8 {
            let d_neg_new = self.dist64(anchor, neg);
            if d_neg_new > 1e-8 {
                for k in 0..DIMS {
                    let ga = self.embeddings[anchor * DIMS + k];
                    let gn = self.embeddings[neg * DIMS + k];
                    let grad = lr * (ga - gn) / d_neg_new;
                    self.embeddings[anchor * DIMS + k] += grad;
                    self.embeddings[neg * DIMS + k] -= grad;
                }
            }
        }
    }

    fn update_triplet_2d(&mut self, anchor: usize, pos: usize, neg: usize, lr: f32) {
        let d_pos = self.dist2d(anchor, pos);
        let d_neg = self.dist2d(anchor, neg);
        let loss = (d_pos - d_neg + MARGIN).max(0.0);
        if loss == 0.0 {
            return;
        }
        if d_pos > 1e-8 {
            let ax = self.positions2d[anchor * 2];
            let ay = self.positions2d[anchor * 2 + 1];
            let px = self.positions2d[pos * 2];
            let py = self.positions2d[pos * 2 + 1];
            let gx = lr * (ax - px) / d_pos;
            let gy = lr * (ay - py) / d_pos;
            self.positions2d[anchor * 2] -= gx;
            self.positions2d[anchor * 2 + 1] -= gy;
            self.positions2d[pos * 2] += gx;
            self.positions2d[pos * 2 + 1] += gy;
        }
        let d_neg2 = self.dist2d(anchor, neg);
        if d_neg2 > 1e-8 {
            let ax = self.positions2d[anchor * 2];
            let ay = self.positions2d[anchor * 2 + 1];
            let nx = self.positions2d[neg * 2];
            let ny = self.positions2d[neg * 2 + 1];
            let gx = lr * (ax - nx) / d_neg2;
            let gy = lr * (ay - ny) / d_neg2;
            self.positions2d[anchor * 2] += gx;
            self.positions2d[anchor * 2 + 1] += gy;
            self.positions2d[neg * 2] -= gx;
            self.positions2d[neg * 2 + 1] -= gy;
        }
    }

    /// Move all nodes in `indices` toward each other (attract) in both 64-D and 2-D.
    pub fn attract(&mut self, indices: &[usize], strength: f32) {
        self.adjust_group(indices, strength);
    }

    /// Move all nodes in `indices` away from each other (repel) in both 64-D and 2-D.
    pub fn repel(&mut self, indices: &[usize], strength: f32) {
        self.adjust_group(indices, -strength);
    }

    fn adjust_group(&mut self, indices: &[usize], signed_strength: f32) {
        for ii in 0..indices.len() {
            for jj in (ii + 1)..indices.len() {
                let i = indices[ii];
                let j = indices[jj];

                // 64-D
                for k in 0..DIMS {
                    let dx = self.embeddings[j * DIMS + k] - self.embeddings[i * DIMS + k];
                    self.embeddings[i * DIMS + k] += dx * signed_strength;
                    self.embeddings[j * DIMS + k] -= dx * signed_strength;
                }

                // 2-D
                let dx2 = self.positions2d[j * 2] - self.positions2d[i * 2];
                let dy2 = self.positions2d[j * 2 + 1] - self.positions2d[i * 2 + 1];
                self.positions2d[i * 2] += dx2 * signed_strength;
                self.positions2d[i * 2 + 1] += dy2 * signed_strength;
                self.positions2d[j * 2] -= dx2 * signed_strength;
                self.positions2d[j * 2 + 1] -= dy2 * signed_strength;

                self.dirty[i] = true;
                self.dirty[j] = true;
            }
        }
    }

    /// Return the indices of the `k` nearest neighbours of node `idx` in 64-D space
    /// (sorted ascending by distance, excluding `idx` itself).  O(N · d).
    pub fn k_nearest(&self, idx: usize, k: usize) -> Vec<usize> {
        let mut dists: Vec<(f32, usize)> = (0..self.n)
            .filter(|&i| i != idx)
            .map(|i| (self.sq_dist64(idx, i), i))
            .collect();
        dists.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        dists.iter().take(k).map(|(_, i)| *i).collect()
    }

    /// Return (indices, embeddings64, positions2d) for all dirty nodes then
    /// clear all dirty flags.
    pub fn flush_dirty(&mut self) -> (Vec<usize>, Vec<f32>, Vec<f32>) {
        let dirty_indices: Vec<usize> = (0..self.n).filter(|&i| self.dirty[i]).collect();
        let mut emb64 = Vec::with_capacity(dirty_indices.len() * DIMS);
        let mut pos2d = Vec::with_capacity(dirty_indices.len() * 2);
        for &i in &dirty_indices {
            emb64.extend_from_slice(&self.embeddings[i * DIMS..(i + 1) * DIMS]);
            pos2d.extend_from_slice(&self.positions2d[i * 2..i * 2 + 2]);
            self.dirty[i] = false;
        }
        (dirty_indices, emb64, pos2d)
    }
}

// ---------------------------------------------------------------------------
// WebAssembly bindings (feature = "wasm")
// ---------------------------------------------------------------------------

#[cfg(feature = "wasm")]
mod wasm_bindings {
    use super::*;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct EmbeddingEngine {
        inner: EmbeddingEngineCore,
    }

    #[wasm_bindgen]
    impl EmbeddingEngine {
        /// Create a new engine for `n` nodes.
        #[wasm_bindgen(constructor)]
        pub fn new(n: u32) -> EmbeddingEngine {
            EmbeddingEngine {
                inner: EmbeddingEngineCore::new(n as usize),
            }
        }

        /// Total number of nodes.
        #[wasm_bindgen(getter)]
        pub fn size(&self) -> u32 {
            self.inner.n as u32
        }

        /// Set the 64-D embedding for node `idx` from a `Float32Array`.
        pub fn set_embedding(&mut self, idx: u32, data: &[f32]) {
            self.inner.set_embedding(idx as usize, data);
        }

        /// Set the 2-D position for node `idx`.
        pub fn set_position2d(&mut self, idx: u32, x: f32, y: f32) {
            self.inner.set_position2d(idx as usize, x, y);
        }

        /// Get the 64-D embedding for node `idx` as a `Float32Array`.
        pub fn get_embedding(&self, idx: u32) -> Vec<f32> {
            self.inner.get_embedding(idx as usize)
        }

        /// Get the 2-D position for node `idx` as `[x, y]`.
        pub fn get_position2d(&self, idx: u32) -> Vec<f32> {
            let (x, y) = self.inner.get_position2d(idx as usize);
            vec![x, y]
        }

        /// Get all 2-D positions as a flat `Float32Array` of length `2 * n`.
        pub fn get_all_positions2d(&self) -> Vec<f32> {
            self.inner.all_positions2d().to_vec()
        }

        /// Similarity ∈ (0, 1] between nodes `i` and `j`.
        pub fn similarity(&self, i: u32, j: u32) -> f32 {
            self.inner.similarity(i as usize, j as usize)
        }

        /// Apply one triplet-loss gradient step.  Both 64-D and 2-D are updated.
        pub fn update_triplet(&mut self, anchor: u32, pos: u32, neg: u32, lr: f32) {
            self.inner.update_triplet(anchor as usize, pos as usize, neg as usize, lr);
        }

        /// Attract all nodes in `indices` toward each other.
        pub fn attract(&mut self, indices: &[u32], strength: f32) {
            let idx: Vec<usize> = indices.iter().map(|&i| i as usize).collect();
            self.inner.attract(&idx, strength);
        }

        /// Repel all nodes in `indices` away from each other.
        pub fn repel(&mut self, indices: &[u32], strength: f32) {
            let idx: Vec<usize> = indices.iter().map(|&i| i as usize).collect();
            self.inner.repel(&idx, strength);
        }

        /// Return the `k` nearest neighbours of node `idx` as a `Uint32Array`.
        pub fn k_nearest(&self, idx: u32, k: u32) -> Vec<u32> {
            self.inner
                .k_nearest(idx as usize, k as usize)
                .iter()
                .map(|&i| i as u32)
                .collect()
        }

        /// Return dirty node data and clear dirty flags.
        /// Returns a flat array: [n_dirty, idx0, idx1, ..., emb64_flat..., pos2d_flat...]
        pub fn flush_dirty(&mut self) -> Vec<f32> {
            let (indices, emb64, pos2d) = self.inner.flush_dirty();
            let n = indices.len();
            let mut result = Vec::with_capacity(1 + n + n * DIMS + n * 2);
            result.push(n as f32);
            for &i in &indices {
                result.push(i as f32);
            }
            result.extend_from_slice(&emb64);
            result.extend_from_slice(&pos2d);
            result
        }
    }
}

// ---------------------------------------------------------------------------
// Native Node.js addon bindings (feature = "node")
// ---------------------------------------------------------------------------

#[cfg(feature = "node")]
mod node_bindings {
    use super::*;
    use napi::bindgen_prelude::*;
    use napi_derive::napi;

    #[napi]
    pub struct EmbeddingEngine {
        inner: EmbeddingEngineCore,
    }

    #[napi]
    impl EmbeddingEngine {
        #[napi(constructor)]
        pub fn new(n: u32) -> Self {
            EmbeddingEngine {
                inner: EmbeddingEngineCore::new(n as usize),
            }
        }

        #[napi(getter)]
        pub fn size(&self) -> u32 {
            self.inner.n as u32
        }

        #[napi]
        pub fn set_embedding(&mut self, idx: u32, data: Float32Array) {
            self.inner.set_embedding(idx as usize, data.as_ref());
        }

        #[napi]
        pub fn set_position2d(&mut self, idx: u32, x: f64, y: f64) {
            self.inner.set_position2d(idx as usize, x as f32, y as f32);
        }

        #[napi]
        pub fn get_embedding(&self, idx: u32) -> Float32Array {
            let v = self.inner.get_embedding(idx as usize);
            Float32Array::from(v.as_slice())
        }

        #[napi]
        pub fn get_position2d(&self, idx: u32) -> Vec<f64> {
            let (x, y) = self.inner.get_position2d(idx as usize);
            vec![x as f64, y as f64]
        }

        #[napi]
        pub fn get_all_positions2d(&self) -> Float32Array {
            Float32Array::from(self.inner.all_positions2d())
        }

        #[napi]
        pub fn similarity(&self, i: u32, j: u32) -> f64 {
            self.inner.similarity(i as usize, j as usize) as f64
        }

        #[napi]
        pub fn update_triplet(&mut self, anchor: u32, pos: u32, neg: u32, lr: f64) {
            self.inner
                .update_triplet(anchor as usize, pos as usize, neg as usize, lr as f32);
        }

        #[napi]
        pub fn attract(&mut self, indices: Vec<u32>, strength: f64) {
            let idx: Vec<usize> = indices.iter().map(|&i| i as usize).collect();
            self.inner.attract(&idx, strength as f32);
        }

        #[napi]
        pub fn repel(&mut self, indices: Vec<u32>, strength: f64) {
            let idx: Vec<usize> = indices.iter().map(|&i| i as usize).collect();
            self.inner.repel(&idx, strength as f32);
        }

        #[napi]
        pub fn k_nearest(&self, idx: u32, k: u32) -> Vec<u32> {
            self.inner
                .k_nearest(idx as usize, k as usize)
                .iter()
                .map(|&i| i as u32)
                .collect()
        }

        /// Returns dirty node data and clears dirty flags.
        /// Encoding: [n_dirty, idx0, idx1, ..., emb64_flat..., pos2d_flat...]
        #[napi]
        pub fn flush_dirty(&mut self) -> Vec<f64> {
            let (indices, emb64, pos2d) = self.inner.flush_dirty();
            let n = indices.len();
            let mut result = Vec::with_capacity(1 + n + n * DIMS + n * 2);
            result.push(n as f64);
            for &i in &indices {
                result.push(i as f64);
            }
            for v in &emb64 { result.push(*v as f64); }
            for v in &pos2d { result.push(*v as f64); }
            result
        }
    }
}

// Re-export the correct binding depending on the active feature.
#[cfg(feature = "wasm")]
pub use wasm_bindings::EmbeddingEngine;

#[cfg(feature = "node")]
pub use node_bindings::EmbeddingEngine;
