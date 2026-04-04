use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};

use crate::engine::{DirtyNode, LATENT_DIM};

pub const PROJ_DIM: usize = 2;

const FULL_FIT_EPOCHS: usize = 24;
const FULL_REFIT_EPOCHS: usize = 10;
const INCREMENTAL_EPOCHS: usize = 6;
const BASE_LR: f32 = 0.0022;
const L2_REG: f32 = 5e-5;
const REPLAY_CAP: usize = 96;
const CALIBRATION_EPS: f32 = 1e-6;
const CALIBRATION_SAMPLE_CAP: usize = 512;
const CALIBRATION_EMA_ALPHA: f32 = 0.18;
const RANK_CONSISTENCY_MARGIN: f32 = 0.02;
const RANK_CONSISTENCY_WEIGHT: f32 = 1.0;
const RANK_STEPS_PER_EPOCH: usize = 128;
const PAIR_DIST_STEPS_PER_EPOCH: usize = 64;
const PAIR_DIST_WEIGHT: f32 = 0.5;

pub struct AutoencoderProjector {
    encoder: [[f32; LATENT_DIM]; PROJ_DIM],
    decoder: [[f32; PROJ_DIM]; LATENT_DIM],
    coords_by_id: Vec<Option<[f32; LATENT_DIM]>>,
    active_ids_cache: Vec<usize>,
    active_ids_dirty: bool,
    active_count: usize,
    rng: SmallRng,
    proj_center: [f32; PROJ_DIM],
    proj_median_radius: f32,
    proj_p90_radius: f32,
}

impl AutoencoderProjector {
    pub fn new(capacity: usize) -> Self {
        let mut rng = SmallRng::seed_from_u64(0xC0FFEE42);
        let mut encoder = [[0.0f32; LATENT_DIM]; PROJ_DIM];
        let mut decoder = [[0.0f32; PROJ_DIM]; LATENT_DIM];

        for k in 0..PROJ_DIM {
            for i in 0..LATENT_DIM {
                encoder[k][i] = rng.gen_range(-0.02f32..0.02f32);
                decoder[i][k] = encoder[k][i];
            }
        }

        Self {
            encoder,
            decoder,
            coords_by_id: vec![None; capacity.max(16)],
            active_ids_cache: Vec::new(),
            active_ids_dirty: true,
            active_count: 0,
            rng,
            proj_center: [0.0; PROJ_DIM],
            proj_median_radius: 1.0,
            proj_p90_radius: 1.0,
        }
    }

    pub fn hydrate_from_flat(&mut self, data: &[f32], n_nodes: usize) {
        self.ensure_capacity(n_nodes);
        for slot in self.coords_by_id.iter_mut() {
            *slot = None;
        }

        for i in 0..n_nodes {
            let mut sample = [0.0f32; LATENT_DIM];
            let base = i * LATENT_DIM;
            for d in 0..LATENT_DIM {
                sample[d] = data[base + d];
            }
            self.coords_by_id[i] = Some(sample);
        }
        self.active_count = n_nodes;
        self.active_ids_dirty = true;

        self.train_full(FULL_FIT_EPOCHS);
        self.refresh_projection_calibration();
    }

    pub fn upsert(&mut self, id: u32, coords_64d: &[f32; LATENT_DIM]) {
        let idx = id as usize;
        self.ensure_capacity(idx + 1);
        if self.coords_by_id[idx].is_none() {
            self.active_count += 1;
        }
        self.coords_by_id[idx] = Some(*coords_64d);
        self.active_ids_dirty = true;

        let changed = [id];
        self.train_incremental(&changed, INCREMENTAL_EPOCHS);
        self.refresh_projection_calibration();
    }

    pub fn remove(&mut self, id: u32) {
        let idx = id as usize;
        if idx >= self.coords_by_id.len() {
            return;
        }
        if self.coords_by_id[idx].take().is_some() {
            self.active_count = self.active_count.saturating_sub(1);
            self.active_ids_dirty = true;
        }
        self.refresh_projection_calibration();
    }

