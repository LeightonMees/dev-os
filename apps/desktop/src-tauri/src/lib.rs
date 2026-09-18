//! Native side of the DEV desktop app.
//!
//! Two responsibilities, nothing else:
//!  1. a real PTY terminal (ConPTY on Windows via portable-pty) exposed as commands + events
//!  2. making sure the Node control plane is running, and telling the UI where it is
//!
//! All product state lives in the control plane; the app never opens the database itself.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// Keystrokes go through one channel drained by one thread, so writes stay ordered
    /// even though the command handlers run concurrently on the async pool.
    input: std::sync::mpsc::Sender<Vec<u8>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct PtyRegistry {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: u32,
    code: Option<u32>,
}

fn default_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        // Prefer a real PowerShell 7 install; the Store "app execution alias" under WindowsApps
        // is a reparse point that ConPTY cannot launch, so `which` skips that directory.
        let pwsh7 = PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
        if pwsh7.is_file() {
            return (pwsh7.display().to_string(), vec!["-NoLogo".into()]);
        }
        if let Some(p) = which("pwsh.exe") {
            return (p.display().to_string(), vec!["-NoLogo".into()]);
        }
        ("powershell.exe".into(), vec!["-NoLogo".into()])
    } else {
        (std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()), vec![])
    }
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.to_string_lossy().to_ascii_lowercase().contains("windowsapps"))
        .map(|p| p.join(name))
        .find(|p| p.is_file())
}

#[tauri::command]
async fn pty_spawn(app: AppHandle, registry: State<'_, Arc<PtyRegistry>>, cwd: Option<String>, shell: Option<String>, cols: u16, rows: u16) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;
    let (program, args) = match shell.filter(|s| !s.trim().is_empty()) {
        Some(s) => (s, vec![]),
        None => default_shell(),
    };
    let mut cmd = CommandBuilder::new(&program);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("DEV_TERMINAL", "1");
    eprintln!("[pty] spawning {program} {:?}", args);
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("could not start {program}: {e}"))?;
    eprintln!("[pty] spawned pid {:?}", child.process_id());
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let (input, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });

    let id = {
        let mut next = registry.next_id.lock().unwrap();
        *next += 1;
        *next
    };
    registry.sessions.lock().unwrap().insert(id, PtySession { master: pair.master, input, child });

    let app_reader = app.clone();
    let registry_reader = Arc::clone(&registry);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_reader.emit("pty-output", PtyOutput { id, data });
                }
            }
        }
        // Take the session out under the lock, then drop it outside: closing a ConPTY blocks
        // until its output is drained, so a session must never be dropped while a lock is held.
        let removed = registry_reader.sessions.lock().unwrap().remove(&id);
        let code = removed.and_then(|mut s| s.child.try_wait().ok().flatten()).map(|status| status.exit_code());
        let _ = app_reader.emit("pty-exit", PtyExit { id, code });
    });
    Ok(id)
}

#[tauri::command]
fn pty_write(registry: State<'_, Arc<PtyRegistry>>, id: u32, data: String) -> Result<(), String> {
    let sessions = registry.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    session.input.send(data.into_bytes()).map_err(|_| "terminal input closed".to_string())
}

#[tauri::command]
async fn pty_resize(registry: State<'_, Arc<PtyRegistry>>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = registry.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    session
        .master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pty_kill(registry: State<'_, Arc<PtyRegistry>>, id: u32) -> Result<(), String> {
    let removed = registry.sessions.lock().unwrap().remove(&id);
    if let Some(mut session) = removed {
        let _ = session.child.kill();
        // dropped here, with no lock held
    }
    Ok(())
}

/// Called once when the web view boots: a page reload must not leave shells running.
#[tauri::command]
async fn pty_kill_all(registry: State<'_, Arc<PtyRegistry>>) -> Result<usize, String> {
    let taken: Vec<PtySession> = registry.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
    let n = taken.len();
    for mut session in taken {
        let _ = session.child.kill();
    }
    Ok(n)
}

#[tauri::command]
fn pty_list(registry: State<'_, Arc<PtyRegistry>>) -> Vec<u32> {
    registry.sessions.lock().unwrap().keys().copied().collect()
}

#[derive(Serialize, Clone)]
struct ControlPlaneInfo {
    url: String,
    home: String,
    started: bool,
}

/// Where this checkout's repo root is: the binary lives in <root>/apps/desktop/src-tauri/target/... in dev
/// builds, or CARGO_TARGET_DIR elsewhere; DEV_REPO_ROOT overrides, and the compile-time path is the fallback.
fn repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("DEV_REPO_ROOT") {
        return PathBuf::from(root);
    }
    let compile_time = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    compile_time.join("..").join("..").join("..").canonicalize().unwrap_or(compile_time)
}

fn dev_home() -> PathBuf {
    if let Ok(home) = std::env::var("DEV_HOME") {
        return PathBuf::from(home);
    }
    repo_root().join(".dev-home")
}

fn read_control_plane_url(home: &PathBuf) -> Option<String> {
    let text = std::fs::read_to_string(home.join("control-plane.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("url").and_then(|u| u.as_str()).map(|s| s.to_string())
}

fn is_healthy(url: &str) -> bool {
    // A tiny blocking probe through curl-less std: use a TCP connect + GET.
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let Ok(mut stream) = std::net::TcpStream::connect(rest) else { return false };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1500)));
    let req = format!("GET /health HTTP/1.0\r\nHost: {rest}\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    buf.starts_with("HTTP/1.") && buf.contains("200")
}

/// Ensure the Node control plane is running; start it detached if not. Returns its URL.
#[tauri::command]
async fn control_plane_ensure() -> Result<ControlPlaneInfo, String> {
    let home = dev_home();
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    if let Ok(url) = std::env::var("DEV_CONTROL_PLANE_URL") {
        if is_healthy(&url) {
            return Ok(ControlPlaneInfo { url, home: home.display().to_string(), started: false });
        }
    }
    if let Some(url) = read_control_plane_url(&home) {
        if is_healthy(&url) {
            return Ok(ControlPlaneInfo { url, home: home.display().to_string(), started: false });
        }
    }
    let script = repo_root().join("apps").join("control-plane").join("src").join("main.ts");
    if !script.exists() {
        return Err(format!("control plane script not found at {}", script.display()));
    }
    let node = which(if cfg!(windows) { "node.exe" } else { "node" }).ok_or("node is not on PATH")?;
    let mut command = Command::new(node);
    command.arg(&script).arg("--home").arg(&home).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    command.spawn().map_err(|e| format!("could not start control plane: {e}"))?;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Some(url) = read_control_plane_url(&home) {
            if is_healthy(&url) {
                return Ok(ControlPlaneInfo { url, home: home.display().to_string(), started: true });
            }
        }
    }
    Err("control plane did not become healthy within 10s (run `dev control-plane start --foreground` to see why)".into())
}

#[tauri::command]
fn open_in_file_manager(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("{path} does not exist"));
    }
    #[cfg(windows)]
    let result = Command::new("explorer.exe").arg(&target).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&target).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(PtyRegistry::default()))
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill, pty_kill_all, pty_list, control_plane_ensure, open_in_file_manager])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("DEV");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DEV desktop");
}
