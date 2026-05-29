use serde_json::Value;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_hpm-ocr")
}

fn run(args: &[&str]) -> (std::process::ExitStatus, Value) {
    let output = Command::new(bin())
        .args(args)
        .output()
        .expect("run hpm-ocr");
    let stdout = String::from_utf8(output.stdout).expect("stdout is utf8");
    let trimmed = stdout.trim();
    assert!(!trimmed.is_empty(), "hpm-ocr should emit one JSON line");
    assert_eq!(
        trimmed.lines().count(),
        1,
        "hpm-ocr should emit exactly one JSON line, got {trimmed:?}",
    );
    let value = serde_json::from_str(trimmed).expect("parse hpm-ocr JSON");
    (output.status, value)
}

#[test]
fn missing_image_path_argument_returns_error_json_and_nonzero_exit() {
    let (status, value) = run(&[]);

    assert!(!status.success(), "missing path should fail");
    assert_eq!(value.get("ok").and_then(Value::as_bool), Some(false));
    assert!(
        value
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|msg| msg.contains("missing image path argument")),
        "got: {value}",
    );
    assert!(value.get("engine").and_then(Value::as_str).is_some());
}

#[test]
fn missing_file_returns_error_json_and_nonzero_exit() {
    let missing = std::env::temp_dir().join(format!(
        "hpm-ocr-missing-{}-{}.png",
        std::process::id(),
        unique_suffix()
    ));
    let missing_str = missing.to_string_lossy().to_string();
    let (status, value) = run(&[missing_str.as_str()]);

    assert!(!status.success(), "missing file should fail");
    assert_eq!(value.get("ok").and_then(Value::as_bool), Some(false));
    assert!(
        value
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|msg| msg.contains("image not found")),
        "got: {value}",
    );
}

#[cfg(not(windows))]
#[test]
fn existing_file_on_unsupported_platform_returns_stable_error_json() {
    use std::fs;

    let path = std::env::temp_dir().join(format!(
        "hpm-ocr-existing-{}-{}.png",
        std::process::id(),
        unique_suffix()
    ));
    fs::write(&path, b"not really an image").expect("write fixture");
    let path_str = path.to_string_lossy().to_string();

    let (status, value) = run(&[path_str.as_str()]);

    fs::remove_file(&path).ok();
    assert!(!status.success(), "unsupported platform should fail");
    assert_eq!(value.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        value.get("engine").and_then(Value::as_str),
        Some("unsupported")
    );
    assert!(
        value
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|msg| msg.contains("not implemented")),
        "got: {value}",
    );
}

fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time")
        .as_nanos()
}
