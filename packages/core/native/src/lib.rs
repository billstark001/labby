//! Dual-target FFI surface.
//!
//! Exposes an identical API via:
//!   - `napi-rs`      when compiled as a Node.js native addon   (feature = "node")
//!   - `wasm-bindgen` when compiled to WebAssembly               (feature = "wasm")
//!
//! The core `EmbeddingEngine` is wholly independent of both runtimes;
//! these modules are pure translation layers.

mod distance;
mod engine;
mod hnsw;

pub use engine::{EmbeddingEngine, LATENT_DIM, PROJ_DIM};

// ═══════════════════════════════════════════════════════════════════════════════
// Node.js native addon  (cargo build --features node)
// ═══════════════════════════════════════════════════════════════════════════════
#[cfg(feature = "node")]
mod node_ffi {
    use napi::bindgen_prelude::*;
    use napi_derive::napi;
    use std::sync::Mutex;

    use crate::engine::EmbeddingEngine;

    /// JS-visible class.  The `Mutex` satisfies napi-rs's `Send + Sync`
    /// requirement (relevant for Node.js worker-thread access).
    #[napi]
    pub struct JsEmbeddingEngine {
        inner: Mutex<EmbeddingEngine>,
    }

    #[napi]
    impl JsEmbeddingEngine {
        /// `new JsEmbeddingEngine(capacity)` — preallocate `capacity` node slots.
        #[napi(constructor)]
        pub fn new(capacity: u32) -> Self {
            JsEmbeddingEngine {
                inner: Mutex::new(EmbeddingEngine::new(capacity as usize)),
            }
        }

        /// Hydrate from a `Float32Array` of length `n_nodes × 64`.
        #[napi]
        pub fn hydrate(&self, data: Float32Array, n_nodes: u32) -> Result<()> {
            self.inner.lock().unwrap().hydrate(data.as_ref(), n_nodes as usize);
            Ok(())
        }

        /// Insert a node; returns its assigned u32 ID.
        #[napi]
        pub fn insert_node(&self, coords: Float32Array) -> Result<u32> {
            Ok(self.inner.lock().unwrap().insert_node(coords.as_ref()))
        }

        #[napi]
        pub fn delete_node(&self, id: u32) -> Result<()> {
            self.inner.lock().unwrap().delete_node(id);
            Ok(())
        }

        /// `true` iff d(a,b) < d(a,c).
        #[napi]
        pub fn query_triplet_order(
            &self, id_a: u32, id_b: u32, id_c: u32
        ) -> Result<bool> {
            Ok(self.inner.lock().unwrap().query_triplet_order(id_a, id_b, id_c))
        }

        /// Recommend one triplet as `[anchor, positive, negative]`.
        ///
        /// `excluded_pairs` format: `[a0,b0,a1,b1,...]`.
        #[napi]
        pub fn recommend_triplet(&self, excluded_pairs: Uint32Array) -> Result<Vec<u32>> {
            let pairs = excluded_pairs.as_ref();
            let inner = self.inner.lock().unwrap();
            let recommended = inner.recommend_triplet(pairs);
            Ok(match recommended {
                Some((a, b, c)) => vec![a, b, c],
                None => Vec::new(),
            })
        }

        /// Triplet margin loss SGD step.  Returns the pre-update loss.
        #[napi]
        pub fn update_triplet(
            &self,
            id_a: u32, id_b: u32, id_c: u32,
            margin: f64, learning_rate: f64,
        ) -> Result<f64> {
            let loss = self.inner.lock().unwrap()
                .update_triplet(id_a, id_b, id_c, margin as f32, learning_rate as f32);
            Ok(loss as f64)
        }

