//! Build script: on the MSVC Windows target, embed an application manifest that
//! declares `requestedExecutionLevel=asInvoker`.
//!
//! Windows' UAC "installer detection" heuristic forces elevation for any
//! executable whose name contains "update"/"setup"/"install"/"patch". Because
//! this crate's name contains "updater", its test harness binary
//! (`hampy_updater-*.exe`) would otherwise fail to launch with
//! `ERROR_ELEVATION_REQUIRED` (os error 740). A manifest declaring an explicit
//! execution level disables that heuristic.

use std::path::Path;

fn main() {
    // Build scripts run on the host, so inspect the *target* via Cargo's env.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }

    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("hampy-updater.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());

    // MSVC `link.exe`: embed the manifest into executable artifacts. The
    // unscoped `rustc-link-arg` applies to bins and tests (not rlibs), which is
    // exactly the test harness that needs it.
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
