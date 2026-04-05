//! Core embedding engine.
//!
//! Owns:
//!   - The N×64 latent coordinate matrix  (the metric space representation)
//!   - A HNSW index for O(log N) k-NN queries
//!   - A dirty-flag HashSet for incremental sync
//!
//! All SGD operations are strictly O(1) with respect to N — only the
//! coordinates of the 2–3 involved nodes are ever written.

use ndarray::Array2;
use nalgebra::{DMatrix, DVector};
use rand::{Rng, SeedableRng};
use rand::rngs::SmallRng;
use rand::seq::SliceRandom;
use std::collections::{HashMap, HashSet, VecDeque};

use crate::distance::{l2_dist_sq, l2_dist};
use crate::hnsw::HNSWIndex;

// ── Compile-time dimension constants ─────────────────────────────────────────
pub const LATENT_DIM:  usize = 64;

// ── HNSW hyper-parameters ────────────────────────────────────────────────────
const HNSW_M:               usize = 16;
const HNSW_EF_CONSTRUCTION: usize = 200;

const KNN_EF:       usize = 60;
const NORMALIZE_EPS: f32 = 1e-6;
const REFRESH_CHECK_INTERVAL_MIN: usize = 4;
const REFRESH_CHECK_INTERVAL_MAX: usize = 64;
const DRIFT_REFRESH_THRESHOLD: f32 = 0.06;
const DRIFT_STABLE_THRESHOLD: f32 = 0.015;
const LOCAL_DRIFT_BUDGET_SOFT: f32 = 0.06;
const LOCAL_DRIFT_BUDGET_HARD: f32 = 0.12;
const HEAVY_COMP_TRIGGER_DRIFT: f32 = 0.045;
const RIGID_SVD_REG: f32 = 1e-4;
const RECOMMEND_KNN: usize = 24;
const RECOMMEND_POSITIVE_CAP: usize = 10;
const RECOMMEND_MARGIN_TARGET: f32 = 0.2;
const RECOMMEND_NEAR_MARGIN: f32 = 0.28;
const ANCHOR_PRESERVE_K: usize = 0;
const ANCHOR_PRESERVE_WEIGHT: f32 = 0.9;
const ANCHOR_PRESERVE_EPS: f32 = 1e-6;
const TANGENTIAL_PROJECTION_MAX_CONSTRAINTS: usize = 40;
const RIGID_COMP_MIN_TOUCHED: usize = 2;
const ANCHOR_SPIKE_RATIO: f32 = 1.7;
const ANCHOR_SPIKE_BOOST: f32 = 2.0;
const RIGID_ITERATIONS_DEFAULT: u32 = 1;
const RIGID_STEP_DEFAULT: f32 = 1.0;
const RIGID_AUTO_NEAR_PER_TOUCHED: usize = 2;
const RIGID_AUTO_FAR_COUNT: usize = 4;
const UPDATE_MIN_ITERS_DEFAULT: u32 = 1;
const UPDATE_MAX_ITERS_DEFAULT: u32 = 6;
const UPDATE_STABILITY_WINDOW_DEFAULT: usize = 3;
const UPDATE_STABILITY_TOLERANCE_DEFAULT: f32 = 1e-3;

// ── Output types ─────────────────────────────────────────────────────────────

/// A single node's updated state, returned by `flush_dirty_nodes`.
pub struct DirtyNode {
    pub id:         u32,
    pub coords_64d: [f32; LATENT_DIM],
}

#[derive(Clone, Copy)]
pub struct UpdateIterationOptions {
    pub learning_rate: f32,
    pub min_iters: u32,
    pub max_iters: u32,
    pub stability_window: usize,
    pub stability_tolerance: f32,
}

impl Default for UpdateIterationOptions {
    fn default() -> Self {
        Self {
            learning_rate: 0.05,
            min_iters: UPDATE_MIN_ITERS_DEFAULT,
            max_iters: UPDATE_MAX_ITERS_DEFAULT,
            stability_window: UPDATE_STABILITY_WINDOW_DEFAULT,
            stability_tolerance: UPDATE_STABILITY_TOLERANCE_DEFAULT,
        }
    }
}

impl UpdateIterationOptions {
    pub fn single_step(learning_rate: f32) -> Self {
        let mut opts = Self {
            learning_rate,
            min_iters: 1,
            max_iters: 1,
            stability_window: 1,
            stability_tolerance: 0.0,
        };
        opts.normalize_in_place();
        opts
    }

    fn normalize_in_place(&mut self) {
        if !self.learning_rate.is_finite() || self.learning_rate <= 0.0 {
            self.learning_rate = Self::default().learning_rate;
        }
        self.min_iters = self.min_iters.max(1);
        self.max_iters = self.max_iters.max(self.min_iters);
        self.stability_window = self.stability_window.max(1);
        if !self.stability_tolerance.is_finite() {
            self.stability_tolerance = Self::default().stability_tolerance;
        }
        self.stability_tolerance = self.stability_tolerance.max(0.0);
    }

    fn normalized(mut self) -> Self {
        self.normalize_in_place();
        self
    }
}

struct LossStabilityTracker {
    window: usize,
    tolerance: f32,
    recent: VecDeque<f32>,
}

impl LossStabilityTracker {
    fn new(window: usize, tolerance: f32) -> Self {
        Self {
            window,
            tolerance,
            recent: VecDeque::with_capacity(window.max(1)),
        }
    }

