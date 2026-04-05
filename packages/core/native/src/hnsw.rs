//! Hierarchical Navigable Small World (HNSW) approximate nearest-neighbor index.
//!
//! Reference: Malkov & Yashunin, "Efficient and robust approximate nearest
//! neighbor search using Hierarchical Navigable Small World graphs", IEEE
//! Transactions on Pattern Analysis and Machine Intelligence, 2018.

use ndarray::Array2;
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

use crate::distance::dist_bits;

pub struct HNSWIndex {
  neighbors: Vec<Vec<Vec<u32>>>,
  active: Vec<bool>,
  entry_point: Option<u32>,
  max_level: usize,
  m: usize,
  m0: usize,
  ef_construction: usize,
  ml: f64,
  rng: SmallRng,
}

impl HNSWIndex {
  pub fn new(m: usize, ef_construction: usize) -> Self {
    HNSWIndex {
      neighbors: Vec::new(),
      active: Vec::new(),
      entry_point: None,
      max_level: 0,
      m,
      m0: 2 * m,
      ef_construction,
      ml: 1.0 / (m as f64).ln(),
      rng: SmallRng::seed_from_u64(0xDEAD_BEEF),
    }
  }

  pub fn is_active(&self, id: u32) -> bool {
    (id as usize) < self.active.len() && self.active[id as usize]
  }

  fn ensure_capacity(&mut self, node_id: u32) {
    let idx = node_id as usize + 1;
    if idx > self.neighbors.len() {
      self.neighbors.resize(idx, Vec::new());
      self.active.resize(idx, false);
    }
  }

  fn sample_level(&mut self) -> usize {
    let u: f64 = self.rng.gen::<f64>().max(f64::EPSILON);
    (((-u.ln()) * self.ml).floor() as usize).min(16)
  }

  fn search_layer(
    &self,
    query_row: &[f32],
    entry_points: &[u32],
    ef: usize,
    level: usize,
    coords: &Array2<f32>,
  ) -> BinaryHeap<(u32, u32)> {
    let mut visited: HashSet<u32> = HashSet::with_capacity(ef * 4);
    let mut w: BinaryHeap<(u32, u32)> = BinaryHeap::with_capacity(ef + 1);
    let mut c: BinaryHeap<(Reverse<u32>, u32)> = BinaryHeap::with_capacity(ef * 4);

    for &ep in entry_points {
      if !self.is_active(ep) {
        continue;
      }
      if !visited.insert(ep) {
        continue;
      }
      let d = l2_dist_sq_row(query_row, coords, ep);
      let db = dist_bits(d);
      w.push((db, ep));
      c.push((Reverse(db), ep));
    }

    while let Some((Reverse(c_dist), c_id)) = c.pop() {
      if let Some(&(f_dist, _)) = w.peek() {
        if w.len() >= ef && c_dist > f_dist {
          break;
        }
      }

      if let Some(node_nbrs) = self.neighbors.get(c_id as usize) {
        if let Some(lvl_nbrs) = node_nbrs.get(level) {
          for &n_id in lvl_nbrs {
            if !visited.insert(n_id) {
              continue;
            }
            if !self.is_active(n_id) {
              continue;
            }

            let n_dist = l2_dist_sq_row(query_row, coords, n_id);
            let n_bits = dist_bits(n_dist);
            let f_bits = w.peek().map(|&(d, _)| d).unwrap_or(u32::MAX);

            if w.len() < ef || n_bits < f_bits {
              c.push((Reverse(n_bits), n_id));
              w.push((n_bits, n_id));
              if w.len() > ef {
                w.pop();
              }
            }
          }
        }
      }
    }
    w
  }

  fn select_neighbors(candidates: &BinaryHeap<(u32, u32)>, m: usize) -> Vec<u32> {
    let mut v: Vec<(u32, u32)> = candidates.iter().cloned().collect();
    v.sort_unstable_by_key(|&(d, _)| d);
    v.truncate(m);
    v.into_iter().map(|(_, id)| id).collect()
  }

