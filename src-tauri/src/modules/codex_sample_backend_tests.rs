use super::*;

struct Fixture {
    _directory: tempfile::TempDir,
    gui: PathBuf,
    manifest: PathBuf,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let app = directory.path().join("app");
    let backend = directory.path().join("codex-sample");
    std::fs::create_dir_all(app.join("resources")).unwrap();
    std::fs::create_dir_all(&backend).unwrap();
    let gui = app.join("ChatGPT.exe");
    std::fs::write(&gui, "synthetic-gui").unwrap();
    std::fs::write(app.join("resources/codex.exe"), "synthetic-official-cli").unwrap();
    std::fs::write(app.join("resources/app.asar"), "synthetic-official-app").unwrap();
    std::fs::write(backend.join("codex.exe"), "synthetic-patched-cli").unwrap();
    std::fs::write(backend.join("rg.exe"), "synthetic-helper").unwrap();
    let manifest = backend.join("manifest.json");
    let value = serde_json::json!({
        "schemaVersion": 1,
        "upstream": { "version": CLI_VERSION, "commit": CLI_COMMIT },
        "patchRevision": PATCH_REVISION,
        "appVersion": APP_VERSION,
        "officialCliSha256": sha256(&app.join("resources/codex.exe")).unwrap(),
        "officialAsarSha256": sha256(&app.join("resources/app.asar")).unwrap(),
        "files": [
            { "path": "codex.exe", "sha256": sha256(&backend.join("codex.exe")).unwrap() },
            { "path": "rg.exe", "sha256": sha256(&backend.join("rg.exe")).unwrap() }
        ]
    });
    std::fs::write(&manifest, value.to_string()).unwrap();
    Fixture {
        _directory: directory,
        gui,
        manifest,
    }
}

#[test]
fn eligible_profile_sets_only_process_local_cli_and_preserves_other_env() {
    let fixture = fixture();
    let env = apply_backend_env(
        true,
        &fixture.gui,
        &fixture.manifest,
        &[
            ("HTTPS_PROXY".into(), "synthetic-proxy".into()),
            ("CODEX_CLI_PATH".into(), "old-cli.exe".into()),
        ],
    )
    .unwrap();
    assert_eq!(env[0], ("HTTPS_PROXY".into(), "synthetic-proxy".into()));
    assert_eq!(env.len(), 2);
    assert_eq!(env[1].0, "CODEX_CLI_PATH");
    assert_eq!(
        Path::new(&env[1].1),
        fixture
            .manifest
            .parent()
            .unwrap()
            .join("codex.exe")
            .canonicalize()
            .unwrap()
    );
}

#[test]
fn disabled_or_ineligible_profile_does_not_require_an_artifact() {
    let env = vec![("NODE_OPTIONS".into(), "synthetic-hook".into())];
    assert_eq!(
        apply_backend_env(
            false,
            Path::new("missing-app"),
            Path::new("missing-manifest"),
            &env
        )
        .unwrap(),
        env
    );
}

#[test]
fn new_profile_without_config_can_start_without_a_prediction_backend() {
    let directory = tempfile::tempdir().unwrap();
    let env = vec![("NODE_OPTIONS".into(), "synthetic-login-hook".into())];
    assert_eq!(
        launch_env(directory.path(), Path::new("missing-official-app"), &env).unwrap(),
        env
    );
    assert!(!directory.path().join("config.toml").exists());
}

#[test]
fn oauth_profile_can_start_without_a_prediction_backend() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("config.toml"),
        "model_provider = 'openai'\n",
    )
    .unwrap();
    std::fs::write(
        directory.path().join("auth.json"),
        r#"{"tokens":{"id_token":"synthetic-id","access_token":"synthetic-access"}}"#,
    )
    .unwrap();
    assert_eq!(
        launch_env(directory.path(), Path::new("missing-official-app"), &[]).unwrap(),
        Vec::<(String, String)>::new()
    );
}

#[test]
fn eligible_profile_rejects_missing_or_changed_backend() {
    let fixture = fixture();
    std::fs::write(
        fixture.manifest.parent().unwrap().join("rg.exe"),
        "changed-helper",
    )
    .unwrap();
    assert!(resolve_at(&fixture.manifest, &fixture.gui)
        .unwrap_err()
        .contains("Prediction runtime file"));
    std::fs::remove_file(&fixture.manifest).unwrap();
    assert!(resolve_at(&fixture.manifest, &fixture.gui)
        .unwrap_err()
        .starts_with("CODEX_SAMPLE_BACKEND_REQUIRED:"));
}

#[test]
fn official_app_or_cli_update_requires_a_matching_backend() {
    for resource in ["codex.exe", "app.asar"] {
        let fixture = fixture();
        std::fs::write(
            fixture
                .gui
                .parent()
                .unwrap()
                .join("resources")
                .join(resource),
            "new-official-version",
        )
        .unwrap();
        assert!(resolve_at(&fixture.manifest, &fixture.gui)
            .unwrap_err()
            .contains("does not match"));
    }
}

#[test]
fn manifest_rejects_wrong_version_and_paths_outside_the_runtime() {
    let fixture = fixture();
    let original = std::fs::read(&fixture.manifest).unwrap();
    for field in ["schemaVersion", "patchRevision", "appVersion"] {
        let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
        value[field] = if field == "appVersion" {
            serde_json::json!("future")
        } else {
            serde_json::json!(999)
        };
        std::fs::write(&fixture.manifest, value.to_string()).unwrap();
        assert!(resolve_at(&fixture.manifest, &fixture.gui)
            .unwrap_err()
            .contains("version"));
    }
    for field in ["version", "commit"] {
        let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
        value["upstream"][field] = serde_json::json!("unmatched");
        std::fs::write(&fixture.manifest, value.to_string()).unwrap();
        assert!(resolve_at(&fixture.manifest, &fixture.gui)
            .unwrap_err()
            .contains("version"));
    }
    let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
    value["files"][0]["path"] = serde_json::json!("../codex.exe");
    std::fs::write(&fixture.manifest, value.to_string()).unwrap();
    assert!(resolve_at(&fixture.manifest, &fixture.gui)
        .unwrap_err()
        .contains("file path"));
}
