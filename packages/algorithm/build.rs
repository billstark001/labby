// Build script for napi-rs native Node.js addon.
// Only active when the `node` feature is enabled.
#[cfg(feature = "node")]
extern crate napi_build;

fn main() {
    #[cfg(feature = "node")]
    napi_build::setup();
}
