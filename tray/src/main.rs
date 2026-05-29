#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use notify_rust::Notification;
use serde::Deserialize;
use std::{
    env,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{self, Command, Stdio},
    time::{Duration, Instant},
};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
#[cfg(target_os = "macos")]
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem},
    Icon, TrayIcon, TrayIconBuilder,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayState {
    Running,
    Stopped,
}

impl TrayState {
    fn from_status(s: &DaemonStatus) -> Self {
        if !s.running {
            Self::Stopped
        } else {
            Self::Running
        }
    }
}

const APP_NAME: &str = "Hyprmnesia";
#[cfg(any(target_os = "windows", target_os = "linux"))]
const STARTUP_NAME: &str = "Hyprmnesia Tray";
const REFRESH_EVERY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize)]
struct DaemonStatus {
    running: bool,
    pid: Option<u32>,
    logs: PathBuf,
    #[allow(dead_code)]
    errors: PathBuf,
}

impl Default for DaemonStatus {
    fn default() -> Self {
        let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
        let log_dir = home.join(".hyprmnesia");
        Self {
            running: false,
            pid: None,
            logs: log_dir.join("daemon.log"),
            errors: log_dir.join("daemon.err.log"),
        }
    }
}

#[derive(Debug, Clone)]
struct AppPaths {
    hpm: PathBuf,
    log_dir: PathBuf,
    daemon_args: Vec<String>,
}

struct TrayMenu {
    status: MenuItem,
    open_tui: MenuItem,
    open_replay: MenuItem,
    start: MenuItem,
    stop: MenuItem,
    open_logs: MenuItem,
    startup: MenuItem,
    quit: MenuItem,
}

enum UserEvent {
    Menu(MenuEvent),
}

fn main() {
    let _tray_lock = match acquire_tray_lock() {
        Ok(lock) => lock,
        Err(_) => return,
    };
    clear_tray_quit_request();

    let paths = match resolve_paths() {
        Ok(paths) => paths,
        Err(_) => return,
    };
    configure_notification_application();

    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    configure_event_loop(&mut event_loop);
    let proxy = event_loop.create_proxy();
    // tray-icon menu callbacks arrive outside tao's event loop, so bounce them
    // through a user event and keep all menu state changes on one thread.
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(UserEvent::Menu(event));
    }));

    let mut tray_icon: Option<TrayIcon> = None;
    let mut tray_menu: Option<TrayMenu> = None;
    let mut last_status = DaemonStatus::default();
    let mut last_state = TrayState::Stopped;
    // Skip notifications on the very first refresh so opening the tray
    // doesn't fire a "démarré" toast just because we observed an already-running daemon.
    let mut first_refresh = true;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + REFRESH_EVERY);
        if take_tray_quit_request() {
            *control_flow = ControlFlow::Exit;
            return;
        }

        match event {
            Event::NewEvents(StartCause::Init) => {
                let (menu, items) = build_menu();
                match TrayIconBuilder::new()
                    .with_menu(Box::new(menu))
                    .with_tooltip(APP_NAME)
                    .with_icon(make_icon(TrayState::Stopped))
                    .build()
                {
                    Ok(icon) => {
                        tray_icon = Some(icon);
                        tray_menu = Some(items);
                        if env::var_os("HPM_TRAY_NO_AUTOSTART").is_none() {
                            start_daemon_if_needed(&paths);
                        }
                        refresh_menu(
                            &paths,
                            tray_menu.as_ref(),
                            tray_icon.as_ref(),
                            &mut last_status,
                            &mut last_state,
                            &mut first_refresh,
                        );
                    }
                    Err(_) => *control_flow = ControlFlow::Exit,
                }
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                refresh_menu(
                    &paths,
                    tray_menu.as_ref(),
                    tray_icon.as_ref(),
                    &mut last_status,
                    &mut last_state,
                    &mut first_refresh,
                );
            }
            Event::UserEvent(UserEvent::Menu(event)) => {
                handle_menu_event(event.id(), &paths, &mut last_status, control_flow);
                refresh_menu(
                    &paths,
                    tray_menu.as_ref(),
                    tray_icon.as_ref(),
                    &mut last_status,
                    &mut last_state,
                    &mut first_refresh,
                );
            }
            Event::LoopDestroyed => {
                drop(tray_icon.take());
            }
            _ => {}
        }
    });
}