        /// Batch triplet updates + one flush.
        ///
        /// `triplets` format: `[a0,b0,c0,a1,b1,c1,...]`.
        /// Returns dirty-node bytes in the standard flush format.
        #[napi]
        pub fn update_triplets_batch_flush(
            &self,
            triplets: Uint32Array,
            margin: f64,
            learning_rate: f64,
        ) -> Result<Buffer> {
            let ids = triplets.as_ref();
            let mut inner = self.inner.lock().unwrap();
            inner
                .update_triplets_batch_flat(ids, margin as f32, learning_rate as f32)
                .map_err(Error::from_reason)?;
            Ok(Buffer::from(inner.flush_dirty_nodes_bytes()))
        }

        /// Pairwise push/pull SGD step.  Returns the pre-update loss.
        #[napi]
        pub fn update_pair(
            &self,
            id_a: u32, id_b: u32,
            target_distance: f64, learning_rate: f64,
        ) -> Result<f64> {
            let loss = self.inner.lock().unwrap()
                .update_pair(id_a, id_b, target_distance as f32, learning_rate as f32);
            Ok(loss as f64)
        }

        /// Batch pair updates + one flush.
        ///
        /// `pairs` format: `[a0,b0,a1,b1,...]`.
        /// Returns dirty-node bytes in the standard flush format.
        #[napi]
        pub fn update_pairs_batch_flush(
            &self,
            pairs: Uint32Array,
            target_distance: f64,
            learning_rate: f64,
        ) -> Result<Buffer> {
            let ids = pairs.as_ref();
            let mut inner = self.inner.lock().unwrap();
            inner
                .update_pairs_batch_flat(ids, target_distance as f32, learning_rate as f32)
                .map_err(Error::from_reason)?;
            Ok(Buffer::from(inner.flush_dirty_nodes_bytes()))
        }

        /// k-NN query.
        ///
        /// Returns a `Buffer` with format: `[n:u32][id:u32, dist:f32] × n`
        #[napi]
        pub fn get_knn(&self, id: u32, k: u32) -> Result<Buffer> {
            let knn = self.inner.lock().unwrap().get_knn(id, k as usize);
            let mut buf = Vec::with_capacity(4 + knn.len() * 8);
            buf.extend_from_slice(&(knn.len() as u32).to_le_bytes());
            for (n_id, dist) in &knn {
                buf.extend_from_slice(&n_id.to_le_bytes());
                buf.extend_from_slice(&dist.to_le_bytes());
            }
            Ok(Buffer::from(buf))
        }

        /// Flush dirty nodes.  See `engine::flush_dirty_nodes_bytes` for wire format.
        #[napi]
        pub fn flush_dirty_nodes(&self) -> Result<Buffer> {
            let bytes = self.inner.lock().unwrap().flush_dirty_nodes_bytes();
            Ok(Buffer::from(bytes))
        }

        #[napi]
        pub fn node_count(&self) -> Result<u32> {
            Ok(self.inner.lock().unwrap().node_count() as u32)
        }