    pub fn apply_incremental_dirty(&mut self, dirty: &[DirtyNode]) {
        if dirty.is_empty() {
            return;
        }

        let mut changed_ids = Vec::with_capacity(dirty.len());
        for node in dirty {
            let idx = node.id as usize;
            self.ensure_capacity(idx + 1);
            if self.coords_by_id[idx].is_none() {
                self.active_count += 1;
            }
            self.coords_by_id[idx] = Some(node.coords_64d);
            changed_ids.push(node.id);
        }
        self.active_ids_dirty = true;

        let full_refit_threshold = (self.active_count / 3).max(32);
        if changed_ids.len() >= full_refit_threshold {
            self.train_full(FULL_REFIT_EPOCHS);
            self.refresh_projection_calibration();
            return;
        }

        self.train_incremental(&changed_ids, INCREMENTAL_EPOCHS);
        self.refresh_projection_calibration();
    }

    pub fn projection_for_id(&self, id: u32) -> [f32; PROJ_DIM] {
        let idx = id as usize;
        let Some(Some(coords)) = self.coords_by_id.get(idx) else {
            return [0.0, 0.0];
        };
        self.calibrate(self.encode(coords))
    }

    fn ensure_capacity(&mut self, required: usize) {
        if required <= self.coords_by_id.len() {
            return;
        }
        let mut next = self.coords_by_id.len().max(16);
        while next < required {
            next *= 2;
        }
        self.coords_by_id.resize(next, None);
    }

    fn active_ids(&mut self) -> &[usize] {
        if !self.active_ids_dirty {
            return &self.active_ids_cache;
        }

        self.active_ids_cache.clear();
        self.active_ids_cache.reserve(self.active_count);
        for (idx, sample) in self.coords_by_id.iter().enumerate() {
            if sample.is_some() {
                self.active_ids_cache.push(idx);
            }
        }
        self.active_ids_dirty = false;
        &self.active_ids_cache
    }

    fn encode(&self, x: &[f32; LATENT_DIM]) -> [f32; PROJ_DIM] {
        let mut z = [0.0f32; PROJ_DIM];
        for k in 0..PROJ_DIM {
            let mut acc = 0.0f32;
            for i in 0..LATENT_DIM {
                acc += self.encoder[k][i] * x[i];
            }
            z[k] = acc;
        }
        z
    }

    fn calibrate(&self, z: [f32; PROJ_DIM]) -> [f32; PROJ_DIM] {
        let scale = 1.0 / self.proj_p90_radius.max(CALIBRATION_EPS);
        [
            (z[0] - self.proj_center[0]) * scale,
            (z[1] - self.proj_center[1]) * scale,
        ]
    }