    fn observe(&mut self, loss: f32) -> bool {
        self.recent.push_back(loss);
        if self.recent.len() > self.window {
            self.recent.pop_front();
        }
        if self.recent.len() < self.window {
            return false;
        }

        let mut min_loss = f32::INFINITY;
        let mut max_loss = f32::NEG_INFINITY;
        for &value in &self.recent {
            min_loss = min_loss.min(value);
            max_loss = max_loss.max(value);
        }
        (max_loss - min_loss) <= self.tolerance
    }
}

#[derive(Clone)]
struct StabilityTuning {
    anchor_preserve_k: usize,
    anchor_preserve_weight: f32,
    anchor_spike_ratio: f32,
    anchor_spike_boost: f32,
    rigid_iterations: u32,
    rigid_step: f32,
    rigid_auto_near_per_touched: usize,
    rigid_auto_far_count: usize,
    rigid_manual_near_ids: Vec<u32>,
    rigid_manual_far_ids: Vec<u32>,
}

impl Default for StabilityTuning {
    fn default() -> Self {
        Self {
            anchor_preserve_k: ANCHOR_PRESERVE_K,
            anchor_preserve_weight: ANCHOR_PRESERVE_WEIGHT,
            anchor_spike_ratio: ANCHOR_SPIKE_RATIO,
            anchor_spike_boost: ANCHOR_SPIKE_BOOST,
            rigid_iterations: RIGID_ITERATIONS_DEFAULT,
            rigid_step: RIGID_STEP_DEFAULT,
            rigid_auto_near_per_touched: RIGID_AUTO_NEAR_PER_TOUCHED,
            rigid_auto_far_count: RIGID_AUTO_FAR_COUNT,
            rigid_manual_near_ids: Vec::new(),
            rigid_manual_far_ids: Vec::new(),
        }
    }
}

// ── Engine ────────────────────────────────────────────────────────────────────

pub struct EmbeddingEngine {
    /// N × 64 latent coordinates — the source of truth for all distances.
    coords:     Array2<f32>,
    /// Active-node flag per slot.
    active:     Vec<bool>,
    /// Monotonically increasing next-slot counter.
    next_id:    u32,
    /// Free-list: IDs of deleted nodes available for reuse.
    free_list:  Vec<u32>,
    /// Nodes modified since last flush.
    dirty:      HashSet<u32>,
    /// Approximate nearest-neighbor index over the 64-D space.
    ann:        HNSWIndex,
    /// Number of currently active nodes.
    n_active:   usize,
    /// Total allocated row capacity of both matrices.
    capacity:   usize,
    /// Adaptive cadence for drift checks.
    refresh_check_interval: usize,
    /// Number of finalization rounds since the last drift check.
    refresh_since_check: usize,
    /// Runtime tuning knobs for stability-preserving updates.
    tuning: StabilityTuning,
}

