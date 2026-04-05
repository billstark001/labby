//! Dual-target FFI surface.
//!
//! Exposes an identical API via:
//!   - `napi-rs`      when compiled as a Node.js native addon   (feature = "node")
//!   - `wasm-bindgen` when compiled to WebAssembly               (feature = "wasm")
//!
//! The core `EmbeddingEngine` is wholly independent of both runtimes;
//! these modules are pure translation layers.

mod distance;
mod autoencoder;
mod engine;
mod hnsw;

pub use autoencoder::{AutoencoderProjector, PROJ_DIM};
pub use engine::{DirtyNode, EmbeddingEngine, LATENT_DIM, UpdateIterationOptions};

#[allow(dead_code)]
fn encode_dirty_with_projection(nodes: &[DirtyNode], projector: &AutoencoderProjector) -> Vec<u8> {
    const ENTRY: usize = 4 + LATENT_DIM * 4 + PROJ_DIM * 4;
    let mut buf = Vec::with_capacity(4 + nodes.len() * ENTRY);
    buf.extend_from_slice(&(nodes.len() as u32).to_le_bytes());
    for n in nodes {
        buf.extend_from_slice(&n.id.to_le_bytes());
        for &v in &n.coords_64d {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        let p = projector.projection_for_id(n.id);
        for &v in &p {
            buf.extend_from_slice(&v.to_le_bytes());
        }
    }
    buf
}

// ═══════════════════════════════════════════════════════════════════════════════
// Node.js native addon  (cargo build --features node)
// ═══════════════════════════════════════════════════════════════════════════════
#[cfg(feature = "node")]
mod node_ffi {
    use napi::bindgen_prelude::*;
    use napi_derive::napi;
    use std::sync::Mutex;

    use crate::{
        AutoencoderProjector,
        EmbeddingEngine,
        UpdateIterationOptions,
        encode_dirty_with_projection,
    };

    #[napi(object)]
    pub struct JsUpdateIterationOptions {
        pub learning_rate: Option<f64>,
        pub min_iters: Option<u32>,
        pub max_iters: Option<u32>,
        pub stability_window: Option<u32>,
        pub stability_tolerance: Option<f64>,
    }

    fn resolve_update_options(options: Option<JsUpdateIterationOptions>) -> UpdateIterationOptions {
        let mut resolved = UpdateIterationOptions::default();
        if let Some(opts) = options {
            if let Some(v) = opts.learning_rate {
                resolved.learning_rate = v as f32;
            }
            if let Some(v) = opts.min_iters {
                resolved.min_iters = v;
            }
            if let Some(v) = opts.max_iters {
                resolved.max_iters = v;
            }
            if let Some(v) = opts.stability_window {
                resolved.stability_window = v as usize;
            }
            if let Some(v) = opts.stability_tolerance {
                resolved.stability_tolerance = v as f32;
            }
        }
        resolved
    }

    struct Runtime {
        engine: EmbeddingEngine,
        projector: AutoencoderProjector,
    }

    impl Runtime {
        fn new(capacity: usize) -> Self {
            Self {
                engine: EmbeddingEngine::new(capacity),
                projector: AutoencoderProjector::new(capacity),
            }
        }

        fn flush_with_projection(&mut self) -> Vec<u8> {
            let dirty = self.engine.flush_dirty_nodes();
            self.projector.apply_incremental_dirty(&dirty);
            encode_dirty_with_projection(&dirty, &self.projector)
        }
    }

    /// JS-visible class.  The `Mutex` satisfies napi-rs's `Send + Sync`
    /// requirement (relevant for Node.js worker-thread access).
    #[napi]
    pub struct JsEmbeddingEngine {
        inner: Mutex<Runtime>,
    }

    #[napi]
    impl JsEmbeddingEngine {
        /// `new JsEmbeddingEngine(capacity)` — preallocate `capacity` node slots.
        #[napi(constructor)]
        pub fn new(capacity: u32) -> Self {
            JsEmbeddingEngine {
                inner: Mutex::new(Runtime::new(capacity as usize)),
            }
        }

        /// Hydrate from a `Float32Array` of length `n_nodes × 64`.
        #[napi]
        pub fn hydrate(&self, data: Float32Array, n_nodes: u32) -> Result<()> {
            let mut inner = self.inner.lock().unwrap();
            inner.engine.hydrate(data.as_ref(), n_nodes as usize);
            inner.projector.hydrate_from_flat(data.as_ref(), n_nodes as usize);
            Ok(())
        }

        /// Insert a node; returns its assigned u32 ID.
        #[napi]
        pub fn insert_node(&self, coords: Float32Array) -> Result<u32> {
            let mut inner = self.inner.lock().unwrap();
            let id = inner.engine.insert_node(coords.as_ref());
            let mut c64 = [0.0f32; crate::LATENT_DIM];
            for (i, v) in coords.as_ref().iter().enumerate().take(crate::LATENT_DIM) {
                c64[i] = *v;
            }
            inner.projector.upsert(id, &c64);
            Ok(id)
        }

        #[napi]
        pub fn delete_node(&self, id: u32) -> Result<()> {
            let mut inner = self.inner.lock().unwrap();
            inner.engine.delete_node(id);
            inner.projector.remove(id);
            Ok(())
        }

        /// `true` iff d(a,b) < d(a,c).
        #[napi]
        pub fn query_triplet_order(
            &self, id_a: u32, id_b: u32, id_c: u32
        ) -> Result<bool> {
            Ok(self.inner.lock().unwrap().engine.query_triplet_order(id_a, id_b, id_c))
        }

        /// Recommend one triplet as `[anchor, positive, negative]`.
        ///
        /// `excluded_pairs` format: `[a0,b0,a1,b1,...]`.
        #[napi]
        pub fn recommend_triplet(&self, excluded_pairs: Uint32Array) -> Result<Vec<u32>> {
            let pairs = excluded_pairs.as_ref();
            let inner = self.inner.lock().unwrap();
            let recommended = inner.engine.recommend_triplet(pairs);
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
            margin: f64,
            options: Option<JsUpdateIterationOptions>,
        ) -> Result<f64> {
            let options = resolve_update_options(options);
            let loss = self.inner.lock().unwrap()
                .engine
                .update_triplet(id_a, id_b, id_c, margin as f32, options);
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
            options: Option<JsUpdateIterationOptions>,
        ) -> Result<Buffer> {
            let ids = triplets.as_ref();
            let mut inner = self.inner.lock().unwrap();
            let options = resolve_update_options(options);
            inner.engine
                .update_triplets_batch_flat(ids, margin as f32, options)
                .map_err(Error::from_reason)?;
            Ok(Buffer::from(inner.flush_with_projection()))
        }

        /// Pairwise push/pull SGD step.  Returns the pre-update loss.
        #[napi]
        pub fn update_pair(
            &self,
            id_a: u32, id_b: u32,
            target_distance: f64,
            options: Option<JsUpdateIterationOptions>,
        ) -> Result<f64> {
            let options = resolve_update_options(options);
            let loss = self.inner.lock().unwrap()
                .engine
                .update_pair(id_a, id_b, target_distance as f32, options);
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
            options: Option<JsUpdateIterationOptions>,
        ) -> Result<Buffer> {
            let ids = pairs.as_ref();
            let mut inner = self.inner.lock().unwrap();
            let options = resolve_update_options(options);
            inner.engine
                .update_pairs_batch_flat(ids, target_distance as f32, options)
                .map_err(Error::from_reason)?;
            Ok(Buffer::from(inner.flush_with_projection()))
        }

        /// k-NN query.
        ///
        /// Returns a `Buffer` with format: `[n:u32][id:u32, dist:f32] × n`
        #[napi]
        pub fn get_knn(&self, id: u32, k: u32) -> Result<Buffer> {
            let knn = self.inner.lock().unwrap().engine.get_knn(id, k as usize);
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
            let bytes = self.inner.lock().unwrap().flush_with_projection();
            Ok(Buffer::from(bytes))
        }

        #[napi]
        pub fn node_count(&self) -> Result<u32> {
            Ok(self.inner.lock().unwrap().engine.node_count() as u32)
        }

        /// Returns `[x, y]` projection for one node.
        #[napi]
        pub fn get_projection(&self, id: u32) -> Result<Vec<f64>> {
            let p = self.inner.lock().unwrap().projector.projection_for_id(id);
            Ok(vec![p[0] as f64, p[1] as f64])
        }

        /// Tune stability behavior for anchor preservation and rigid compensation.
        #[napi]
        pub fn configure_stability(
            &self,
            anchor_k: u32,
            anchor_weight: f64,
            anchor_spike_ratio: f64,
            anchor_spike_boost: f64,
            rigid_iterations: u32,
            rigid_step: f64,
            auto_near_per_touched: u32,
            auto_far_count: u32,
        ) -> Result<()> {
            let mut inner = self.inner.lock().unwrap();
            inner.engine.set_anchor_preservation_params(
                anchor_k as usize,
                anchor_weight as f32,
                anchor_spike_ratio as f32,
                anchor_spike_boost as f32,
            );
            inner.engine.set_rigid_compensation_params(rigid_iterations, rigid_step as f32);
            inner.engine.set_rigid_control_point_params(
                auto_near_per_touched as usize,
                auto_far_count as usize,
            );
            Ok(())
        }

        /// Override rigid-compensation control points manually (near and far lists).
        #[napi]
        pub fn set_rigid_control_points(
            &self,
            near_ids: Uint32Array,
            far_ids: Uint32Array,
        ) -> Result<()> {
            let mut inner = self.inner.lock().unwrap();
            inner.engine.set_rigid_control_points(near_ids.as_ref(), far_ids.as_ref());
            Ok(())
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WebAssembly module  (cargo build --target wasm32-unknown-unknown --features wasm)
// ═══════════════════════════════════════════════════════════════════════════════
#[cfg(feature = "wasm")]
mod wasm_ffi {
    use js_sys::{Object, Reflect};
    use wasm_bindgen::prelude::*;
    use crate::{
        AutoencoderProjector,
        EmbeddingEngine,
        UpdateIterationOptions,
        encode_dirty_with_projection,
    };

    fn set_option_from_f64(
        object: &Object,
        key: &str,
        out: &mut f32,
    ) {
        if let Ok(value) = Reflect::get(object, &JsValue::from_str(key)) {
            if let Some(num) = value.as_f64() {
                *out = num as f32;
            }
        }
    }

    fn set_option_from_u32(
        object: &Object,
        key: &str,
        out: &mut u32,
    ) {
        if let Ok(value) = Reflect::get(object, &JsValue::from_str(key)) {
            if let Some(num) = value.as_f64() {
                if num.is_finite() && num >= 0.0 {
                    *out = num as u32;
                }
            }
        }
    }

    fn resolve_update_options(options: Option<JsValue>) -> UpdateIterationOptions {
        let mut resolved = UpdateIterationOptions::default();
        let Some(value) = options else {
            return resolved;
        };
        if value.is_null() || value.is_undefined() || !value.is_object() {
            return resolved;
        }

        let object: Object = value.into();
        set_option_from_f64(&object, "learningRate", &mut resolved.learning_rate);
        set_option_from_f64(&object, "learning_rate", &mut resolved.learning_rate);
        set_option_from_u32(&object, "minIters", &mut resolved.min_iters);
        set_option_from_u32(&object, "min_iters", &mut resolved.min_iters);
        set_option_from_u32(&object, "maxIters", &mut resolved.max_iters);
        set_option_from_u32(&object, "max_iters", &mut resolved.max_iters);

        let mut stability_window_u32 = resolved.stability_window as u32;
        set_option_from_u32(&object, "stabilityWindow", &mut stability_window_u32);
        set_option_from_u32(&object, "stability_window", &mut stability_window_u32);
        resolved.stability_window = stability_window_u32 as usize;

        set_option_from_f64(
            &object,
            "stabilityTolerance",
            &mut resolved.stability_tolerance,
        );
        set_option_from_f64(
            &object,
            "stability_tolerance",
            &mut resolved.stability_tolerance,
        );

        resolved
    }

    /// The WASM-exported class.  Single-threaded WASM needs no Mutex.
    #[wasm_bindgen]
    pub struct WasmEmbeddingEngine {
        inner: EmbeddingEngine,
        projector: AutoencoderProjector,
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
                projector: AutoencoderProjector::new(capacity as usize),
            }
        }

        /// Hydrate from a JS `Float32Array` — wasm-bindgen converts `&[f32]`
        /// automatically; the slice points directly into WASM linear memory
        /// when the Float32Array was originally created over it (zero-copy path),
        /// or into a GC-managed buffer (one-copy path for GC-heap Float32Arrays).
        pub fn hydrate(&mut self, data: &[f32], n_nodes: u32) {
            self.inner.hydrate(data, n_nodes as usize);
            self.projector.hydrate_from_flat(data, n_nodes as usize);
        }

        pub fn insert_node(&mut self, coords: &[f32]) -> u32 {
            let id = self.inner.insert_node(coords);
            let mut c64 = [0.0f32; crate::LATENT_DIM];
            for (i, v) in coords.iter().enumerate().take(crate::LATENT_DIM) {
                c64[i] = *v;
            }
            self.projector.upsert(id, &c64);
            id
        }

        pub fn delete_node(&mut self, id: u32) {
            self.inner.delete_node(id);
            self.projector.remove(id);
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
            margin: f32,
            options: Option<JsValue>,
        ) -> f32 {
            self.inner
                .update_triplet(id_a, id_b, id_c, margin, resolve_update_options(options))
        }

        /// Batch triplet updates + one flush.
        ///
        /// `triplets` format: `[a0,b0,c0,a1,b1,c1,...]`.
        pub fn update_triplets_batch_flush(
            &mut self,
            triplets: &[u32],
            margin: f32,
            options: Option<JsValue>,
        ) -> Vec<u8> {
            if self
                .inner
                .update_triplets_batch_flat(triplets, margin, resolve_update_options(options))
                .is_err()
            {
                return Vec::new();
            }
            let dirty = self.inner.flush_dirty_nodes();
            self.projector.apply_incremental_dirty(&dirty);
            encode_dirty_with_projection(&dirty, &self.projector)
        }

        pub fn update_pair(
            &mut self,
            id_a: u32, id_b: u32,
            target_distance: f32,
            options: Option<JsValue>,
        ) -> f32 {
            self.inner
                .update_pair(id_a, id_b, target_distance, resolve_update_options(options))
        }

        /// Batch pair updates + one flush.
        ///
        /// `pairs` format: `[a0,b0,a1,b1,...]`.
        pub fn update_pairs_batch_flush(
            &mut self,
            pairs: &[u32],
            target_distance: f32,
            options: Option<JsValue>,
        ) -> Vec<u8> {
            if self
                .inner
                .update_pairs_batch_flat(pairs, target_distance, resolve_update_options(options))
                .is_err()
            {
                return Vec::new();
            }
            let dirty = self.inner.flush_dirty_nodes();
            self.projector.apply_incremental_dirty(&dirty);
            encode_dirty_with_projection(&dirty, &self.projector)
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
            let dirty = self.inner.flush_dirty_nodes();
            self.projector.apply_incremental_dirty(&dirty);
            encode_dirty_with_projection(&dirty, &self.projector)
        }

        pub fn node_count(&self) -> u32 {
            self.inner.node_count() as u32
        }

        pub fn get_projection(&self, id: u32) -> Vec<f32> {
            let p = self.projector.projection_for_id(id);
            vec![p[0], p[1]]
        }

        pub fn configure_stability(
            &mut self,
            anchor_k: u32,
            anchor_weight: f32,
            anchor_spike_ratio: f32,
            anchor_spike_boost: f32,
            rigid_iterations: u32,
            rigid_step: f32,
            auto_near_per_touched: u32,
            auto_far_count: u32,
        ) {
            self.inner.set_anchor_preservation_params(
                anchor_k as usize,
                anchor_weight,
                anchor_spike_ratio,
                anchor_spike_boost,
            );
            self.inner.set_rigid_compensation_params(rigid_iterations, rigid_step);
            self.inner.set_rigid_control_point_params(
                auto_near_per_touched as usize,
                auto_far_count as usize,
            );
        }

        pub fn set_rigid_control_points(&mut self, near_ids: &[u32], far_ids: &[u32]) {
            self.inner.set_rigid_control_points(near_ids, far_ids);
        }
    }
}