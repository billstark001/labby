//! Core embedding engine.
//!
//! Owns:
//!   - The N×64 latent coordinate matrix  (the metric space representation)
//!   - The N×2  projection matrix         (frontend visualization state)
//!   - A HNSW index for O(log N) k-NN queries
//!   - A dirty-flag HashSet for incremental sync
//!
//! All SGD operations are strictly O(1) with respect to N — only the
//! coordinates of the 2–3 involved nodes are ever written.

use ndarray::Array2;
use std::collections::HashSet;

use crate::distance::{l2_dist_sq, l2_dist};
use crate::hnsw::HNSWIndex;

// ── Compile-time dimension constants ─────────────────────────────────────────
pub const LATENT_DIM:  usize = 64;
pub const PROJ_DIM:    usize = 2;

// ── HNSW hyper-parameters ────────────────────────────────────────────────────
const HNSW_M:               usize = 16;
const HNSW_EF_CONSTRUCTION: usize = 200;

// ── Projection hyper-parameters ──────────────────────────────────────────────
const KNN_K:        usize = 15;
const KNN_EF:       usize = 60;
/// Bandwidth σ² for the Gaussian projection kernel.
/// Tuned so that the 15 nearest neighbours at d=64 receive non-trivial weight.
const PROJ_SIGMA_SQ: f32  = 4.0;

// ── Output types ─────────────────────────────────────────────────────────────

/// A single node's updated state, returned by `flush_dirty_nodes`.
pub struct DirtyNode {
    pub id:         u32,
    pub coords_64d: [f32; LATENT_DIM],
    pub coords_2d:  [f32; PROJ_DIM],
}

// ── Engine ────────────────────────────────────────────────────────────────────

pub struct EmbeddingEngine {
    /// N × 64 latent coordinates — the source of truth for all distances.
    coords:     Array2<f32>,
    /// N × 2  2-D projection coordinates for the frontend.
    projection: Array2<f32>,
    /// Active-node flag per slot.
    active:     Vec<bool>,
    /// Monotonically increasing next-slot counter.
    next_id:    u32,
    /// Free-list: IDs of deleted nodes available for reuse.
    free_list:  Vec<u32>,
    /// Nodes modified since last flush.
    dirty:      HashSet<u32>,
    /// Approximate nearest-neighbour index over the 64-D space.
    ann:        HNSWIndex,
    /// Number of currently active nodes.
    n_active:   usize,
    /// Total allocated row capacity of both matrices.
    capacity:   usize,
}