#[cfg(target_os = "macos")]
fn configure_event_loop<T>(event_loop: &mut EventLoop<T>) {
    event_loop.set_activation_policy(ActivationPolicy::Accessory);
    event_loop.set_dock_visibility(false);
    event_loop.set_activate_ignoring_other_apps(false);
}

#[cfg(not(target_os = "macos"))]
fn configure_event_loop<T>(_: &mut EventLoop<T>) {}

#[cfg(target_os = "macos")]
fn configure_notification_application() {
    // notify-rust's macOS default asks AppleScript for an app named
    // "use_default", which opens a "Choose Application" dialog. Set a known
    // system bundle id up front so the first daemon transition notification is quiet.
    let _ = notify_rust::set_application("com.apple.finder");
}

#[cfg(not(target_os = "macos"))]
fn configure_notification_application() {}

fn build_menu() -> (Menu, TrayMenu) {
    let menu = Menu::new();
    let status = MenuItem::with_id(MenuId::new("status"), "Status: starting...", false, None);
    let open_tui = MenuItem::with_id(MenuId::new("open_tui"), "Open TUI", true, None);
    let open_replay = MenuItem::with_id(MenuId::new("open_replay"), "Open Replay...", true, None);
    let start = MenuItem::with_id(MenuId::new("start"), "Start daemon", true, None);
    let stop = MenuItem::with_id(MenuId::new("stop"), "Stop daemon", false, None);
    let open_logs = MenuItem::with_id(MenuId::new("open_logs"), "Open log folder", true, None);
    let startup = MenuItem::with_id(MenuId::new("startup"), "Enable launch at login", true, None);
    let quit = MenuItem::with_id(MenuId::new("quit"), "Quit Hyprmnesia", true, None);

    let _ = menu.append_items(&[
        &status,
        &PredefinedMenuItem::separator(),
        &open_tui,
        &open_replay,
        &PredefinedMenuItem::separator(),
        &start,
        &stop,
        &PredefinedMenuItem::separator(),
        &open_logs,
        &startup,
        &PredefinedMenuItem::separator(),
        &quit,
    ]);

    (
        menu,
        TrayMenu {
            status,
            open_tui,
            open_replay,
            start,
            stop,
            open_logs,
            startup,
            quit,
        },
    )
}

fn handle_menu_event(
    id: &MenuId,
    paths: &AppPaths,
    last_status: &mut DaemonStatus,
    control_flow: &mut ControlFlow,
) {
    match id.0.as_str() {
        "open_tui" => {
            let _ = open_tui(paths, last_status);
        }
        "open_replay" => {
            let _ = open_replay(paths);
        }
        "start" => {
            // The tray supervises the CLI daemon; it never runs capture loops
            // directly, which keeps the terminal TUI and tray lifecycles apart.
            let _ = start_daemon(paths);
        }
        "stop" => {
            let _ = run_hpm(paths, &["stop"]);
        }
        "open_logs" => {
            let dir = last_status
                .logs
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| paths.log_dir.clone());
            let _ = open_path(&dir);
        }
        "startup" => {
            let enabled = startup_enabled(&paths.hpm);
            let _ = set_startup(&paths.hpm, !enabled);
        }
        "quit" => {
            let _ = run_hpm(paths, &["stop"]);
            *control_flow = ControlFlow::Exit;
        }
        _ => {}
    }
}