    fn refresh_projection_calibration(&mut self) {
        if self.active_count == 0 {
            self.proj_center = [0.0, 0.0];
            self.proj_median_radius = 1.0;
            self.proj_p90_radius = 1.0;
            return;
        }

        let mut sum_x = 0.0f32;
        let mut sum_y = 0.0f32;
        let mut projected = Vec::with_capacity(self.active_count);
        for sample in self.coords_by_id.iter().flatten() {
            let z = self.encode(sample);
            sum_x += z[0];
            sum_y += z[1];
            projected.push(z);
        }

        if projected.is_empty() {
            self.proj_center = [0.0, 0.0];
            self.proj_median_radius = 1.0;
            self.proj_p90_radius = 1.0;
            return;
        }

        let inv_n = 1.0 / projected.len() as f32;
        let new_center = [sum_x * inv_n, sum_y * inv_n];

        let mut radii = Vec::with_capacity(projected.len());
        for z in &projected {
            let dx = z[0] - new_center[0];
            let dy = z[1] - new_center[1];
            radii.push((dx * dx + dy * dy).sqrt());
        }

        if radii.is_empty() {
            self.proj_center = [0.0, 0.0];
            self.proj_median_radius = 1.0;
            self.proj_p90_radius = 1.0;
            return;
        }

        let mut sample = if radii.len() <= CALIBRATION_SAMPLE_CAP {
            radii
        } else {
            let step = (radii.len() / CALIBRATION_SAMPLE_CAP).max(1);
            let mut sampled = Vec::with_capacity(CALIBRATION_SAMPLE_CAP);
            let offset = self.rng.gen_range(0..step);
            let mut idx = offset;
            while idx < radii.len() && sampled.len() < CALIBRATION_SAMPLE_CAP {
                sampled.push(radii[idx]);
                idx += step;
            }
            sampled
        };

        sample.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mid = sample.len() / 2;
        let p90_idx = ((sample.len() as f32) * 0.9).floor() as usize;
        let median = sample[mid].max(CALIBRATION_EPS);
        let p90 = sample[p90_idx.min(sample.len() - 1)]
            .max(median)
            .max(CALIBRATION_EPS);

        let alpha = if projected.len() < 32 {
            1.0
        } else {
            CALIBRATION_EMA_ALPHA
        };
        self.proj_center[0] = self.proj_center[0] * (1.0 - alpha) + new_center[0] * alpha;
        self.proj_center[1] = self.proj_center[1] * (1.0 - alpha) + new_center[1] * alpha;
        self.proj_median_radius =
            (self.proj_median_radius * (1.0 - alpha) + median * alpha).max(CALIBRATION_EPS);
        self.proj_p90_radius = (self.proj_p90_radius * (1.0 - alpha) + p90 * alpha)
            .max(self.proj_median_radius)
            .max(CALIBRATION_EPS);
    }

    fn train_full(&mut self, epochs: usize) {
        let samples = self.active_samples();
        if samples.is_empty() {
            return;
        }

        for _ in 0..epochs {
            for x in &samples {
                self.train_one(x, BASE_LR);
            }
            self.train_rank_consistency_epoch(&samples, BASE_LR);
            self.train_pairwise_distance_epoch(&samples, BASE_LR);
        }

        self.orthogonalize_encoder();
    }

    fn train_incremental(&mut self, changed_ids: &[u32], epochs: usize) {
        if changed_ids.is_empty() {
            return;
        }

        let mut batch: Vec<[f32; LATENT_DIM]> = Vec::with_capacity(changed_ids.len() + REPLAY_CAP);
        for &id in changed_ids {
            let idx = id as usize;
            if let Some(Some(sample)) = self.coords_by_id.get(idx) {
                batch.push(*sample);
            }
        }

        let replay = self.sample_replay(REPLAY_CAP);
        batch.extend(replay);

        if batch.is_empty() {
            return;
        }

        let global_samples = self.active_samples();

        for _ in 0..epochs {
            for x in &batch {
                self.train_one(x, BASE_LR * 0.8);
            }
            self.train_rank_consistency_epoch(&global_samples, BASE_LR * 0.8);
            self.train_pairwise_distance_epoch(&global_samples, BASE_LR * 0.8);
        }
    }

    fn active_samples(&self) -> Vec<[f32; LATENT_DIM]> {
        let mut out = Vec::with_capacity(self.active_count);
        for sample in self.coords_by_id.iter().flatten() {
            out.push(*sample);
        }
        out
    }

