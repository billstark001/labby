
# Document 1: Mathematical and Informatic Principles of Dynamic Metric Space Embedding

## 1. The Core Problem Definition

We are tasked with maintaining a dynamic abstract metric space consisting of a large set of elements ($N \sim 100,000$). A valid metric space must strictly adhere to three mathematical axioms for any points $x, y, z$:

1. **Identity and Non-negativity:** $d(x, y) \ge 0$, and $d(x, y) = 0 \iff x = y$
2. **Symmetry:** $d(x, y) = d(y, x)$
3. **Triangle Inequality:** $d(x, z) \le d(x, y) + d(y, z)$

The system must support the following operations in real-time (sub-millisecond latency):

* Insert/Delete nodes with minimal distance perturbation.
* Push/Pull (decrease/increase distance) specific pairs of nodes.
* Resolve ordinal triplet queries ("Is $a$ closer to $b$ or $c$?") and update the space accordingly.
* Provide an incremental 2D projection for human visualization.

## 2. The Bottleneck of Explicit Representation

In pure informatics, explicitly maintaining a dense distance matrix of size $N \times N$ requires $O(N^2)$ space. More critically, any localized distance update (e.g., pulling $a$ and $b$ closer) necessitates an $O(N^3)$ or heavily optimized $O(N^2)$ global validation pass to ensure the triangle inequality axiom is not violated. This is computationally impossible within human-acceptable latency bounds for $N = 100,000$.

## 3. The Mathematical Solution: Euclidean Embedding

To bypass the $O(N^3)$ validation bottleneck, we map the abstract metric space into a continuous, low-dimensional Euclidean space ($\mathbb{R}^d$).

**Bourgain's Theorem** guarantees that any finite metric space can be embedded into an $\ell_2$ space (Euclidean space) with minimal distortion. By selecting a sufficiently expressive latent dimension (e.g., $d = 64$), we replace the $N \times N$ explicit distance matrix with an $N \times d$ coordinate matrix.
In $\mathbb{R}^d$, the standard Euclidean distance (L2 norm) natively strictly satisfies all metric axioms. Therefore, we never need to validate the triangle inequality; it is inherently guaranteed by the geometry of the space.

## 4. Algorithmic Principles for Dynamic Updates

By mapping elements to coordinate vectors, our operations transition from discrete graph theory to differentiable continuous optimization:

* **Push/Pull Operations:** Modeled as a physical force-directed system or a least-squares optimization. To adjust the distance between $x_i$ and $x_j$, we define a differentiable loss function based on the target distance.
* **Triplet Resolution (Ordinal Embedding):** When answering "$a$ is closer to $b$ than $c$", we construct a Triplet Margin Loss:
    $$L = \max(0, \|x_a - x_b\|_2^2 - \|x_a - x_c\|_2^2 + \text{margin})$$
* **Gradient Descent (SGD):** To apply these updates, we compute the analytical gradient of the loss function with respect to the coordinates of the involved points and perform a small step in the opposite direction. Because we only update the localized coordinates of $a, b$, and $c$, the distances between all other $99,997$ points remain mathematically invariant.
* **Dimensionality Reduction for Visualization:** To map $\mathbb{R}^d$ to $\mathbb{R}^2$, we utilize principles from Riemannian geometry and algebraic topology (UMAP). Instead of recomputing the global manifold mapping, we freeze the global topological representation and only compute the parametric projection for the vectors whose $d$-dimensional coordinates were modified by the SGD steps.

---

# Document 2: Rust Engineering Implementation Task List

**Target:** Compile to a Native Node Addon via `napi-rs` and a WebAssembly module via `wasm-bindgen`.

## 1. Architectural Mandate: State Ownership Inversion

The Rust core **must** own the $N \times d$ coordinate matrix (the latent space). The Node.js layer or JS runtime must never hold this structure in its GC-managed heap to prevent catastrophic serialization/deserialization overhead across the FFI (Foreign Function Interface) boundary.

## 2. Core Dependencies

* `ndarray`: For continuous, efficient multi-dimensional array representations.
* `napi` / `napi-derive`: For Node.js bindings.
* `wasm-bindgen`: For browser-side execution.
* `serde`: For initial hydration and serialization.

## 3. Engineering Tasks

### Task 1: Matrix Hydration and Memory Allocation

* Define a struct `EmbeddingEngine` that holds an `ndarray::Array2<f32>` of size $N \times 64$.
* Implement initialization methods that accept a flat `Float32Array` from JS and unsafely/safely cast it into the internal Rust matrix to achieve zero-copy hydration where possible.

### Task 2: High-Performance Distance Computation

* Implement SIMD-accelerated L2 distance calculations.
* Ensure that computing $\|x_a - x_b\|_2$ utilizes AVX2/NEON instructions natively (often handled automatically by `ndarray` if compiled with `opt-level=3` and target-cpu flags).