impl EmbeddingEngine {
    // ── Construction ─────────────────────────────────────────────────────────

    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(16);
        EmbeddingEngine {
            coords:     Array2::zeros((cap, LATENT_DIM)),
            projection: Array2::zeros((cap, PROJ_DIM)),
            active:     vec![false; cap],
            next_id:    0,
            free_list:  Vec::new(),
            dirty:      HashSet::new(),
            ann:        HNSWIndex::new(HNSW_M, HNSW_EF_CONSTRUCTION),
            n_active:   0,
            capacity:   cap,
        }
    }

    // ── Hydration ─────────────────────────────────────────────────────────────

    /// Initialize the engine from a flat f32 buffer of length `n_nodes × 64`.
    ///
    /// The data is copied in once; subsequent operations reference Rust-owned
    /// memory only. This avoids any per-operation FFI serialization overhead.
    pub fn hydrate(&mut self, data: &[f32], n_nodes: usize) {
        assert_eq!(
            data.len(), n_nodes * LATENT_DIM,
            "data length must equal n_nodes * {}", LATENT_DIM
        );

        if n_nodes > self.capacity {
            self.grow(n_nodes);
        }

        // ── Copy coordinates into the ndarray matrix ──────────────────────
        for i in 0..n_nodes {
            let src = &data[i * LATENT_DIM..(i + 1) * LATENT_DIM];
            let mut row = self.coords.row_mut(i);
            for (dst, &v) in row.iter_mut().zip(src.iter()) {
                *dst = v;
            }
            self.active[i] = true;
        }

        self.n_active = n_nodes;
        self.next_id  = n_nodes as u32;

        // ── Build HNSW index ──────────────────────────────────────────────
        for i in 0..n_nodes {
            self.ann.insert(i as u32, &self.coords);
        }

        // ── Initialize 2-D projection via random projection (fast stand-in)
        // In production replace with a randomised-SVD PCA pass or a
        // pre-computed parametric UMAP decoder network.
        self.init_random_projection();
    }

    /// Initialize 2-D coordinates via two random unit-vector projections of
    /// the mean-centred latent space.  O(N·d).
    fn init_random_projection(&mut self) {
        use rand::{SeedableRng, Rng};
        use rand::rngs::SmallRng;
        let mut rng = SmallRng::seed_from_u64(42);
        let n = self.n_active;

        // Compute column-wise mean
        let mut mean = vec![0.0f32; LATENT_DIM];
        for i in 0..n {
            for (m, &v) in mean.iter_mut().zip(self.coords.row(i).iter()) {
                *m += v;
            }
        }
        mean.iter_mut().for_each(|m| *m /= n as f32);

        // Two random projection vectors, L2-normalised
        let mut vecs: [[f32; LATENT_DIM]; 2] = [[0.0; LATENT_DIM]; 2];
        for v in vecs.iter_mut() {
            for x in v.iter_mut() { *x = rng.gen::<f32>() - 0.5; }
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            v.iter_mut().for_each(|x| *x /= norm);
        }

        for i in 0..n {
            let row = self.coords.row(i);
            for (j, proj_vec) in vecs.iter().enumerate() {
                let dot: f32 = row.iter()
                    .zip(mean.iter())
                    .zip(proj_vec.iter())
                    .map(|((c, m), p)| (c - m) * p)
                    .sum();
                self.projection[[i, j]] = dot;
            }
        }
    }

    // ── Node lifecycle ────────────────────────────────────────────────────────

    pub fn insert_node(&mut self, coords_64d: &[f32]) -> u32 {
        assert_eq!(coords_64d.len(), LATENT_DIM);

        let id  = self.alloc_id();
        let idx = id as usize;

        for (dst, &v) in self.coords.row_mut(idx).iter_mut().zip(coords_64d.iter()) {
            *dst = v;
        }
        self.active[idx] = true;
        self.n_active   += 1;

        self.ann.insert(id, &self.coords);
        self.update_projection(id);
        self.dirty.insert(id);
        id
    }

    pub fn delete_node(&mut self, id: u32) {
        let idx = id as usize;
        if idx < self.capacity && self.active[idx] {
            self.active[idx]  = false;
            self.n_active    -= 1;
            self.ann.remove(id);
            self.free_list.push(id);
            // Deleted nodes are not broadcast; remove from dirty if present.
            self.dirty.remove(&id);
        }
    }

    // ── Query ─────────────────────────────────────────────────────────────────

    /// Returns `true` if d(a,b) < d(a,c), i.e., a is closer to b than to c.
    pub fn query_triplet_order(&self, id_a: u32, id_b: u32, id_c: u32) -> bool {
        let a = self.coords.row(id_a as usize);
        let b = self.coords.row(id_b as usize);
        let c = self.coords.row(id_c as usize);
        l2_dist_sq(a, b) < l2_dist_sq(a, c)
    }

    // ── SGD updates ──────────────────────────────────────────────────────────

    /// Triplet margin loss gradient step — enforces d(a,b) < d(a,c).
    ///
    /// Loss:  L = max(0,  ‖xₐ − x_b‖² − ‖xₐ − x_c‖² + margin)
    ///
    /// Gradients (when L > 0):
    ///   ∂L/∂xₐ = 2(xₐ−x_b) − 2(xₐ−x_c)
    ///   ∂L/∂x_b = 2(x_b − xₐ)
    ///   ∂L/∂x_c = −2(x_c − xₐ)
    ///
    /// Returns the loss value before the update.
    pub fn update_triplet(
        &mut self,
        id_a: u32,
        id_b: u32,
        id_c: u32,
        margin: f32,
        lr: f32,
    ) -> f32 {
        let (ia, ib, ic) = (id_a as usize, id_b as usize, id_c as usize);

        let d_ab_sq = l2_dist_sq(self.coords.row(ia), self.coords.row(ib));
        let d_ac_sq = l2_dist_sq(self.coords.row(ia), self.coords.row(ic));

        let loss = d_ab_sq - d_ac_sq + margin;
        if loss <= 0.0 { return 0.0; }

        // Materialize owned gradient vecs before any mutation to avoid borrow
        // conflicts on self.coords.
        let (grad_a, grad_b, grad_c) = {
            let xa = self.coords.row(ia);
            let xb = self.coords.row(ib);
            let xc = self.coords.row(ic);

            let ga: Vec<f32> = xa.iter().zip(xb.iter()).zip(xc.iter())
                .map(|((a, b), c)| 2.0 * (a - b) - 2.0 * (a - c))
                .collect();
            let gb: Vec<f32> = xb.iter().zip(xa.iter())
                .map(|(b, a)| 2.0 * (b - a))
                .collect();
            let gc: Vec<f32> = xc.iter().zip(xa.iter())
                .map(|(c, a)| -2.0 * (c - a))
                .collect();
            (ga, gb, gc)
        };

        self.apply_grad(ia, &grad_a, lr);
        self.apply_grad(ib, &grad_b, lr);
        self.apply_grad(ic, &grad_c, lr);

        self.update_projection(id_a);
        self.update_projection(id_b);
        self.update_projection(id_c);

        self.dirty.insert(id_a);
        self.dirty.insert(id_b);
        self.dirty.insert(id_c);

        loss
    }

    /// Pairwise push/pull — adjusts ‖xₐ − x_b‖ toward `target_distance`.
    ///
    /// Loss:  L = (‖xₐ − x_b‖ − target)²
    ///
    /// Gradients:
    ///   ∂L/∂xₐ =  2(d − t) · (xₐ − x_b) / d
    ///   ∂L/∂x_b = −2(d − t) · (xₐ − x_b) / d
    ///
    /// Returns the loss value before the update.
    pub fn update_pair(
        &mut self,
        id_a: u32,
        id_b: u32,
        target_distance: f32,
        lr: f32,
    ) -> f32 {
        let (ia, ib) = (id_a as usize, id_b as usize);

        let d = l2_dist(self.coords.row(ia), self.coords.row(ib));
        if d < 1e-8 { return 0.0; }

        let loss  = (d - target_distance).powi(2);
        let scale = 2.0 * (d - target_distance) / d;

        let (grad_a, grad_b) = {
            let xa = self.coords.row(ia);
            let xb = self.coords.row(ib);
            let diff: Vec<f32> = xa.iter().zip(xb.iter()).map(|(a, b)| a - b).collect();
            let ga: Vec<f32> = diff.iter().map(|v| scale * v).collect();
            let gb: Vec<f32> = diff.iter().map(|v| -scale * v).collect();
            (ga, gb)
        };

        self.apply_grad(ia, &grad_a, lr);
        self.apply_grad(ib, &grad_b, lr);

        self.update_projection(id_a);
        self.update_projection(id_b);

        self.dirty.insert(id_a);
        self.dirty.insert(id_b);

        loss
    }

    // ── k-NN query (public) ───────────────────────────────────────────────────

    /// Returns up to `k` nearest neighbours as `(node_id, true_distance)` pairs.
    pub fn get_knn(&self, id: u32, k: usize) -> Vec<(u32, f32)> {
        let query_row: Vec<f32> = self.coords.row(id as usize).to_vec();
        let mut results = self.ann.knn_search(&query_row, k + 1, k * 2 + 20, &self.coords);
        results.retain(|(n_id, _)| *n_id != id && self.active[*n_id as usize]);
        results.truncate(k);
        // Convert squared distance → true distance
        results.iter_mut().for_each(|(_, d)| *d = d.sqrt());
        results
    }

    // ── Dirty-flag flush ──────────────────────────────────────────────────────

    /// Return all dirty nodes' updated state as a typed Vec, then clear the set.
    pub fn flush_dirty_nodes(&mut self) -> Vec<DirtyNode> {
        let ids: Vec<u32> = self.dirty.drain().collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let idx = id as usize;
            if idx >= self.capacity || !self.active[idx] { continue; }
            let mut c64 = [0.0f32; LATENT_DIM];
            let mut c2  = [0.0f32; PROJ_DIM];
            for (i, &v) in self.coords.row(idx).iter().enumerate()     { c64[i] = v; }
            for (i, &v) in self.projection.row(idx).iter().enumerate() { c2[i]  = v; }
            out.push(DirtyNode { id, coords_64d: c64, coords_2d: c2 });
        }
        out
    }

    /// Serialize dirty nodes to a compact little-endian byte buffer.
    ///
    /// Wire format (all values little-endian):
    /// ```text
    /// [n_dirty : u32]
    /// for each dirty node:
    ///   [id     : u32      ]  (4 bytes)
    ///   [c64    : f32 × 64 ]  (256 bytes)
    ///   [c2d    : f32 × 2  ]  (8 bytes)
    ///                          ─────────
    ///                          268 bytes per node
    /// ```
    pub fn flush_dirty_nodes_bytes(&mut self) -> Vec<u8> {
        let nodes = self.flush_dirty_nodes();
        const ENTRY: usize = 4 + LATENT_DIM * 4 + PROJ_DIM * 4; // 268

        let mut buf = Vec::with_capacity(4 + nodes.len() * ENTRY);
        buf.extend_from_slice(&(nodes.len() as u32).to_le_bytes());
        for n in &nodes {
            buf.extend_from_slice(&n.id.to_le_bytes());
            for &v in &n.coords_64d { buf.extend_from_slice(&v.to_le_bytes()); }
            for &v in &n.coords_2d  { buf.extend_from_slice(&v.to_le_bytes()); }
        }
        buf
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    pub fn node_count(&self)   -> usize  { self.n_active }
    pub fn capacity(&self)     -> usize  { self.capacity }

    pub fn get_projection(&self, id: u32) -> [f32; 2] {
        [self.projection[[id as usize, 0]], self.projection[[id as usize, 1]]]
    }

    pub fn get_coords_64d(&self, id: u32) -> Vec<f32> {
        self.coords.row(id as usize).to_vec()
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    #[inline]
    fn apply_grad(&mut self, idx: usize, grad: &[f32], lr: f32) {
        for (w, g) in self.coords.row_mut(idx).iter_mut().zip(grad.iter()) {
            *w -= lr * g;
        }
    }

    /// Incremental 2-D projection: kernel-weighted interpolation from k-NN.
    ///
    /// New 2-D position = Σ wᵢ·p₂ᵢ / Σ wᵢ
    ///   where wᵢ = exp(−d²ᵢ / σ²)  and  dᵢ is the 64-D distance to neighbour i.
    ///
    /// This is a fast parametric approximation.  A trained parametric UMAP decoder
    /// network would give higher-fidelity global topology preservation but requires
    /// offline training and inference overhead that is incompatible with sub-ms latency.
    fn update_projection(&mut self, id: u32) {
        let idx = id as usize;
        // Copy query row to avoid holding a borrow on self.coords while we later
        // need a mutable borrow on self.projection.
        let query_row: Vec<f32> = self.coords.row(idx).to_vec();

        let knn = self.ann.knn_search(&query_row, KNN_K + 1, KNN_EF, &self.coords);
        let knn: Vec<(u32, f32)> = knn.into_iter()
            .filter(|(n_id, _)| *n_id != id && self.active[*n_id as usize])
            .take(KNN_K)
            .collect();

        if knn.is_empty() { return; }

        let mut sx = 0.0f32;
        let mut sy = 0.0f32;
        let mut sw = 0.0f32;

        for (n_id, dist_sq) in &knn {
            // Gaussian kernel: w = exp(−d²/σ²)
            let w = (-dist_sq / PROJ_SIGMA_SQ).exp().max(1e-12);
            let p = self.projection.row(*n_id as usize);
            sx += w * p[0];
            sy += w * p[1];
            sw += w;
        }

        if sw > 1e-12 {
            self.projection[[idx, 0]] = sx / sw;
            self.projection[[idx, 1]] = sy / sw;
        }
    }

    fn alloc_id(&mut self) -> u32 {
        if let Some(id) = self.free_list.pop() {
            return id;
        }
        let id = self.next_id;
        self.next_id += 1;
        if id as usize >= self.capacity {
            self.grow((id as usize + 1).max(self.capacity * 2));
        }
        id
    }

    fn grow(&mut self, min_cap: usize) {
        let new_cap = min_cap.max(self.capacity * 2);

        let mut new_coords = Array2::zeros((new_cap, LATENT_DIM));
        let mut new_proj   = Array2::zeros((new_cap, PROJ_DIM));

        new_coords
            .slice_mut(ndarray::s![..self.capacity, ..])
            .assign(&self.coords);
        new_proj
            .slice_mut(ndarray::s![..self.capacity, ..])
            .assign(&self.projection);

        self.coords     = new_coords;
        self.projection = new_proj;
        self.active.resize(new_cap, false);
        self.capacity = new_cap;
    }
}