fn refresh_menu(
    paths: &AppPaths,
    menu: Option<&TrayMenu>,
    icon: Option<&TrayIcon>,
    last_status: &mut DaemonStatus,
    last_state: &mut TrayState,
    first_refresh: &mut bool,
) {
    let status = read_status(paths);
    let new_state = TrayState::from_status(&status);

    let label = match new_state {
        TrayState::Running => match status.pid {
            Some(pid) => format!("Status: Running (pid {pid})"),
            None => "Status: Running".to_string(),
        },
        TrayState::Stopped => "Status: Stopped".to_string(),
    };

    if let Some(menu) = menu {
        let _ = menu.status.set_text(&label);
        let _ = menu.start.set_enabled(!status.running);
        let _ = menu.stop.set_enabled(status.running);
        let _ = menu.open_tui.set_enabled(true);
        let _ = menu.open_replay.set_enabled(true);
        let _ = menu.open_logs.set_enabled(true);
        let _ = menu.startup.set_text(if startup_enabled(&paths.hpm) {
            "Disable launch at login"
        } else {
            "Enable launch at login"
        });
        let _ = menu.quit.set_enabled(true);
    }

    let state_changed = new_state != *last_state;
    if let Some(icon) = icon {
        if state_changed || *first_refresh {
            let _ = icon.set_icon(Some(make_icon(new_state)));
        }
        // Tooltip mirrors the status label so hovering surfaces state without opening the menu.
        let tooltip = format!("{APP_NAME} — {}", label.trim_start_matches("Status: "));
        let _ = icon.set_tooltip(Some(&tooltip));
    }
    if state_changed && !*first_refresh {
        notify_transition(*last_state, new_state, status.pid);
    }

    *last_state = new_state;
    *first_refresh = false;
    *last_status = status;
}

fn notify_transition(from: TrayState, to: TrayState, pid: Option<u32>) {
    let (title, body) = match (from, to) {
        (TrayState::Stopped, TrayState::Running) => (
            "Hyprmnesia démarré",
            pid.map_or(String::new(), |p| format!("pid {p}")),
        ),
        (_, TrayState::Stopped) => ("Hyprmnesia arrêté", String::new()),
        _ => return,
    };
    let mut n = Notification::new();
    n.summary(title);
    if !body.is_empty() {
        n.body(&body);
    }
    let _ = n.show();
}

fn start_daemon_if_needed(paths: &AppPaths) {
    // Packaged app shortcuts point at the tray, so opening Hyprmnesia should
    // also ensure the background capture daemon is alive.
    if !read_status(paths).running {
        let _ = start_daemon(paths);
    }
}

fn tray_stop_path() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hyprmnesia")
        .join("tray.stop")
}

fn clear_tray_quit_request() {
    let _ = std::fs::remove_file(tray_stop_path());
}

fn take_tray_quit_request() -> bool {
    let path = tray_stop_path();
    if !path.exists() {
        return false;
    }
    let _ = std::fs::remove_file(path);
    true
}

fn acquire_tray_lock() -> io::Result<std::fs::File> {
    let lock_path = home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hyprmnesia")
        .join("tray.lock");
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    for _ in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                writeln!(file, "{}", process::id())?;
                return Ok(file);
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                if tray_lock_is_alive(&lock_path) {
                    return Err(err);
                }
                let _ = std::fs::remove_file(&lock_path);
            }
            Err(err) => return Err(err),
        }
    }

    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
}

fn tray_lock_is_alive(lock_path: &Path) -> bool {
    std::fs::read_to_string(lock_path)
        .ok()
        .and_then(|raw| raw.lines().next()?.trim().parse::<u32>().ok())
        .is_some_and(pid_alive)
}

#[cfg(target_os = "windows")]
fn pid_alive(pid: u32) -> bool {
    let script = format!(
        "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
    );
    let mut command = Command::new("powershell.exe");
    hide_command_window(&mut command);
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(target_os = "windows"))]
fn pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .is_ok_and(|status| status.success())
}

fn read_status(paths: &AppPaths) -> DaemonStatus {
    let mut command = base_command(&paths.hpm);
    command.args(["_status", "--json"]);
    command.stdout(Stdio::piped());
    command
        .output()
        .ok()
        .and_then(|output| serde_json::from_slice::<DaemonStatus>(&output.stdout).ok())
        .unwrap_or_default()
}

fn run_hpm(paths: &AppPaths, args: &[&str]) -> io::Result<()> {
    let mut command = base_command(&paths.hpm);
    command.args(args);
    command.status().map(|_| ())
}

fn start_daemon(paths: &AppPaths) -> io::Result<()> {
    let mut command = base_command(&paths.hpm);
    command.arg("_daemon").args(&paths.daemon_args);
    command.status().map(|_| ())
}