### Task 3: Implement the Optimizer (SGD Engine)

* **Triplet Update:** Implement a function `update_triplet(id_a, id_b, id_c, margin, learning_rate)`.
  * Calculate current distances.
  * Compute gradients for the 3 vectors.
  * Apply in-place mutations to the `ndarray` slice for these specific rows.
* **Pairwise Push/Pull:** Implement `update_pair(id_a, id_b, target_distance, learning_rate)`.
* *Constraint:* Ensure all updates are strictly $O(1)$ regarding $N$.

### Task 4: Incremental 2D Projection (Parametric UMAP)

* Implement a simplified, localized UMAP projection.
* Maintain a secondary `ndarray::Array2<f32>` of size $N \times 2$ for the frontend state.
* When a latent vector in $\mathbb{R}^{64}$ updates, compute its new projection in $\mathbb{R}^2$ using its $k$-nearest neighbors in the frozen 64D space, and update only its specific 2D coordinates.

### Task 5: The Dirty Flag System

* Maintain a `HashSet<u32>` of node IDs that have been modified.
* Expose a method `flush_dirty_nodes()` that returns a struct containing the IDs, their new 64D vectors, and new 2D vectors, then clears the set. This allows the host environment (Node/Browser) to batch-sync updates to the database.

### Task 6: Dual-Target FFI API Surface

* Use conditional compilation (`#[cfg(target_arch = "wasm32")]` vs `#[cfg(not(target_arch = "wasm32"))]`) to expose the exact same API surface via `wasm_bindgen` and `napi_rs`.
* Input/Output payloads must be restricted to primitives (integers, floats) or raw byte buffers. Avoid sending nested JSON objects across the boundary.

---

# Document 3: Integration Guide for Node.js and Frontend

## 1. Node.js Integration (Backend)

The Node.js server acts strictly as a lightweight API gateway and database orchestrator. It delegates all heavy lifting to the Rust-compiled `.node` binary.

### Initialization & Cold Start

Upon server startup, query your persistent database (e.g., PostgreSQL with `pgvector` or SQLite). Extract the current 64D and 2D arrays, flatten them into a continuous `Float32Array`, and pass it to the Rust engine to instantiate the singleton.

```javascript
const { EmbeddingEngine } = require('./native/metric_core.node');
// initialData is a flat Float32Array loaded from DB
const engine = new EmbeddingEngine(initialData, totalNodes); 
```

### Handling Client Requests

Route user interactions directly to the engine using primitive IDs. **Do not fetch vectors from the database for operations.**

```javascript
app.post('/api/action/triplet', (req, res) => {
    const { anchorId, posId, negId } = req.body;
    
    // Rust performs math in < 1ms. 
    // Returns only the updated 2D coordinates for these 3 specific points.
    const updated2D = engine.updateTriplet(anchorId, posId, negId);
    
    // Send immediate visual feedback to the client
    res.json({ success: true, updates: updated2D });
});
```

### Background Persistence

Avoid blocking the Event Loop or flooding the database with single-row updates. Setup a `setInterval` worker to periodically drain the "dirty" queue from the Rust engine.

```javascript
setInterval(async () => {
    const dirtyData = engine.flushDirtyNodes();
    if (dirtyData.length === 0) return;

    // Use bulk operations (e.g., Postgres unnest or SQLite transactions)
    // to update pgvector and 2D coordinate columns.
    await db.bulkUpdateVectors(dirtyData);
}, 5000); 
```

## 2. Frontend Integration (Browser)

The browser is responsible for rendering the 100,000 points smoothly at 60 FPS.

### Rendering Engine Selection

You cannot use DOM elements (React/Vue components) or standard Canvas API 2D contexts for $N = 100,000$. You **must** use WebGL.

* **Recommended libraries:** `deck.gl` (ScatterplotLayer) or `PixiJS` (using ParticleContainer).
* These libraries accept flat `Float32Array` buffers for positions, which maps perfectly to the data structure outputted by our backend.

### Handling Incremental Updates

When the user performs an action (e.g., dragging a node closer to another, or answering a triplet prompt), the frontend makes an API call to Node.

The API response will *only* contain the new $X, Y$ coordinates of the affected nodes.

* Do not request the entire $100,000 \times 2$ array.
* Locally mutate the buffer:

    ```javascript
    // Assuming positionsBuffer is the Float32Array bound to WebGL
    function applyUpdate(nodeId, newX, newY) {
        positionsBuffer[nodeId * 2] = newX;
        positionsBuffer[nodeId * 2 + 1] = newY;
        // Trigger WebGL re-render
        deckglLayer.setNeedsUpdate(); 
    }
    ```

* Use libraries like `gsap` or implement a simple linear interpolation loop in `requestAnimationFrame` to smoothly transition the affected points from their old coordinates to the new coordinates, providing a polished, fluid user experience.
