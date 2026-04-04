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
use rand::{Rng, SeedableRng};
use rand::rngs::SmallRng;
use rand::seq::SliceRandom;
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
const GLOBAL_NORMALIZE_INTERVAL: usize = 128;
const NORMALIZE_EPS: f32 = 1e-6;
const RECOMMEND_KNN: usize = 24;
const RECOMMEND_POSITIVE_CAP: usize = 10;
const RECOMMEND_MARGIN_TARGET: f32 = 0.2;
const RECOMMEND_NEAR_MARGIN: f32 = 0.28;

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
    /// Number of update finalization rounds since the last global normalization.
    normalize_tick: usize,
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
            normalize_tick: 0,
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

        // Reset index/state before filling a new snapshot.
        self.ann = HNSWIndex::new(HNSW_M, HNSW_EF_CONSTRUCTION);
        self.active.fill(false);
        self.free_list.clear();
        self.dirty.clear();

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
        self.normalize_tick = 0;

        self.normalize_latent_space();

        // ── Build HNSW index ──────────────────────────────────────────────
        self.rebuild_ann_index();

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

    /// Recommend one high-information triplet `(anchor, positive, negative)`.
    ///
    /// Strategy:
    /// - anchor-positive from near neighbours with non-trivial uncertainty
    /// - negative from slightly farther neighbours (hard but valid)
    /// - skip recently asked anchor-positive pairs from `excluded_pairs`
    ///
    /// `excluded_pairs` format: `[a0,b0,a1,b1,...]`.
    pub fn recommend_triplet(&self, excluded_pairs: &[u32]) -> Option<(u32, u32, u32)> {
        if self.n_active < 3 {
            return None;
        }

        let mut rng = SmallRng::seed_from_u64(rand::random::<u64>());

        let mut excluded = HashSet::new();
        for chunk in excluded_pairs.chunks_exact(2) {
            excluded.insert(pair_key(chunk[0], chunk[1]));
        }

        let mut anchors = self.active_ids();
        anchors.shuffle(&mut rng);

        let mut best: Option<(u32, u32, u32, f32)> = None;
        for anchor in anchors {
            let neighbors = self.get_knn(anchor, RECOMMEND_KNN);
            if neighbors.len() < 2 {
                continue;
            }

            let mut positive_indices: Vec<usize> = (0..neighbors.len().min(RECOMMEND_POSITIVE_CAP)).collect();
            positive_indices.shuffle(&mut rng);

            let anchor_norm = self.node_norm(anchor);
            let anchor_norm_bias = (anchor_norm - 1.0).abs().min(1.2);

            for pos_idx in positive_indices {
                let (positive_id, d_ap) = neighbors[pos_idx];
                if d_ap <= 1e-6 {
                    continue;
                }
                if excluded.contains(&pair_key(anchor, positive_id)) {
                    continue;
                }

                let sim_ap = similarity_from_distance(d_ap);
                if !(0.2..=0.9).contains(&sim_ap) {
                    continue;
                }

                let uncertainty = (1.0 - (sim_ap - 0.5).abs() * 2.0).max(0.0);
                if uncertainty <= 0.0 {
                    continue;
                }

                let mut best_negative: Option<(u32, f32)> = None;
                let mut fallback_negative: Option<(u32, f32)> = None;
                for neg_idx in (pos_idx + 1)..neighbors.len() {
                    let (negative_id, d_an) = neighbors[neg_idx];
                    if negative_id == positive_id || d_an <= d_ap {
                        continue;
                    }

                    let gap = d_an - d_ap;
                    let hardness = 1.0 / (1.0 + (gap - RECOMMEND_MARGIN_TARGET).abs() * 5.0);
                    let violation_proxy = (d_ap * d_ap - d_an * d_an + RECOMMEND_MARGIN_TARGET).max(0.0);
                    let near_margin = (gap - RECOMMEND_NEAR_MARGIN).abs();
                    let norm_pair_bias = ((self.node_norm(positive_id) - 1.0).abs() + (self.node_norm(negative_id) - 1.0).abs()) * 0.15;
                    let random_jitter = rng.gen_range(0.0..0.2);
                    let score = hardness + violation_proxy * 3.0 + norm_pair_bias + random_jitter;

                    if gap <= RECOMMEND_NEAR_MARGIN * 1.6 {
                        match best_negative {
                            Some((_, best_score)) if score <= best_score => {}
                            _ => best_negative = Some((negative_id, score)),
                        }
                    }

                    let fallback_score = score - near_margin * 0.4;
                    match fallback_negative {
                        Some((_, best_score)) if fallback_score <= best_score => {}
                        _ => fallback_negative = Some((negative_id, fallback_score)),
                    }
                }

                let picked_negative = best_negative.or(fallback_negative);
                let Some((negative_id, negative_score)) = picked_negative else {
                    continue;
                };

                let total_score = uncertainty * 2.0 + negative_score + anchor_norm_bias * 0.6;
                match best {
                    Some((_, _, _, best_score)) if total_score <= best_score => {}
                    _ => best = Some((anchor, positive_id, negative_id, total_score)),
                }
            }
        }

        best.map(|(anchor, positive, negative, _)| (anchor, positive, negative))
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
        let loss = self.update_triplet_step(id_a, id_b, id_c, margin, lr);
        if loss <= 0.0 { return 0.0; }

        let touched = HashSet::from([id_a, id_b, id_c]);
        self.finalize_touched_nodes(&touched);

        loss
    }

    /// Batch triplet updates with one deduplicated ANN/projection refresh.
    ///
    /// `triplets` format: `[a0,b0,c0,a1,b1,c1,...]`.
    pub fn update_triplets_batch_flat(
        &mut self,
        triplets: &[u32],
        margin: f32,
        lr: f32,
    ) -> Result<(), &'static str> {
        if triplets.len() % 3 != 0 {
            return Err("triplets length must be multiple of 3");
        }

        let mut touched = HashSet::new();
        for chunk in triplets.chunks_exact(3) {
            let loss = self.update_triplet_step(chunk[0], chunk[1], chunk[2], margin, lr);
            if loss <= 0.0 {
                continue;
            }
            touched.insert(chunk[0]);
            touched.insert(chunk[1]);
            touched.insert(chunk[2]);
        }
        self.finalize_touched_nodes(&touched);
        Ok(())
    }

    fn update_triplet_step(
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
        let grad_scale = if loss > 0.0 {
            1.0
        } else {
            // Smooth hinge tail: still apply tiny gradients near satisfied border
            // to reduce "only one option changes" behavior.
            let softness = (loss / 0.18).exp() * 0.08;
            if softness < 1e-4 {
                return 0.0;
            }
            softness
        };

        // Materialize owned gradient vecs before any mutation to avoid borrow
        // conflicts on self.coords.
        let (grad_a, grad_b, grad_c) = {
            let xa = self.coords.row(ia);
            let xb = self.coords.row(ib);
            let xc = self.coords.row(ic);

            let ga: Vec<f32> = xa.iter().zip(xb.iter()).zip(xc.iter())
                .map(|((a, b), c)| (2.0 * (a - b) - 2.0 * (a - c)) * grad_scale)
                .collect();
            let gb: Vec<f32> = xb.iter().zip(xa.iter())
                .map(|(b, a)| 2.0 * (b - a) * grad_scale)
                .collect();
            let gc: Vec<f32> = xc.iter().zip(xa.iter())
                .map(|(c, a)| -2.0 * (c - a) * grad_scale)
                .collect();
            (ga, gb, gc)
        };

        self.apply_grad(ia, &grad_a, lr);
        self.apply_grad(ib, &grad_b, lr);
        self.apply_grad(ic, &grad_c, lr);

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
        let loss = self.update_pair_step(id_a, id_b, target_distance, lr);
        if loss <= 0.0 { return 0.0; }

        let touched = HashSet::from([id_a, id_b]);
        self.finalize_touched_nodes(&touched);

        loss
    }

    /// Batch pair updates with one deduplicated ANN/projection refresh.
    ///
    /// `pairs` format: `[a0,b0,a1,b1,...]`.
    pub fn update_pairs_batch_flat(
        &mut self,
        pairs: &[u32],
        target_distance: f32,
        lr: f32,
    ) -> Result<(), &'static str> {
        if pairs.len() % 2 != 0 {
            return Err("pairs length must be multiple of 2");
        }

        let mut touched = HashSet::new();
        for chunk in pairs.chunks_exact(2) {
            let loss = self.update_pair_step(chunk[0], chunk[1], target_distance, lr);
            if loss <= 0.0 {
                continue;
            }
            touched.insert(chunk[0]);
            touched.insert(chunk[1]);
        }
        self.finalize_touched_nodes(&touched);
        Ok(())
    }

    fn update_pair_step(
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

    fn finalize_touched_nodes(&mut self, touched: &HashSet<u32>) {
        if touched.is_empty() {
            return;
        }
        for id in touched {
            self.rebalance_node_norm(*id);
        }
        for id in touched {
            self.refresh_ann_node(*id);
        }
        for id in touched {
            self.update_projection(*id);
            self.dirty.insert(*id);
        }

        self.normalize_tick += 1;
        if self.normalize_tick >= GLOBAL_NORMALIZE_INTERVAL {
            self.normalize_tick = 0;
            self.normalize_latent_space();
            self.normalize_projection_space();
            self.rebuild_ann_index();
            for id in self.active_ids() {
                self.dirty.insert(id);
            }
        }
    }

    fn active_ids(&self) -> Vec<u32> {
        let mut ids = Vec::with_capacity(self.n_active);
        for idx in 0..self.capacity {
            if self.active[idx] {
                ids.push(idx as u32);
            }
        }
        ids
    }

    fn normalize_latent_space(&mut self) {
        if self.n_active == 0 {
            return;
        }

        let mut mean = [0.0f32; LATENT_DIM];
        for idx in 0..self.capacity {
            if !self.active[idx] {
                continue;
            }
            let row = self.coords.row(idx);
            for i in 0..LATENT_DIM {
                mean[i] += row[i];
            }
        }
        let inv_n = 1.0f32 / self.n_active as f32;
        for i in 0..LATENT_DIM {
            mean[i] *= inv_n;
        }

        for idx in 0..self.capacity {
            if !self.active[idx] {
                continue;
            }
            let mut row = self.coords.row_mut(idx);
            for i in 0..LATENT_DIM {
                row[i] -= mean[i];
            }
        }

        let mut norm_sum = 0.0f32;
        for idx in 0..self.capacity {
            if !self.active[idx] {
                continue;
            }
            let row = self.coords.row(idx);
            let mut sq = 0.0f32;
            for i in 0..LATENT_DIM {
                sq += row[i] * row[i];
            }
            norm_sum += sq.sqrt();
        }

        let mean_norm = norm_sum * inv_n;
        if mean_norm <= NORMALIZE_EPS {
            return;
        }
        let scale = 1.0f32 / mean_norm;

        for idx in 0..self.capacity {
            if !self.active[idx] {
                continue;
            }
            let mut row = self.coords.row_mut(idx);
            for i in 0..LATENT_DIM {
                row[i] *= scale;
            }
        }
    }

    fn normalize_projection_space(&mut self) {
        if self.n_active == 0 {
            return;
        }

        let mut mx = 0.0f32;
        let mut my = 0.0f32;
        for idx in 0..self.capacity {
            if !self.active[idx] {
                continue;
            }
            mx += self.projection[[idx, 0]];
            my += self.projection[[idx, 1]];
        }
        let inv_n = 1.0f32 / self.n_active as f32;
        mx *= inv_n;
        my *= inv_n;

        for idx in 0..self.capacity {
            if !self.active[idx] {
                continue;
            }
            self.projection[[idx, 0]] -= mx;
            self.projection[[idx, 1]] -= my;
        }

        let mut radii = Vec::with_capacity(self.n_active);
        let mut norm_sum = 0.0f32;
        for idx in 0..self.capacity {
            if !self.active[idx] {
                continue;
            }
            let x = self.projection[[idx, 0]];
            let y = self.projection[[idx, 1]];
            let r = (x * x + y * y).sqrt();
            radii.push(r);
            norm_sum += r;
        }

        radii.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median_radius = radii[radii.len() / 2].max(NORMALIZE_EPS);
        let p90_index = ((radii.len() as f32) * 0.9).floor() as usize;
        let p90_radius = radii[p90_index.min(radii.len() - 1)].max(median_radius);

        let mean_norm = norm_sum * inv_n;
        if mean_norm <= NORMALIZE_EPS {
            return;
        }

        // Robust scaling: keep p90 near unit radius while compressing outliers
        // and slightly expanding the dense center cloud.
        let base_scale = 1.0f32 / p90_radius.max(mean_norm * 0.8);
        for idx in 0..self.capacity {
            if !self.active[idx] {
                continue;
            }
            let x = self.projection[[idx, 0]];
            let y = self.projection[[idx, 1]];
            let r = (x * x + y * y).sqrt();
            if r <= NORMALIZE_EPS {
                continue;
            }

            let inner = median_radius * 0.7;
            let outer = p90_radius * 1.6;
            let target_r = if r < inner {
                inner * (r / inner).powf(0.78)
            } else if r > outer {
                outer + (r - outer) * 0.32
            } else {
                r
            };

            let factor = (target_r / r) * base_scale;
            self.projection[[idx, 0]] = x * factor;
            self.projection[[idx, 1]] = y * factor;
        }
    }

    fn rebuild_ann_index(&mut self) {
        self.ann = HNSWIndex::new(HNSW_M, HNSW_EF_CONSTRUCTION);
        for idx in 0..self.capacity {
            if self.active[idx] {
                self.ann.insert(idx as u32, &self.coords);
            }
        }
    }

    #[inline]
    fn refresh_ann_node(&mut self, id: u32) {
        let idx = id as usize;
        if idx >= self.capacity || !self.active[idx] {
            return;
        }
        self.ann.remove(id);
        self.ann.insert(id, &self.coords);
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

    #[inline]
    fn node_norm(&self, id: u32) -> f32 {
        let idx = id as usize;
        if idx >= self.capacity || !self.active[idx] {
            return 1.0;
        }
        let row = self.coords.row(idx);
        row.iter().map(|v| v * v).sum::<f32>().sqrt()
    }

    fn rebalance_node_norm(&mut self, id: u32) {
        let idx = id as usize;
        if idx >= self.capacity || !self.active[idx] {
            return;
        }
        let norm = {
            let row = self.coords.row(idx);
            row.iter().map(|v| v * v).sum::<f32>().sqrt()
        };
        if norm <= NORMALIZE_EPS {
            return;
        }

        // Especially care about vectors with too large/small magnitude.
        if (0.75..=1.35).contains(&norm) {
            return;
        }

        let target = 1.0f32;
        let adjust = if norm > target { 0.85 } else { 1.15 };
        let scale = ((target / norm) * adjust).clamp(0.65, 1.5);
        let mut row = self.coords.row_mut(idx);
        for i in 0..LATENT_DIM {
            row[i] *= scale;
        }
    }
}

#[inline]
fn pair_key(a: u32, b: u32) -> u64 {
    if a < b {
        ((a as u64) << 32) | (b as u64)
    } else {
        ((b as u64) << 32) | (a as u64)
    }
}

#[inline]
fn similarity_from_distance(distance: f32) -> f32 {
    1.0 / (1.0 + distance)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axis_vec(axis: usize, value: f32) -> [f32; LATENT_DIM] {
        let mut v = [0.0f32; LATENT_DIM];
        v[axis] = value;
        v
    }

    #[test]
    fn insert_delete_reuses_slot_and_keeps_other_nodes_stable() {
        let mut engine = EmbeddingEngine::new(4);

        let id0 = engine.insert_node(&axis_vec(0, 0.0));
        let id1 = engine.insert_node(&axis_vec(0, 1.0));
        let before = engine.get_coords_64d(id1);

        engine.delete_node(id0);
        let id2 = engine.insert_node(&axis_vec(0, 2.0));

        assert_eq!(id2, id0, "deleted slot should be reused via free_list");
        assert_eq!(engine.node_count(), 2);
        assert_eq!(before, engine.get_coords_64d(id1), "unrelated node must remain unchanged");
    }

    #[test]
    fn update_pair_push_and_pull_move_distance_toward_target() {
        let mut engine = EmbeddingEngine::new(4);

        let id_a = engine.insert_node(&axis_vec(0, 0.0));
        let id_b = engine.insert_node(&axis_vec(0, 4.0));

        let dist_before = {
            let a = engine.get_coords_64d(id_a);
            let b = engine.get_coords_64d(id_b);
            (a[0] - b[0]).abs()
        };

        let _ = engine.update_pair(id_a, id_b, 1.0, 0.1);
        let dist_after_pull = {
            let a = engine.get_coords_64d(id_a);
            let b = engine.get_coords_64d(id_b);
            (a[0] - b[0]).abs()
        };
        assert!(dist_after_pull < dist_before, "pull should decrease pair distance");

        let _ = engine.update_pair(id_a, id_b, 6.0, 0.1);
        let dist_after_push = {
            let a = engine.get_coords_64d(id_a);
            let b = engine.get_coords_64d(id_b);
            (a[0] - b[0]).abs()
        };
        assert!(dist_after_push > dist_after_pull, "push should increase pair distance");
    }

    #[test]
    fn triplet_update_can_flip_order_to_satisfy_constraint() {
        let mut engine = EmbeddingEngine::new(8);

        let id_a = engine.insert_node(&axis_vec(0, 0.0));
        let id_b = engine.insert_node(&axis_vec(0, 3.0));
        let id_c = engine.insert_node(&axis_vec(0, 1.0));

        assert!(!engine.query_triplet_order(id_a, id_b, id_c));

        let mut observed_positive_loss = false;
        for _ in 0..300 {
            let loss = engine.update_triplet(id_a, id_b, id_c, 0.2, 0.05);
            if loss > 0.0 {
                observed_positive_loss = true;
            }
            if engine.query_triplet_order(id_a, id_b, id_c) {
                break;
            }
        }

        assert!(observed_positive_loss, "triplet violation should produce positive loss");
        assert!(engine.query_triplet_order(id_a, id_b, id_c), "after SGD, a should become closer to b than c");
    }

    #[test]
    fn dirty_flush_returns_only_touched_nodes_and_clears_state() {
        let mut engine = EmbeddingEngine::new(8);

        let id_a = engine.insert_node(&axis_vec(0, 0.0));
        let id_b = engine.insert_node(&axis_vec(0, 2.0));
        let id_c = engine.insert_node(&axis_vec(0, 5.0));

        let _ = engine.update_pair(id_a, id_b, 1.0, 0.1);

        let mut dirty = engine.flush_dirty_nodes();
        dirty.sort_by_key(|n| n.id);

        let ids: Vec<u32> = dirty.iter().map(|n| n.id).collect();
        assert_eq!(ids, vec![id_a, id_b, id_c], "insertions + pair update should mark touched nodes dirty");
        for node in &dirty {
            assert!(node.coords_64d.iter().all(|v| v.is_finite()));
            assert!(node.coords_2d.iter().all(|v| v.is_finite()));
        }
        assert_eq!(engine.flush_dirty_nodes().len(), 0, "flush should clear dirty set");
    }

    #[test]
    fn periodic_global_normalization_keeps_center_and_scale_stable() {
        let mut engine = EmbeddingEngine::new(64);

        let mut ids = Vec::new();
        for i in 0..16 {
            let mut v = [0.0f32; LATENT_DIM];
            v[0] = i as f32 * 0.8;
            v[1] = (i as f32).sin();
            v[2] = (i as f32).cos() * 0.5;
            ids.push(engine.insert_node(&v));
        }

        let mut effective_updates = 0usize;
        while effective_updates < GLOBAL_NORMALIZE_INTERVAL {
            let loss = engine.update_pair(ids[0], ids[1], 50.0, 0.02);
            if loss > 0.0 {
                effective_updates += 1;
            }
        }

        let mut mean = [0.0f32; LATENT_DIM];
        let mut norm_sum = 0.0f32;
        for id in &ids {
            let c = engine.get_coords_64d(*id);
            for i in 0..LATENT_DIM {
                mean[i] += c[i];
            }
            let mut sq = 0.0f32;
            for i in 0..LATENT_DIM {
                sq += c[i] * c[i];
            }
            norm_sum += sq.sqrt();
        }

        let n = ids.len() as f32;
        for i in 0..LATENT_DIM {
            mean[i] /= n;
            assert!(mean[i].abs() < 1e-3, "latent mean drift too large at dim {}: {}", i, mean[i]);
        }

        let mean_norm = norm_sum / n;
        assert!((mean_norm - 1.0).abs() < 1e-2, "mean norm should stay near 1, got {}", mean_norm);
    }
}