impl EmbeddingEngine {
    // ── Construction ─────────────────────────────────────────────────────────

    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(16);
        EmbeddingEngine {
            coords:     Array2::zeros((cap, LATENT_DIM)),
            active:     vec![false; cap],
            next_id:    0,
            free_list:  Vec::new(),
            dirty:      HashSet::new(),
            ann:        HNSWIndex::new(HNSW_M, HNSW_EF_CONSTRUCTION),
            n_active:   0,
            capacity:   cap,
            refresh_check_interval: REFRESH_CHECK_INTERVAL_MIN,
            refresh_since_check: 0,
            tuning: StabilityTuning::default(),
        }
    }

    // ── Runtime tuning ──────────────────────────────────────────────────────

    /// Configure anchor-preservation behavior.
    pub fn set_anchor_preservation_params(
        &mut self,
        k: usize,
        weight: f32,
        spike_ratio: f32,
        spike_boost: f32,
    ) {
        self.tuning.anchor_preserve_k = k;
        self.tuning.anchor_preserve_weight = weight.clamp(0.0, 1.0);
        self.tuning.anchor_spike_ratio = spike_ratio.max(1.0);
        self.tuning.anchor_spike_boost = spike_boost.max(1.0);
    }

    /// Configure iterative global rigid compensation.
    pub fn set_rigid_compensation_params(&mut self, iterations: u32, step: f32) {
        self.tuning.rigid_iterations = iterations.max(1);
        self.tuning.rigid_step = step.clamp(0.05, 1.0);
    }

    /// Configure control-point sampling for rigid compensation.
    pub fn set_rigid_control_point_params(
        &mut self,
        auto_near_per_touched: usize,
        auto_far_count: usize,
    ) {
        self.tuning.rigid_auto_near_per_touched = auto_near_per_touched;
        self.tuning.rigid_auto_far_count = auto_far_count;
    }

    /// Replace manually selected near/far control points used by rigid fitting.
    pub fn set_rigid_control_points(&mut self, near_ids: &[u32], far_ids: &[u32]) {
        self.tuning.rigid_manual_near_ids = near_ids.to_vec();
        self.tuning.rigid_manual_far_ids = far_ids.to_vec();
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
        self.refresh_check_interval = REFRESH_CHECK_INTERVAL_MIN;
        self.refresh_since_check = 0;

        self.normalize_latent_space();

        // ── Build HNSW index ──────────────────────────────────────────────
        self.rebuild_ann_index();
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
    /// - anchor-positive from near neighbors with non-trivial uncertainty
    /// - negative from slightly farther neighbors (hard but valid)
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
        options: UpdateIterationOptions,
    ) -> f32 {
        let touched_ids = [id_a, id_b, id_c];
        self.run_stabilized_update(&touched_ids, options, |engine, lr, touched| {
            let loss = engine.update_triplet_step(id_a, id_b, id_c, margin, lr);
            if loss > 0.0 {
                touched.insert(id_a);
                touched.insert(id_b);
                touched.insert(id_c);
            }
            loss
        })
    }

    /// Batch triplet updates with one deduplicated ANN/projection refresh.
    ///
    /// `triplets` format: `[a0,b0,c0,a1,b1,c1,...]`.
    pub fn update_triplets_batch_flat(
        &mut self,
        triplets: &[u32],
        margin: f32,
        options: UpdateIterationOptions,
    ) -> Result<(), &'static str> {
        if triplets.len() % 3 != 0 {
            return Err("triplets length must be multiple of 3");
        }

        let mut touched_candidates = HashSet::new();
        for chunk in triplets.chunks_exact(3) {
            touched_candidates.insert(chunk[0]);
            touched_candidates.insert(chunk[1]);
            touched_candidates.insert(chunk[2]);
        }

        let touched_vec: Vec<u32> = touched_candidates.iter().copied().collect();
        self.run_stabilized_update(&touched_vec, options, |engine, lr, touched| {
            let mut batch_loss = 0.0f32;
            for chunk in triplets.chunks_exact(3) {
                let loss = engine.update_triplet_step(chunk[0], chunk[1], chunk[2], margin, lr);
                if loss <= 0.0 {
                    continue;
                }
                batch_loss += loss;
                touched.insert(chunk[0]);
                touched.insert(chunk[1]);
                touched.insert(chunk[2]);
            }
            batch_loss
        });
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

        let w = self.tuning.anchor_preserve_weight.clamp(0.0, 1.0);
        if w > 0.0 {
            // A: loss involves AB and AC, so exclude A/B/C from preserve set.
            let mut excl_a = HashSet::new();
            excl_a.insert(id_a);
            excl_a.insert(id_b);
            excl_a.insert(id_c);

            // B: loss only involves AB, keep BC relation by excluding A/B.
            let mut excl_b = HashSet::new();
            excl_b.insert(id_a);
            excl_b.insert(id_b);

            // C: loss only involves AC, keep CB relation by excluding A/C.
            let mut excl_c = HashSet::new();
            excl_c.insert(id_a);
            excl_c.insert(id_c);

            let preserve_a = self.collect_preserve_ids_for_tangential(id_a, &excl_a);
            let preserve_b = self.collect_preserve_ids_for_tangential(id_b, &excl_b);
            let preserve_c = self.collect_preserve_ids_for_tangential(id_c, &excl_c);

            let g_a_proj = self.compute_tangential_gradient(ia, &grad_a, &preserve_a);
            let g_b_proj = self.compute_tangential_gradient(ib, &grad_b, &preserve_b);
            let g_c_proj = self.compute_tangential_gradient(ic, &grad_c, &preserve_c);

            self.apply_grad(ia, &blend_gradient(&grad_a, &g_a_proj, w), lr);
            self.apply_grad(ib, &blend_gradient(&grad_b, &g_b_proj, w), lr);
            self.apply_grad(ic, &blend_gradient(&grad_c, &g_c_proj, w), lr);
        } else {
            self.apply_grad(ia, &grad_a, lr);
            self.apply_grad(ib, &grad_b, lr);
            self.apply_grad(ic, &grad_c, lr);
        }

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
        options: UpdateIterationOptions,
    ) -> f32 {
        let touched_ids = [id_a, id_b];
        self.run_stabilized_update(&touched_ids, options, |engine, lr, touched| {
            let loss = engine.update_pair_step(id_a, id_b, target_distance, lr);
            if loss > 0.0 {
                touched.insert(id_a);
                touched.insert(id_b);
            }
            loss
        })
    }

    /// Batch pair updates with one deduplicated ANN/projection refresh.
    ///
    /// `pairs` format: `[a0,b0,a1,b1,...]`.
    pub fn update_pairs_batch_flat(
        &mut self,
        pairs: &[u32],
        target_distance: f32,
        options: UpdateIterationOptions,
    ) -> Result<(), &'static str> {
        if pairs.len() % 2 != 0 {
            return Err("pairs length must be multiple of 2");
        }

        let mut touched_candidates = HashSet::new();
        for chunk in pairs.chunks_exact(2) {
            touched_candidates.insert(chunk[0]);
            touched_candidates.insert(chunk[1]);
        }

        let touched_vec: Vec<u32> = touched_candidates.iter().copied().collect();
        self.run_stabilized_update(&touched_vec, options, |engine, lr, touched| {
            let mut batch_loss = 0.0f32;
            for chunk in pairs.chunks_exact(2) {
                let loss = engine.update_pair_step(chunk[0], chunk[1], target_distance, lr);
                if loss <= 0.0 {
                    continue;
                }
                batch_loss += loss;
                touched.insert(chunk[0]);
                touched.insert(chunk[1]);
            }
            batch_loss
        });
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

        let w = self.tuning.anchor_preserve_weight.clamp(0.0, 1.0);
        if w > 0.0 {
            let mut exclude = HashSet::new();
            exclude.insert(id_a);
            exclude.insert(id_b);

            let preserve = self.collect_preserve_ids_for_tangential(id_a, &exclude);
            let g_a_proj = self.compute_tangential_gradient(ia, &grad_a, &preserve);
            let g_b_proj = self.compute_tangential_gradient(ib, &grad_b, &preserve);

            self.apply_grad(ia, &blend_gradient(&grad_a, &g_a_proj, w), lr);
            self.apply_grad(ib, &blend_gradient(&grad_b, &g_b_proj, w), lr);
        } else {
            self.apply_grad(ia, &grad_a, lr);
            self.apply_grad(ib, &grad_b, lr);
        }

        loss
    }

    fn run_stabilized_update<F>(
        &mut self,
        touched_candidates: &[u32],
        options: UpdateIterationOptions,
        mut step: F,
    ) -> f32
    where
        F: FnMut(&mut Self, f32, &mut HashSet<u32>) -> f32,
    {
        let options = options.normalized();
        let (old_positions, sample_ids) = self.capture_rigid_context(touched_candidates);
        let mut touched = HashSet::new();

        let loss = self.run_iterative_step(options, |engine, lr| {
            step(engine, lr, &mut touched)
        });

        if touched.is_empty() {
            return 0.0;
        }

        let local_drift = self.measure_touched_delta(&old_positions, &touched);
        self.apply_global_rigid_compensation(&old_positions, &touched, &sample_ids, local_drift);
        self.finalize_touched_nodes(&touched, local_drift);

        loss.max(0.0)
    }

    fn run_iterative_step<F>(&mut self, options: UpdateIterationOptions, mut step: F) -> f32
    where
        F: FnMut(&mut Self, f32) -> f32,
    {
        let mut tracker = LossStabilityTracker::new(options.stability_window, options.stability_tolerance);
        let mut last_loss = 0.0f32;

        for iter_idx in 0..options.max_iters {
            let loss = step(self, options.learning_rate);
            last_loss = loss;

            let iter_count = iter_idx + 1;
            let reached_min_iters = iter_count >= options.min_iters;

            if loss <= 0.0 {
                if reached_min_iters {
                    break;
                }
                continue;
            }

            if reached_min_iters && tracker.observe(loss) {
                break;
            }
        }

        last_loss
    }

    // ── k-NN query (public) ───────────────────────────────────────────────────

    /// Returns up to `k` nearest neighbors as `(node_id, true_distance)` pairs.
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
            for (i, &v) in self.coords.row(idx).iter().enumerate()     { c64[i] = v; }
            out.push(DirtyNode { id, coords_64d: c64 });
        }
        out
    }

    /// Serialize dirty latent nodes to a compact little-endian byte buffer.
    ///
    /// Wire format (all values little-endian):
    /// ```text
    /// [n_dirty : u32]
    /// for each dirty node:
    ///   [id     : u32      ]  (4 bytes)
    ///   [c64    : f32 × 64 ]  (256 bytes)
    ///                          ─────────
    ///                          260 bytes per node
    /// ```
    pub fn flush_dirty_nodes_bytes(&mut self) -> Vec<u8> {
        let nodes = self.flush_dirty_nodes();
        const ENTRY: usize = 4 + LATENT_DIM * 4; // 260

        let mut buf = Vec::with_capacity(4 + nodes.len() * ENTRY);
        buf.extend_from_slice(&(nodes.len() as u32).to_le_bytes());
        for n in &nodes {
            buf.extend_from_slice(&n.id.to_le_bytes());
            for &v in &n.coords_64d { buf.extend_from_slice(&v.to_le_bytes()); }
        }
        buf
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    pub fn node_count(&self)   -> usize  { self.n_active }
    pub fn capacity(&self)     -> usize  { self.capacity }

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

    fn finalize_touched_nodes(&mut self, touched: &HashSet<u32>, local_drift: f32) {
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
            self.dirty.insert(*id);
        }

        if local_drift >= LOCAL_DRIFT_BUDGET_HARD && self.n_active >= 12 {
            self.normalize_latent_space();
            self.rebuild_ann_index();
            for id in self.active_ids() {
                self.dirty.insert(id);
            }
            self.refresh_check_interval = (self.refresh_check_interval / 2)
                .max(REFRESH_CHECK_INTERVAL_MIN);
            self.refresh_since_check = 0;
            return;
        }

        if local_drift >= LOCAL_DRIFT_BUDGET_SOFT {
            self.refresh_check_interval = self.refresh_check_interval
                .saturating_sub(1)
                .max(REFRESH_CHECK_INTERVAL_MIN);
        }

        self.refresh_since_check += 1;
        if self.refresh_since_check < self.refresh_check_interval {
            return;
        }

        self.refresh_since_check = 0;
        let (mean_offset, norm_drift) = self.measure_latent_drift();
        let drift = mean_offset.max(norm_drift);

        if drift >= DRIFT_REFRESH_THRESHOLD {
            self.normalize_latent_space();
            self.rebuild_ann_index();
            for id in self.active_ids() {
                self.dirty.insert(id);
            }
            self.refresh_check_interval = (self.refresh_check_interval / 2)
                .max(REFRESH_CHECK_INTERVAL_MIN);
        } else if drift <= DRIFT_STABLE_THRESHOLD {
            self.refresh_check_interval = (self.refresh_check_interval * 2)
                .min(REFRESH_CHECK_INTERVAL_MAX);
        }
    }

    fn measure_latent_drift(&self) -> (f32, f32) {
        if self.n_active == 0 {
            return (0.0, 0.0);
        }

        let mut mean = [0.0f32; LATENT_DIM];
        let mut norm_sum = 0.0f32;
        for idx in 0..self.capacity {
            if !self.active[idx] {
                continue;
            }
            let row = self.coords.row(idx);
            let mut sq = 0.0f32;
            for i in 0..LATENT_DIM {
                mean[i] += row[i];
                sq += row[i] * row[i];
            }
            norm_sum += sq.sqrt();
        }

        let inv_n = 1.0f32 / self.n_active as f32;
        let mut mean_sq = 0.0f32;
        for i in 0..LATENT_DIM {
            mean[i] *= inv_n;
            mean_sq += mean[i] * mean[i];
        }
        let mean_offset = mean_sq.sqrt();
        let mean_norm = norm_sum * inv_n;
        let norm_drift = (mean_norm - 1.0).abs();
        (mean_offset, norm_drift)
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

        new_coords
            .slice_mut(ndarray::s![..self.capacity, ..])
            .assign(&self.coords);

        self.coords     = new_coords;
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

    fn capture_old_positions_for_ids(
        &self,
        touched_ids: &[u32],
        out: &mut HashMap<u32, [f32; LATENT_DIM]>,
    ) {
        for &id in touched_ids {
            if out.contains_key(&id) {
                continue;
            }
            let idx = id as usize;
            if idx >= self.capacity || !self.active[idx] {
                continue;
            }
            let mut coords = [0.0f32; LATENT_DIM];
            for (i, v) in self.coords.row(idx).iter().enumerate() {
                coords[i] = *v;
            }
            out.insert(id, coords);
        }
    }

    fn capture_rigid_context(
        &self,
        touched_ids: &[u32],
    ) -> (HashMap<u32, [f32; LATENT_DIM]>, Vec<u32>) {
        let sample_ids = self.collect_rigid_sample_ids(touched_ids);
        let mut map = HashMap::with_capacity(touched_ids.len() + sample_ids.len());
        self.capture_old_positions_for_ids(touched_ids, &mut map);
        self.capture_old_positions_for_ids(&sample_ids, &mut map);
        (map, sample_ids)
    }

    fn collect_rigid_sample_ids(&self, touched_ids: &[u32]) -> Vec<u32> {
        let touched: HashSet<u32> = touched_ids.iter().copied().collect();
        let mut selected = Vec::new();
        let mut seen = HashSet::new();

        for &id in &self.tuning.rigid_manual_near_ids {
            let idx = id as usize;
            if idx < self.capacity && self.active[idx] && !touched.contains(&id) && seen.insert(id) {
                selected.push(id);
            }
        }

        for &id in &self.tuning.rigid_manual_far_ids {
            let idx = id as usize;
            if idx < self.capacity && self.active[idx] && !touched.contains(&id) && seen.insert(id) {
                selected.push(id);
            }
        }

        if self.tuning.rigid_auto_near_per_touched > 0 {
            for &id in touched_ids {
                let idx = id as usize;
                if idx >= self.capacity || !self.active[idx] {
                    continue;
                }
                let query_row: Vec<f32> = self.coords.row(idx).to_vec();
                let candidates = self.ann.knn_search(
                    &query_row,
                    self.tuning.rigid_auto_near_per_touched + 1,
                    KNN_EF,
                    &self.coords,
                );
                for (n_id, _) in candidates {
                    let n_idx = n_id as usize;
                    if n_idx >= self.capacity || !self.active[n_idx] || touched.contains(&n_id) {
                        continue;
                    }
                    if seen.insert(n_id) {
                        selected.push(n_id);
                    }
                    if selected.len() >= self.tuning.rigid_auto_near_per_touched * touched_ids.len()
                        + self.tuning.rigid_manual_near_ids.len()
                        + self.tuning.rigid_manual_far_ids.len()
                    {
                        break;
                    }
                }
            }
        }

        if self.tuning.rigid_auto_far_count > 0 {
            let mut active_ids = self.active_ids();
            let mut rng = SmallRng::seed_from_u64(0xA11CEu64 ^ (touched_ids.len() as u64));
            active_ids.shuffle(&mut rng);
            for id in active_ids {
                if touched.contains(&id) {
                    continue;
                }
                if seen.insert(id) {
                    selected.push(id);
                }
                if selected.len() >= self.tuning.rigid_manual_near_ids.len()
                    + self.tuning.rigid_manual_far_ids.len()
                    + self.tuning.rigid_auto_near_per_touched * touched_ids.len()
                    + self.tuning.rigid_auto_far_count
                {
                    break;
                }
            }
        }

        selected
    }

    /// Returns preserve-node ids for tangential projection.
    ///
    /// If available nodes are fewer than the selected cap, return all available
    /// nodes; otherwise, use nearest neighbors for bounded projection cost.
    fn collect_preserve_ids_for_tangential(
        &self,
        query_node: u32,
        exclude_set: &HashSet<u32>,
    ) -> Vec<u32> {
        let max_k = if self.tuning.anchor_preserve_k > 0
            && self.tuning.anchor_preserve_k < TANGENTIAL_PROJECTION_MAX_CONSTRAINTS
        {
            self.tuning.anchor_preserve_k
        } else {
            TANGENTIAL_PROJECTION_MAX_CONSTRAINTS
        };

        let self_excluded = exclude_set.contains(&query_node);
        let available = self
            .n_active
            .saturating_sub(exclude_set.len() + if self_excluded { 0 } else { 1 });

        if available <= max_k {
            let mut ids = Vec::with_capacity(available);
            for idx in 0..self.capacity {
                if self.active[idx] {
                    let id = idx as u32;
                    if id != query_node && !exclude_set.contains(&id) {
                        ids.push(id);
                    }
                }
            }
            return ids;
        }

        let qidx = query_node as usize;
        if qidx >= self.capacity || !self.active[qidx] {
            return Vec::new();
        }
        let query_row: Vec<f32> = self.coords.row(qidx).to_vec();
        let candidates = self.ann.knn_search(
            &query_row,
            max_k + exclude_set.len() + 4,
            KNN_EF,
            &self.coords,
        );

        let mut ids = Vec::with_capacity(max_k);
        for (n_id, _) in candidates {
            if n_id == query_node || exclude_set.contains(&n_id) {
                continue;
            }
            let n_idx = n_id as usize;
            if n_idx < self.capacity && self.active[n_idx] {
                ids.push(n_id);
                if ids.len() >= max_k {
                    break;
                }
            }
        }
        ids
    }

    /// Projects `grad` into the tangential subspace at node `idx` so that the
    /// first-order distance change to `preserve_ids` is zero.
    fn compute_tangential_gradient(
        &self,
        idx: usize,
        grad: &[f32],
        preserve_ids: &[u32],
    ) -> Vec<f32> {
        let mut g = grad.to_vec();
        if preserve_ids.is_empty() {
            return g;
        }

        let xi = self.coords.row(idx);
        for &pid in preserve_ids {
            let pidx = pid as usize;
            if pidx >= self.capacity || !self.active[pidx] || pidx == idx {
                continue;
            }

            let xp = self.coords.row(pidx);
            let mut diff = [0.0f32; LATENT_DIM];
            let mut len_sq = 0.0f32;
            for d in 0..LATENT_DIM {
                diff[d] = xi[d] - xp[d];
                len_sq += diff[d] * diff[d];
            }
            if len_sq < ANCHOR_PRESERVE_EPS * ANCHOR_PRESERVE_EPS {
                continue;
            }

            let gdot: f32 = g.iter().zip(diff.iter()).map(|(gi, di)| gi * di).sum();
            let scale = gdot / len_sq;
            for d in 0..LATENT_DIM {
                g[d] -= scale * diff[d];
            }
        }

        g
    }

    fn measure_touched_delta(
        &self,
        old_positions: &HashMap<u32, [f32; LATENT_DIM]>,
        touched: &HashSet<u32>,
    ) -> f32 {
        if touched.is_empty() {
            return 0.0;
        }

        let mut acc = 0.0f32;
        let mut n = 0usize;
        for id in touched {
            let idx = *id as usize;
            let Some(old) = old_positions.get(id) else {
                continue;
            };
            if idx >= self.capacity || !self.active[idx] {
                continue;
            }
            let now = self.coords.row(idx);
            let mut sq = 0.0f32;
            for d in 0..LATENT_DIM {
                let delta = now[d] - old[d];
                sq += delta * delta;
            }
            acc += sq.sqrt();
            n += 1;
        }
        if n == 0 {
            0.0
        } else {
            acc / n as f32
        }
    }

    fn apply_global_rigid_compensation(
        &mut self,
        old_positions: &HashMap<u32, [f32; LATENT_DIM]>,
        touched: &HashSet<u32>,
        sample_ids: &[u32],
        local_drift: f32,
    ) {
        if touched.len() < RIGID_COMP_MIN_TOUCHED {
            return;
        }

        // Default to light mode: only run expensive rigid fitting when local
        // displacement is large enough to justify global compensation.
        if local_drift < HEAVY_COMP_TRIGGER_DRIFT {
            return;
        }

        let mut touched_new = HashMap::with_capacity(touched.len());
        let mut fit_ids = Vec::with_capacity(touched.len() + sample_ids.len());
        for &id in touched {
            let idx = id as usize;
            let Some(_old) = old_positions.get(&id) else {
                continue;
            };
            if idx >= self.capacity || !self.active[idx] {
                continue;
            }
            let mut now = [0.0f32; LATENT_DIM];
            for (i, v) in self.coords.row(idx).iter().enumerate() {
                now[i] = *v;
            }
            touched_new.insert(id, now);
            fit_ids.push(id);
        }

        for &id in sample_ids {
            if touched.contains(&id) {
                continue;
            }
            let idx = id as usize;
            if idx >= self.capacity || !self.active[idx] || !old_positions.contains_key(&id) {
                continue;
            }
            fit_ids.push(id);
        }

        if fit_ids.len() < RIGID_COMP_MIN_TOUCHED {
            return;
        }

        let iterations = self.tuning.rigid_iterations.max(1);
        let drift_step_scale = (local_drift / LOCAL_DRIFT_BUDGET_SOFT).clamp(0.35, 1.0);
        let step = (self.tuning.rigid_step * drift_step_scale).clamp(0.05, 1.0);

        for _ in 0..iterations {
            let mut old_mean = [0.0f32; LATENT_DIM];
            let mut new_mean = [0.0f32; LATENT_DIM];
            let inv_n = 1.0f32 / fit_ids.len() as f32;

            for &id in &fit_ids {
                let idx = id as usize;
                let Some(old) = old_positions.get(&id) else {
                    continue;
                };
                let now = self.coords.row(idx);
                for d in 0..LATENT_DIM {
                    old_mean[d] += old[d];
                    new_mean[d] += now[d];
                }
            }
            for d in 0..LATENT_DIM {
                old_mean[d] *= inv_n;
                new_mean[d] *= inv_n;
            }

            let mut cov = DMatrix::<f32>::zeros(LATENT_DIM, LATENT_DIM);
            for &id in &fit_ids {
                let idx = id as usize;
                let Some(old) = old_positions.get(&id) else {
                    continue;
                };
                let now = self.coords.row(idx);
                for r in 0..LATENT_DIM {
                    let xo = old[r] - old_mean[r];
                    for c in 0..LATENT_DIM {
                        cov[(r, c)] += xo * (now[c] - new_mean[c]);
                    }
                }
            }
            for i in 0..LATENT_DIM {
                cov[(i, i)] += RIGID_SVD_REG;
            }

            let svd = cov.svd(true, true);
            let (Some(u), Some(v_t)) = (svd.u, svd.v_t) else {
                return;
            };

            let mut v = v_t.transpose();
            let u_t = u.transpose();
            let mut r_mat = &v * &u_t;
            if r_mat.determinant() < 0.0 {
                let last_col = LATENT_DIM - 1;
                for row in 0..LATENT_DIM {
                    v[(row, last_col)] *= -1.0;
                }
                r_mat = &v * &u_t;
            }

            let old_mean_vec = DVector::from_column_slice(&old_mean);
            let new_mean_vec = DVector::from_column_slice(&new_mean);
            let t_vec = &new_mean_vec - (&r_mat * old_mean_vec);

            for idx in 0..self.capacity {
                if !self.active[idx] {
                    continue;
                }
                let mut x = DVector::<f32>::zeros(LATENT_DIM);
                for d in 0..LATENT_DIM {
                    x[d] = self.coords[[idx, d]];
                }
                let y = &r_mat * x + &t_vec;
                for d in 0..LATENT_DIM {
                    self.coords[[idx, d]] += step * (y[d] - self.coords[[idx, d]]);
                }
            }

            // Keep task semantics exact on touched nodes at every iteration.
            for (id, coords) in &touched_new {
                let idx = *id as usize;
                if idx >= self.capacity || !self.active[idx] {
                    continue;
                }
                for d in 0..LATENT_DIM {
                    self.coords[[idx, d]] = coords[d];
                }
            }
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

#[inline]
fn blend_gradient(orig: &[f32], projected: &[f32], weight: f32) -> Vec<f32> {
    orig.iter()
        .zip(projected.iter())
        .map(|(o, p)| (1.0 - weight) * o + weight * p)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axis_vec(axis: usize, value: f32) -> [f32; LATENT_DIM] {
        let mut v = [0.0f32; LATENT_DIM];
        v[axis] = value;
        v
    }

    fn fixture_coords() -> Vec<[f32; LATENT_DIM]> {
        let mut pts = Vec::new();

        // Two touched points.
        pts.push(axis_vec(0, 0.0));
        pts.push(axis_vec(0, 0.35));

        // Near neighborhood around touched points.
        for i in 0..8 {
            let mut v = [0.0f32; LATENT_DIM];
            v[0] = 0.15 + i as f32 * 0.06;
            v[1] = (i as f32 * 0.4).sin() * 0.03;
            pts.push(v);
        }

        // Mid/far points for global reference.
        for i in 0..8 {
            let mut v = [0.0f32; LATENT_DIM];
            v[0] = if i % 2 == 0 { 6.0 + i as f32 } else { -6.0 - i as f32 };
            v[1] = (i as f32 * 0.2).cos() * 0.2;
            pts.push(v);
        }

        pts
    }

    fn build_engine_from_fixture() -> EmbeddingEngine {
        let mut engine = EmbeddingEngine::new(64);
        for p in fixture_coords() {
            engine.insert_node(&p);
        }
        engine
    }

    fn capture_distances(engine: &EmbeddingEngine, src: u32, dsts: &[u32]) -> Vec<f32> {
        let src_row = engine.coords.row(src as usize);
        dsts.iter()
            .map(|id| l2_dist(src_row, engine.coords.row(*id as usize)))
            .collect()
    }

    fn max_spike_ratio(before: &[f32], after: &[f32]) -> f32 {
        before.iter().zip(after.iter()).fold(1.0f32, |acc, (b, a)| {
            let base = b.max(1e-6);
            acc.max(a / base)
        })
    }

    fn mean_abs_delta(before: &[f32], after: &[f32]) -> f32 {
        if before.is_empty() {
            return 0.0;
        }
        before
            .iter()
            .zip(after.iter())
            .map(|(b, a)| (a - b).abs())
            .sum::<f32>()
            / before.len() as f32
    }

    fn max_abs_delta(before: &[f32], after: &[f32]) -> f32 {
        before
            .iter()
            .zip(after.iter())
            .map(|(b, a)| (a - b).abs())
            .fold(0.0f32, f32::max)
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

        let _ = engine.update_pair(id_a, id_b, 1.0, UpdateIterationOptions::single_step(0.1));
        let dist_after_pull = {
            let a = engine.get_coords_64d(id_a);
            let b = engine.get_coords_64d(id_b);
            (a[0] - b[0]).abs()
        };
        assert!(dist_after_pull < dist_before, "pull should decrease pair distance");

        let _ = engine.update_pair(id_a, id_b, 6.0, UpdateIterationOptions::single_step(0.1));
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
            let loss = engine.update_triplet(id_a, id_b, id_c, 0.2, UpdateIterationOptions::single_step(0.05));
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

        let _ = engine.update_pair(id_a, id_b, 1.0, UpdateIterationOptions::single_step(0.1));

        let mut dirty = engine.flush_dirty_nodes();
        dirty.sort_by_key(|n| n.id);

        let ids: Vec<u32> = dirty.iter().map(|n| n.id).collect();
        assert_eq!(ids, vec![id_a, id_b, id_c], "insertions + pair update should mark touched nodes dirty");
        for node in &dirty {
            assert!(node.coords_64d.iter().all(|v| v.is_finite()));
        }
        assert_eq!(engine.flush_dirty_nodes().len(), 0, "flush should clear dirty set");
    }

    #[test]
    fn adaptive_global_normalization_keeps_center_and_scale_stable() {
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
        while effective_updates < 24 {
            let loss = engine.update_pair(ids[0], ids[1], 50.0, UpdateIterationOptions::single_step(0.02));
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
        let mut mean_sq = 0.0f32;
        for i in 0..LATENT_DIM {
            mean[i] /= n;
            mean_sq += mean[i] * mean[i];
        }
        let mean_offset = mean_sq.sqrt();
        assert!(
            mean_offset < 0.035,
            "latent centroid drift too large: {}",
            mean_offset
        );

        let mean_norm = norm_sum / n;
        assert!(
            (mean_norm - 1.0).abs() < 0.05,
            "mean norm should stay bounded near 1, got {}",
            mean_norm
        );
    }

    #[test]
    fn tuning_reduces_single_point_distance_spikes_with_manual_controls() {
        let mut baseline = build_engine_from_fixture();
        let mut tuned = build_engine_from_fixture();

        let id_a = 0u32;
        let id_b = 1u32;
        let near_ids: Vec<u32> = (2u32..10u32).collect();
        let far_ids: Vec<u32> = (10u32..18u32).collect();

        let before = capture_distances(&baseline, id_b, &near_ids);

        baseline.set_anchor_preservation_params(4, 0.0, 2.0, 1.0);
        baseline.set_rigid_compensation_params(1, 1.0);
        baseline.set_rigid_control_point_params(0, 0);
        baseline.set_rigid_control_points(&[], &[]);
        let _ = baseline.update_pair(id_a, id_b, 6.0, UpdateIterationOptions::single_step(0.08));
        let baseline_after = capture_distances(&baseline, id_b, &near_ids);
        let baseline_spike = max_spike_ratio(&before, &baseline_after);

        tuned.set_anchor_preservation_params(24, 0.45, 1.3, 3.0);
        tuned.set_rigid_compensation_params(3, 0.45);
        tuned.set_rigid_control_point_params(2, 2);
        tuned.set_rigid_control_points(&near_ids[..4], &far_ids[..4]);
        let _ = tuned.update_pair(id_a, id_b, 6.0, UpdateIterationOptions::single_step(0.08));
        let tuned_after = capture_distances(&tuned, id_b, &near_ids);
        let tuned_spike = max_spike_ratio(&before, &tuned_after);

        assert!(
            tuned_spike < baseline_spike,
            "tuned config should reduce worst single-point spike: tuned={} baseline={}",
            tuned_spike,
            baseline_spike
        );
    }

    #[test]
    fn tangential_projection_significantly_reduces_external_distance_drift() {
        let mut baseline = build_engine_from_fixture();
        let mut projected = build_engine_from_fixture();

        let id_a = 0u32;
        let id_b = 1u32;
        let observer_ids: Vec<u32> = (2u32..18u32).collect();

        let before = capture_distances(&baseline, id_b, &observer_ids);

        baseline.set_anchor_preservation_params(0, 0.0, 1.0, 1.0);
        baseline.set_rigid_compensation_params(1, 1.0);
        baseline.set_rigid_control_point_params(0, 0);
        baseline.set_rigid_control_points(&[], &[]);
        let _ = baseline.update_pair(id_a, id_b, 6.0, UpdateIterationOptions::single_step(0.08));
        let baseline_after = capture_distances(&baseline, id_b, &observer_ids);
        let baseline_mean = mean_abs_delta(&before, &baseline_after);

        projected.set_anchor_preservation_params(0, 1.0, 1.0, 1.0);
        projected.set_rigid_compensation_params(1, 1.0);
        projected.set_rigid_control_point_params(0, 0);
        projected.set_rigid_control_points(&[], &[]);
        let _ = projected.update_pair(id_a, id_b, 6.0, UpdateIterationOptions::single_step(0.08));
        let projected_after = capture_distances(&projected, id_b, &observer_ids);
        let projected_mean = mean_abs_delta(&before, &projected_after);

        assert!(
            projected_mean < baseline_mean * 0.25,
            "tangential projection should reduce external drift strongly: projected={} baseline={}",
            projected_mean,
            baseline_mean
        );
    }

    #[test]
    fn iterative_rigid_compensation_improves_external_drift_metrics() {
        let mut single_step = build_engine_from_fixture();
        let mut multi_step = build_engine_from_fixture();

        let id_a = 0u32;
        let id_b = 1u32;
        let reference_ids: Vec<u32> = (2u32..18u32).collect();

        let before = capture_distances(&single_step, id_a, &reference_ids);

        single_step.set_anchor_preservation_params(16, 0.25, 1.5, 2.0);
        single_step.set_rigid_compensation_params(1, 1.0);
        single_step.set_rigid_control_point_params(1, 2);
        single_step.set_rigid_control_points(&reference_ids[..3], &reference_ids[10..13]);
        let _ = single_step.update_pair(id_a, id_b, 6.5, UpdateIterationOptions::single_step(0.07));
        let after_single = capture_distances(&single_step, id_a, &reference_ids);
        let drift_single = mean_abs_delta(&before, &after_single);
        let max_single = max_abs_delta(&before, &after_single);

        multi_step.set_anchor_preservation_params(16, 0.3, 1.4, 2.2);
        multi_step.set_rigid_compensation_params(4, 0.5);
        multi_step.set_rigid_control_point_params(1, 2);
        multi_step.set_rigid_control_points(&reference_ids[..3], &reference_ids[10..13]);
        let _ = multi_step.update_pair(id_a, id_b, 6.5, UpdateIterationOptions::single_step(0.07));
        let after_multi = capture_distances(&multi_step, id_a, &reference_ids);
        let drift_multi = mean_abs_delta(&before, &after_multi);
        let max_multi = max_abs_delta(&before, &after_multi);

        assert!(
            max_multi < max_single,
            "iterative rigid compensation should reduce worst-case external drift: multi={} single={}",
            max_multi,
            max_single
        );
        assert!(
            drift_multi <= drift_single + 0.05,
            "iterative rigid compensation should not regress mean drift materially: multi={} single={}",
            drift_multi,
            drift_single
        );
    }
}