    fn sample_replay(&mut self, cap: usize) -> Vec<[f32; LATENT_DIM]> {
        if self.active_count == 0 || cap == 0 {
            return Vec::new();
        }

        let active_ids = self.active_ids().to_vec();

        if active_ids.is_empty() {
            return Vec::new();
        }

        let mut weights = Vec::with_capacity(active_ids.len());
        let mut weight_sum = 0.0f32;
        for idx in &active_ids {
            let Some(sample) = self.coords_by_id[*idx] else {
                continue;
            };
            let z = self.encode(&sample);
            let r = (z[0] * z[0] + z[1] * z[1]).sqrt();
            let boundary = (r - self.proj_median_radius).abs().min(2.2);
            let weight = 1.0 + boundary * 1.4;
            weights.push(weight);
            weight_sum += weight;
        }

        if weights.is_empty() || weight_sum <= CALIBRATION_EPS {
            return Vec::new();
        }

        let take = cap.min(active_ids.len());
        let mut out = Vec::with_capacity(take);
        for _ in 0..take {
            let mut needle = self.rng.gen_range(0.0f32..weight_sum);
            let mut picked = 0usize;
            for (i, w) in weights.iter().enumerate() {
                needle -= *w;
                if needle <= 0.0 {
                    picked = i;
                    break;
                }
            }
            let idx = active_ids[picked.min(active_ids.len() - 1)];
            if let Some(sample) = self.coords_by_id[idx] {
                out.push(sample);
            }
        }
        out
    }

    fn train_rank_consistency_epoch(&mut self, batch: &[[f32; LATENT_DIM]], lr: f32) {
        if batch.len() < 3 {
            return;
        }

        let steps = RANK_STEPS_PER_EPOCH.min(batch.len() * (batch.len() - 1));
        for _ in 0..steps {
            let a = self.rng.gen_range(0..batch.len());
            let mut b = self.rng.gen_range(0..batch.len());
            while b == a {
                b = self.rng.gen_range(0..batch.len());
            }
            let mut c = self.rng.gen_range(0..batch.len());
            while c == a || c == b {
                c = self.rng.gen_range(0..batch.len());
            }

            let x_a = &batch[a];
            let x_b = &batch[b];
            let x_c = &batch[c];

            let d_ab_64 = l2_sq_64(x_a, x_b);
            let d_ac_64 = l2_sq_64(x_a, x_c);
            if (d_ab_64 - d_ac_64).abs() <= 1e-8 {
                continue;
            }

            if d_ab_64 < d_ac_64 {
                self.train_rank_consistency_step(x_a, x_b, x_c, lr * RANK_CONSISTENCY_WEIGHT);
            } else {
                self.train_rank_consistency_step(x_a, x_c, x_b, lr * RANK_CONSISTENCY_WEIGHT);
            }
        }
    }

    fn train_rank_consistency_step(
        &mut self,
        anchor: &[f32; LATENT_DIM],
        near: &[f32; LATENT_DIM],
        far: &[f32; LATENT_DIM],
        lr: f32,
    ) {
        let z_a = self.encode(anchor);
        let z_n = self.encode(near);
        let z_f = self.encode(far);

        let d_an_sq = l2_sq_2d(&z_a, &z_n);
        let d_af_sq = l2_sq_2d(&z_a, &z_f);
        let loss = d_an_sq - d_af_sq + RANK_CONSISTENCY_MARGIN;
        if loss <= 0.0 {
            return;
        }

        let mut g_a = [0.0f32; PROJ_DIM];
        let mut g_n = [0.0f32; PROJ_DIM];
        let mut g_f = [0.0f32; PROJ_DIM];
        for k in 0..PROJ_DIM {
            g_a[k] = 2.0 * (z_f[k] - z_n[k]);
            g_n[k] = 2.0 * (z_n[k] - z_a[k]);
            g_f[k] = -2.0 * (z_f[k] - z_a[k]);
        }

        for k in 0..PROJ_DIM {
            for i in 0..LATENT_DIM {
                let grad = g_a[k] * anchor[i]
                    + g_n[k] * near[i]
                    + g_f[k] * far[i]
                    + L2_REG * self.encoder[k][i];
                self.encoder[k][i] -= lr * grad;
            }
        }
    }