fn open_tui(paths: &AppPaths, _status: &DaemonStatus) -> io::Result<()> {
    open_terminal_for_hpm(&paths.hpm)
}

fn open_replay(paths: &AppPaths) -> io::Result<()> {
    let mut command = base_command(&paths.hpm);
    command.arg("replay");
    command.spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
fn open_terminal_for_hpm(hpm: &Path) -> io::Result<()> {
    open_windows_terminal_for_hpm(hpm).or_else(|_| open_cmd_for_hpm(hpm))
}

#[cfg(target_os = "windows")]
fn open_windows_terminal_for_hpm(hpm: &Path) -> io::Result<()> {
    let tui_command = format!("& {} tui", powershell_quote(&hpm.to_string_lossy()));
    Command::new("wt.exe")
        .args([
            "new-tab",
            "--title",
            APP_NAME,
            "powershell.exe",
            "-NoLogo",
            "-NoExit",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &tui_command,
        ])
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "windows")]
fn open_cmd_for_hpm(hpm: &Path) -> io::Result<()> {
    let mut command = Command::new("cmd.exe");
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0000_0010);
    command.args(["/K", &format!("\"{}\" tui", hpm.display())]);
    command.spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_terminal_for_hpm(hpm: &Path) -> io::Result<()> {
    let tui_command = format!("{} tui", shell_quote(&hpm.to_string_lossy()));
    let script = format!(
        "tell application \"Terminal\" to do script {}\ntell application \"Terminal\" to activate",
        apple_script_quote(&tui_command)
    );
    Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "linux")]
fn open_terminal_for_hpm(hpm: &Path) -> io::Result<()> {
    let terminal = [
        ("x-terminal-emulator", &["-e"][..]),
        ("gnome-terminal", &["--"][..]),
        ("konsole", &["-e"][..]),
        ("xfce4-terminal", &["-e"][..]),
        ("alacritty", &["-e"][..]),
        ("kitty", &["-e"][..]),
        ("xterm", &["-e"][..]),
    ]
    .into_iter()
    .find(|(program, _)| command_exists(program))
    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "terminal emulator not found"))?;

    Command::new(terminal.0)
        .args(terminal.1)
        .arg(hpm)
        .arg("tui")
        .spawn()
        .map(|_| ())
}

fn base_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    hide_command_window(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

#[cfg(not(target_os = "windows"))]
fn hide_command_window(_: &mut Command) {}

fn resolve_paths() -> io::Result<AppPaths> {
    let tray = env::current_exe()?;
    let tray_dir = tray.parent().unwrap_or_else(|| Path::new("."));
    let hpm = hpm_candidates(tray_dir)
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "hpm executable not found"))?;
    let log_dir = home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hyprmnesia");
    Ok(AppPaths {
        hpm,
        log_dir,
        daemon_args: env::args().skip(1).collect(),
    })
}

fn hpm_candidates(tray_dir: &Path) -> Vec<PathBuf> {
    let hpm = executable_name("hpm");
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut candidates = vec![tray_dir.join(&hpm)];
    // Packaged installs place the tray in `<install>/native/` and the CLI in
    // `<install>/hpm`, so the sibling-of-parent path is the only candidate that
    // resolves at Windows boot, where the Run key launches the tray with the
    // working directory set to system32 rather than the install dir.
    if let Some(parent) = tray_dir.parent() {
        candidates.push(parent.join(&hpm));
    }
    candidates.push(cwd.join("dist").join(&hpm));
    candidates.push(cwd.join(&hpm));
    candidates
}

fn executable_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn make_icon(state: TrayState) -> Icon {
    let size = 32;
    let mut rgba = Vec::with_capacity(size * size * 4);
    let primary: [u8; 4] = match state {
        TrayState::Running => [91, 213, 255, 255],
        TrayState::Stopped => [140, 140, 140, 255],
    };
    for y in 0..size {
        for x in 0..size {
            let mut color = [18, 20, 24, 255];
            let in_left = (8..=11).contains(&x) && (7..=24).contains(&y);
            let in_right = (20..=23).contains(&x) && (7..=24).contains(&y);
            let in_bridge = (8..=23).contains(&x) && (14..=17).contains(&y);
            let in_border = x == 2 || x == 29 || y == 2 || y == 29;
            if in_left || in_right || in_bridge {
                color = primary;
            } else if in_border {
                color = [78, 92, 112, 255];
            }
            rgba.extend_from_slice(&color);
        }
    }
    Icon::from_rgba(rgba, size as u32, size as u32).expect("valid tray icon")
}

