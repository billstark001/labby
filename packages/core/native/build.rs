fn main() {
    // Only run napi-build when the "node" feature is active.
    // This emits the linker flags required by napi-rs.
    if std::env::var("CARGO_FEATURE_NODE").is_ok() {
        // napi-build is only in [build-dependencies] when feature = "node",
        // so we call it unconditionally here — Cargo will only compile this
        // code path when the feature is present.
        extern crate napi_build;
        napi_build::setup();
    }
    println!("cargo:rerun-if-changed=build.rs");
}