        /// Returns `[x, y]` projection for one node.
        #[napi]
        pub fn get_projection(&self, id: u32) -> Result<Vec<f64>> {
            let p = self.inner.lock().unwrap().get_projection(id);
            Ok(vec![p[0] as f64, p[1] as f64])
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WebAssembly module  (cargo build --target wasm32-unknown-unknown --features wasm)
// ═══════════════════════════════════════════════════════════════════════════════
#[cfg(feature = "wasm")]
mod wasm_ffi {
    use wasm_bindgen::prelude::*;
    use crate::engine::EmbeddingEngine;

    /// The WASM-exported class.  Single-threaded WASM needs no Mutex.
    #[wasm_bindgen]
    pub struct WasmEmbeddingEngine {
        inner: EmbeddingEngine,
    }

    #[wasm_bindgen]
    impl WasmEmbeddingEngine {
        /// `new WasmEmbeddingEngine(capacity)`
        #[wasm_bindgen(constructor)]
        pub fn new(capacity: u32) -> WasmEmbeddingEngine {
            // Route panics to the browser console in debug builds.
            #[cfg(debug_assertions)]
            console_error_panic_hook::set_once();

            WasmEmbeddingEngine {
                inner: EmbeddingEngine::new(capacity as usize),
            }
        }

        /// Hydrate from a JS `Float32Array` — wasm-bindgen converts `&[f32]`
        /// automatically; the slice points directly into WASM linear memory
        /// when the Float32Array was originally created over it (zero-copy path),
        /// or into a GC-managed buffer (one-copy path for GC-heap Float32Arrays).
        pub fn hydrate(&mut self, data: &[f32], n_nodes: u32) {
            self.inner.hydrate(data, n_nodes as usize);
        }

        pub fn insert_node(&mut self, coords: &[f32]) -> u32 {
            self.inner.insert_node(coords)
        }

        pub fn delete_node(&mut self, id: u32) {
            self.inner.delete_node(id);
        }

        pub fn query_triplet_order(&self, id_a: u32, id_b: u32, id_c: u32) -> bool {
            self.inner.query_triplet_order(id_a, id_b, id_c)
        }

        /// Recommend one triplet as `[anchor, positive, negative]`.
        ///
        /// `excluded_pairs` format: `[a0,b0,a1,b1,...]`.
        pub fn recommend_triplet(&self, excluded_pairs: &[u32]) -> Vec<u32> {
            match self.inner.recommend_triplet(excluded_pairs) {
                Some((a, b, c)) => vec![a, b, c],
                None => Vec::new(),
            }
        }

        pub fn update_triplet(
            &mut self,
            id_a: u32, id_b: u32, id_c: u32,
            margin: f32, learning_rate: f32,
        ) -> f32 {
            self.inner.update_triplet(id_a, id_b, id_c, margin, learning_rate)
        }

        /// Batch triplet updates + one flush.
        ///
        /// `triplets` format: `[a0,b0,c0,a1,b1,c1,...]`.
        pub fn update_triplets_batch_flush(
            &mut self,
            triplets: &[u32],
            margin: f32,
            learning_rate: f32,
        ) -> Vec<u8> {
            if self
                .inner
                .update_triplets_batch_flat(triplets, margin, learning_rate)
                .is_err()
            {
                return Vec::new();
            }
            self.inner.flush_dirty_nodes_bytes()
        }

        pub fn update_pair(
            &mut self,
            id_a: u32, id_b: u32,
            target_distance: f32, learning_rate: f32,
        ) -> f32 {
            self.inner.update_pair(id_a, id_b, target_distance, learning_rate)
        }

        /// Batch pair updates + one flush.
        ///
        /// `pairs` format: `[a0,b0,a1,b1,...]`.
        pub fn update_pairs_batch_flush(
            &mut self,
            pairs: &[u32],
            target_distance: f32,
            learning_rate: f32,
        ) -> Vec<u8> {
            if self
                .inner
                .update_pairs_batch_flat(pairs, target_distance, learning_rate)
                .is_err()
            {
                return Vec::new();
            }
            self.inner.flush_dirty_nodes_bytes()
        }

        /// Returns `[n:u32][id:u32, dist:f32] × n` as `Uint8Array`.
        pub fn get_knn(&self, id: u32, k: u32) -> Vec<u8> {
            let knn = self.inner.get_knn(id, k as usize);
            let mut buf = Vec::with_capacity(4 + knn.len() * 8);
            buf.extend_from_slice(&(knn.len() as u32).to_le_bytes());
            for (n_id, dist) in &knn {
                buf.extend_from_slice(&n_id.to_le_bytes());
                buf.extend_from_slice(&dist.to_le_bytes());
            }
            buf
        }

        pub fn flush_dirty_nodes(&mut self) -> Vec<u8> {
            self.inner.flush_dirty_nodes_bytes()
        }

        pub fn node_count(&self) -> u32 {
            self.inner.node_count() as u32
        }

        pub fn get_projection(&self, id: u32) -> Vec<f32> {
            let p = self.inner.get_projection(id);
            vec![p[0], p[1]]
        }
    }
}