  pub fn insert(&mut self, node_id: u32, coords: &Array2<f32>) {
    self.ensure_capacity(node_id);
    self.active[node_id as usize] = true;

    let new_level = self.sample_level();
    self.neighbors[node_id as usize] = vec![Vec::new(); new_level + 1];

    let query_row: Vec<f32> = coords.row(node_id as usize).to_vec();

    if self.entry_point.is_none() {
      self.entry_point = Some(node_id);
      self.max_level = new_level;
      return;
    }

    let ep = self.entry_point.unwrap_or(node_id);
    let mut cur_eps: Vec<u32> = vec![ep];

    for lc in (new_level + 1..=self.max_level).rev() {
      let w = self.search_layer(&query_row, &cur_eps, 1, lc, coords);
      if let Some(&(_, nearest)) = w.iter().min_by_key(|&&(d, _)| d) {
        cur_eps = vec![nearest];
      }
    }

    let top_conn = new_level.min(self.max_level);
    for lc in (0..=top_conn).rev() {
      let m_lc = if lc == 0 { self.m0 } else { self.m };
      let w = self.search_layer(&query_row, &cur_eps, self.ef_construction, lc, coords);
      cur_eps = w.iter().map(|&(_, id)| id).collect();

      let new_nbrs = Self::select_neighbors(&w, m_lc);
      self.neighbors[node_id as usize][lc] = new_nbrs.clone();

      for &n_id in &new_nbrs {
        let n_idx = n_id as usize;
        if n_idx >= self.neighbors.len() || lc >= self.neighbors[n_idx].len() {
          continue;
        }

        self.neighbors[n_idx][lc].push(node_id);

        if self.neighbors[n_idx][lc].len() > m_lc {
          let n_row: Vec<f32> = coords.row(n_idx).to_vec();
          let mut with_dists: Vec<(u32, u32)> = self.neighbors[n_idx][lc]
            .iter()
            .map(|&nb| {
              let d = l2_dist_sq_slice(&n_row, coords, nb);
              (dist_bits(d), nb)
            })
            .collect();
          with_dists.sort_unstable_by_key(|&(d, _)| d);
          with_dists.truncate(m_lc);
          self.neighbors[n_idx][lc] = with_dists.into_iter().map(|(_, id)| id).collect();
        }
      }
    }

    if new_level > self.max_level {
      self.max_level = new_level;
      self.entry_point = Some(node_id);
    }
  }

  pub fn remove(&mut self, node_id: u32) {
    if (node_id as usize) < self.active.len() {
      self.active[node_id as usize] = false;
    }
    if self.entry_point == Some(node_id) {
      self.entry_point = self
        .active
        .iter()
        .enumerate()
        .find(|(_, a)| **a)
        .map(|(i, _)| i as u32);
      if let Some(ep) = self.entry_point {
        self.max_level = self.neighbors[ep as usize].len().saturating_sub(1);
      } else {
        self.max_level = 0;
      }
    }
  }

  pub fn knn_search(
    &self,
    query_row: &[f32],
    k: usize,
    ef: usize,
    coords: &Array2<f32>,
  ) -> Vec<(u32, f32)> {
    let ep = match self.entry_point {
      Some(e) => e,
      None => return Vec::new(),
    };

    let ef_eff = ef.max(k);
    let mut cur_eps: Vec<u32> = vec![ep];

    for lc in (1..=self.max_level).rev() {
      let w = self.search_layer(query_row, &cur_eps, 1, lc, coords);
      if let Some(&(_, nearest)) = w.iter().min_by_key(|&&(d, _)| d) {
        cur_eps = vec![nearest];
      }
    }

    let w = self.search_layer(query_row, &cur_eps, ef_eff, 0, coords);

    let mut results: Vec<(u32, u32)> = w.into_vec();
    results.sort_unstable_by_key(|&(d, _)| d);
    results.truncate(k);

    results
      .into_iter()
      .map(|(d_bits, id)| (id, f32::from_bits(d_bits)))
      .collect()
  }
}

#[inline]
fn l2_dist_sq_row(a: &[f32], mat: &Array2<f32>, row: u32) -> f32 {
  l2_dist_sq_slice(a, mat, row)
}

#[inline]
fn l2_dist_sq_slice(a: &[f32], mat: &Array2<f32>, row: u32) -> f32 {
  let b = mat.row(row as usize);
  if let Some(b_s) = b.as_slice() {
    a.iter()
      .zip(b_s.iter())
      .map(|(x, y)| {
        let d = x - y;
        d * d
      })
      .sum()
  } else {
    a.iter()
      .zip(b.iter())
      .map(|(x, y)| {
        let d = x - y;
        d * d
      })
      .sum()
  }
}
