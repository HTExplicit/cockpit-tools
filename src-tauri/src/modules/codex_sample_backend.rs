//! Process-local backend selection for the optional native prediction adapter.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const CLI_VERSION: &str = "0.166.0-alpha.5.1";
const CLI_COMMIT: &str = "f79b26ccbb3116b052544666a181012fb45dc49b";
const APP_VERSION: &str = "26.1027.3384.0";
const PATCH_REVISION: u32 = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackendManifest {
    schema_version: u32,
    upstream: Upstream,
    patch_revision: u32,
    app_version: String,
    official_cli_sha256: String,
    official_asar_sha256: String,
    files: Vec<BackendFile>,
}

#[derive(Deserialize)]
struct Upstream {
    version: String,
    commit: String,
}

#[derive(Deserialize)]
struct BackendFile {
    path: PathBuf,
    sha256: String,
}

fn backend_error(reason: impl std::fmt::Display) -> String {
    format!("CODEX_SAMPLE_BACKEND_REQUIRED: {reason}. Disable Native next-step predictions to start with the official backend.")
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| backend_error(error))?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|error| backend_error(error))?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn verify_hash(path: &Path, expected: &str, label: &str) -> Result<(), String> {
    if sha256(path)? != expected.to_ascii_lowercase() {
        return Err(backend_error(format!(
            "{label} does not match the pinned prediction backend"
        )));
    }
    Ok(())
}

fn resolve_at(manifest_path: &Path, official_gui: &Path) -> Result<PathBuf, String> {
    let manifest: BackendManifest = serde_json::from_slice(
        &std::fs::read(manifest_path).map_err(|error| backend_error(error))?,
    )
    .map_err(|error| backend_error(format!("Invalid prediction backend manifest: {error}")))?;
    if manifest.schema_version != 1
        || manifest.upstream.version != CLI_VERSION
        || manifest.upstream.commit != CLI_COMMIT
        || manifest.patch_revision != PATCH_REVISION
        || manifest.app_version != APP_VERSION
    {
        return Err(backend_error(
            "Prediction backend version does not match this adapter",
        ));
    }
    let resources = official_gui
        .parent()
        .ok_or_else(|| backend_error("Codex executable has no application directory"))?
        .join("resources");
    verify_hash(
        &resources.join("codex.exe"),
        &manifest.official_cli_sha256,
        "Official CLI",
    )?;
    verify_hash(
        &resources.join("app.asar"),
        &manifest.official_asar_sha256,
        "Official app",
    )?;

    let root = manifest_path
        .parent()
        .ok_or_else(|| backend_error("Missing backend directory"))?;
    let mut paths = HashSet::new();
    for file in &manifest.files {
        if file.path.as_os_str().is_empty()
            || !file
                .path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || !paths.insert(file.path.clone())
        {
            return Err(backend_error("Invalid prediction backend file path"));
        }
        verify_hash(
            &root.join(&file.path),
            &file.sha256,
            "Prediction runtime file",
        )?;
    }
    if !paths.contains(Path::new("codex.exe")) {
        return Err(backend_error("Prediction backend executable is missing"));
    }
    root.join("codex.exe").canonicalize().map_err(backend_error)
}

fn apply_backend_env(
    enabled: bool,
    official_gui: &Path,
    manifest: &Path,
    existing: &[(String, String)],
) -> Result<Vec<(String, String)>, String> {
    if !enabled {
        return Ok(existing.to_vec());
    }
    let executable = resolve_at(manifest, official_gui)?;
    let mut env = existing
        .iter()
        .filter(|(key, _)| !key.eq_ignore_ascii_case("CODEX_CLI_PATH"))
        .cloned()
        .collect::<Vec<_>>();
    env.push((
        "CODEX_CLI_PATH".into(),
        executable.to_string_lossy().into_owned(),
    ));
    Ok(env)
}

pub(crate) fn launch_env(
    profile: &Path,
    official_gui: &Path,
    existing: &[(String, String)],
) -> Result<Vec<(String, String)>, String> {
    let enabled =
        crate::modules::codex_app_enhancements::native_predictions_enabled_for_profile(profile);
    if !enabled {
        return Ok(existing.to_vec());
    }
    let manifest = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecars/codex-sample/bin/manifest.json")
    } else {
        std::env::current_exe()
            .map_err(backend_error)?
            .parent()
            .ok_or_else(|| backend_error("Cockpit executable has no installation directory"))?
            .join("codex-sample/patch-2/manifest.json")
    };
    apply_backend_env(true, official_gui, &manifest, existing)
}

#[cfg(test)]
#[path = "codex_sample_backend_tests.rs"]
mod tests;