fn home_dir() -> Option<PathBuf> {
    env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
}

fn open_path(path: &Path) -> io::Result<()> {
    if cfg!(target_os = "windows") {
        Command::new("explorer.exe").arg(path).spawn().map(|_| ())
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(path).spawn().map(|_| ())
    } else {
        Command::new("xdg-open").arg(path).spawn().map(|_| ())
    }
}

#[cfg(target_os = "linux")]
fn command_exists(program: &str) -> bool {
    env::var_os("PATH")
        .is_some_and(|paths| env::split_paths(&paths).any(|dir| dir.join(program).exists()))
}

#[cfg(target_os = "windows")]
fn startup_enabled(tray: &Path) -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run") else {
        return false;
    };
    let Ok(value): Result<String, _> = key.get_value(STARTUP_NAME) else {
        return false;
    };
    value.contains(&tray.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn set_startup(tray: &Path, enabled: bool) -> io::Result<()> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")?;
    if enabled {
        key.set_value(STARTUP_NAME, &format!("\"{}\"", tray.display()))?;
    } else {
        let _ = key.delete_value(STARTUP_NAME);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn startup_enabled(tray: &Path) -> bool {
    startup_file()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|content| content.contains(&tray.to_string_lossy().to_string()))
}

#[cfg(target_os = "macos")]
fn set_startup(tray: &Path, enabled: bool) -> io::Result<()> {
    let Some(path) = startup_file() else {
        return Ok(());
    };
    if enabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, macos_launch_agent(tray))
    } else {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }
}

#[cfg(target_os = "linux")]
fn startup_enabled(tray: &Path) -> bool {
    startup_file()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|content| content.contains(&tray.to_string_lossy().to_string()))
}

#[cfg(target_os = "linux")]
fn set_startup(tray: &Path, enabled: bool) -> io::Result<()> {
    let Some(path) = startup_file() else {
        return Ok(());
    };
    if enabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, linux_desktop_entry(tray))
    } else {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn startup_file() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return home_dir().map(|home| {
            home.join("Library")
                .join("LaunchAgents")
                .join("com.hyprmnesia.tray.plist")
        });
    }

    let config_home = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".config")))?;
    Some(
        config_home
            .join("autostart")
            .join("hyprmnesia-tray.desktop"),
    )
}

#[cfg(target_os = "macos")]
fn macos_launch_agent(tray: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hyprmnesia.tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
        xml_escape(&tray.to_string_lossy())
    )
}

#[cfg(target_os = "linux")]
fn linux_desktop_entry(tray: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName={STARTUP_NAME}\nExec={}\nX-GNOME-Autostart-enabled=true\n",
        shell_quote(&tray.to_string_lossy())
    )
}

#[cfg(target_os = "macos")]
fn apple_script_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "windows")]
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn candidates_include_parent_for_packaged_layout() {
        // Packaged installs put the tray in `<install>/native/` and the CLI in
        // `<install>/hpm`; without the parent candidate the tray cannot find hpm
        // when launched at boot with an unrelated working directory.
        let tray_dir = Path::new("/opt/hyprmnesia/native");
        let expected = tray_dir.parent().unwrap().join(executable_name("hpm"));
        assert!(hpm_candidates(tray_dir).contains(&expected));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn candidates_include_parent_for_windows_install() {
        // MSI installs land under %LOCALAPPDATA%\Programs\Hyprmnesia\native; at
        // boot the Run key launches the tray with cwd = system32, so the
        // sibling-of-parent candidate is the only one that resolves.
        let tray_dir = Path::new(r"C:\Users\Test\AppData\Local\Programs\Hyprmnesia\native");
        let expected = tray_dir.parent().unwrap().join("hpm.exe");
        assert!(hpm_candidates(tray_dir).contains(&expected));
    }
}