    fn train_pairwise_distance_epoch(&mut self, samples: &[[f32; LATENT_DIM]], lr: f32) {
        if samples.len() < 2 {
            return;
        }

        let n_est = 8usize.min(samples.len());
        let mut sum_2d = 0.0f32;
        let mut sum_64 = 0.0f32;
        for _ in 0..n_est {
            let i = self.rng.gen_range(0..samples.len());
            let j = {
                let mut j = self.rng.gen_range(0..samples.len());
                while j == i {
                    j = self.rng.gen_range(0..samples.len());
                }
                j
            };
            sum_64 += l2_sq_64(&samples[i], &samples[j]).sqrt();
            let zi = self.encode(&samples[i]);
            let zj = self.encode(&samples[j]);
            sum_2d += l2_sq_2d(&zi, &zj).sqrt();
        }
        let target_scale = sum_2d / sum_64.max(CALIBRATION_EPS);

        let steps = PAIR_DIST_STEPS_PER_EPOCH.min(samples.len() * (samples.len() - 1));
        for _ in 0..steps {
            let i = self.rng.gen_range(0..samples.len());
            let j = {
                let mut j = self.rng.gen_range(0..samples.len());
                while j == i {
                    j = self.rng.gen_range(0..samples.len());
                }
                j
            };

            let xi = &samples[i];
            let xj = &samples[j];
            let d64 = l2_sq_64(xi, xj).sqrt();
            if d64 < CALIBRATION_EPS {
                continue;
            }

            let zi = self.encode(xi);
            let zj = self.encode(xj);
            let d2d = l2_sq_2d(&zi, &zj).sqrt();
            if d2d < CALIBRATION_EPS {
                continue;
            }

            let residual = d2d - target_scale * d64;
            if residual.abs() < 0.05 * target_scale * d64 {
                continue;
            }

            let factor = 2.0 * residual * lr * PAIR_DIST_WEIGHT / d2d;
            for k in 0..PROJ_DIM {
                let dz_k = zi[k] - zj[k];
                for dim in 0..LATENT_DIM {
                    let dx_dim = xi[dim] - xj[dim];
                    self.encoder[k][dim] -= factor * dz_k * dx_dim;
                }
            }
        }
    }

    fn train_one(&mut self, x: &[f32; LATENT_DIM], lr: f32) {
        let mut z = [0.0f32; PROJ_DIM];
        for k in 0..PROJ_DIM {
            let mut acc = 0.0f32;
            for i in 0..LATENT_DIM {
                acc += self.encoder[k][i] * x[i];
            }
            z[k] = acc;
        }

        let mut x_hat = [0.0f32; LATENT_DIM];
        for j in 0..LATENT_DIM {
            let mut acc = 0.0f32;
            for k in 0..PROJ_DIM {
                acc += self.decoder[j][k] * z[k];
            }
            x_hat[j] = acc;
        }

        let mut err = [0.0f32; LATENT_DIM];
        for j in 0..LATENT_DIM {
            err[j] = x_hat[j] - x[j];
        }

        let mut dldz = [0.0f32; PROJ_DIM];
        for k in 0..PROJ_DIM {
            let mut acc = 0.0f32;
            for j in 0..LATENT_DIM {
                acc += err[j] * self.decoder[j][k];
            }
            dldz[k] = acc;
        }

        for j in 0..LATENT_DIM {
            for k in 0..PROJ_DIM {
                let grad = err[j] * z[k] + L2_REG * self.decoder[j][k];
                self.decoder[j][k] -= lr * grad;
            }
        }

        for k in 0..PROJ_DIM {
            for i in 0..LATENT_DIM {
                let grad = dldz[k] * x[i] + L2_REG * self.encoder[k][i];
                self.encoder[k][i] -= lr * grad;
            }
        }
    }

    fn orthogonalize_encoder(&mut self) {
        let mut norm0_sq = 0.0f32;
        for i in 0..LATENT_DIM {
            norm0_sq += self.encoder[0][i] * self.encoder[0][i];
        }
        let mut dot = 0.0f32;
        for i in 0..LATENT_DIM {
            dot += self.encoder[1][i] * self.encoder[0][i];
        }
        let proj_coeff = dot / norm0_sq;
        for i in 0..LATENT_DIM {
            self.encoder[1][i] -= proj_coeff * self.encoder[0][i];
        }

        for j in 0..LATENT_DIM {
            for k in 0..PROJ_DIM {
                self.decoder[j][k] = self.encoder[k][j];
            }
        }
    }
}

fn l2_sq_64(a: &[f32; LATENT_DIM], b: &[f32; LATENT_DIM]) -> f32 {
    let mut acc = 0.0f32;
    for i in 0..LATENT_DIM {
        let d = a[i] - b[i];
        acc += d * d;
    }
    acc
}

fn l2_sq_2d(a: &[f32; PROJ_DIM], b: &[f32; PROJ_DIM]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_vec(scale: f32, offset: f32) -> [f32; LATENT_DIM] {
        let mut v = [0.0f32; LATENT_DIM];
        v[0] = scale;
        v[1] = offset;
        v[2] = scale * 0.3 - offset * 0.2;
        v
    }

    #[test]
    fn projection_rank_agreement_remains_high_on_local_linearity() {
        let mut p = AutoencoderProjector::new(256);
        let mut flat = Vec::new();
        for i in 0..120 {
            let x = i as f32 * 0.08;
            let v = line_vec(x, (x * 0.6).sin() * 0.03);
            flat.extend_from_slice(&v);
        }

        p.hydrate_from_flat(&flat, 120);
        let anchor = p.projection_for_id(60);
        let near = p.projection_for_id(62);
        let far = p.projection_for_id(95);
        let d_near = l2_sq_2d(&anchor, &near).sqrt();
        let d_far = l2_sq_2d(&anchor, &far).sqrt();

        assert!(d_near < d_far, "2d projection should keep local rank order");
    }

    #[test]
    fn projection_calibration_stays_bounded_after_incremental_updates() {
        let mut p = AutoencoderProjector::new(256);
        let mut flat = Vec::new();
        for i in 0..100 {
            let v = line_vec(i as f32 * 0.07, (i as f32 * 0.15).cos() * 0.05);
            flat.extend_from_slice(&v);
        }
        p.hydrate_from_flat(&flat, 100);

        let mut dirty = Vec::new();
        for i in 20..38 {
            let x = i as f32 * 0.09;
            dirty.push(DirtyNode {
                id: i as u32,
                coords_64d: line_vec(x + 0.4, (x * 0.4).sin() * 0.07),
            });
        }
        p.apply_incremental_dirty(&dirty);

        let mut max_r = 0.0f32;
        for id in 0..100u32 {
            let z = p.projection_for_id(id);
            let r = (z[0] * z[0] + z[1] * z[1]).sqrt();
            max_r = max_r.max(r);
        }
        assert!(max_r < 4.0, "calibrated projection radius should stay bounded");
    }

    #[test]
    fn calibrate_linear_preserves_rank_ordering() {
        let p = AutoencoderProjector::new(16);
        let z_a = [0.001f32, 0.0];
        let z_b = [0.003f32, 0.0]; // d(A,B) = 0.002
        let z_c = [0.001f32, 0.0015]; // d(A,C) = 0.0015 < d(A,B)

        let ca = p.calibrate(z_a);
        let cb = p.calibrate(z_b);
        let cc = p.calibrate(z_c);

        let d_ab = l2_sq_2d(&ca, &cb).sqrt();
        let d_ac = l2_sq_2d(&ca, &cc).sqrt();

        assert!(
            d_ac < d_ab,
            "linear calibrate must preserve rank: d_ac={d_ac} should be < d_ab={d_ab}"
        );
    }
}