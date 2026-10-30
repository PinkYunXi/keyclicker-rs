// KeyClicker Rust —— 主程序：窗口 + WebView2 宿主 + IPC 桥接 + 任务引擎
mod config;
mod hook;
mod hotkeys;
mod input;
mod keys;
mod tasks;
mod tray;
mod ui_assets;
mod winmatch;

use std::cell::RefCell;
use std::os::windows::process::CommandExt;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::{SetCurrentProcessExplicitAppUserModelID, ShellExecuteW};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::Win32::UI::WindowsAndMessaging::{HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::WindowExtWindows;
use tao::window::WindowBuilder;
use wry::{WebView, WebViewBuilder, WebViewBuilderExtWindows};

/// 子进程不创建控制台窗口（否则 reg.exe 会闪黑窗）
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone)]
enum UserEvent {
    Drag,
    Minimize,
    Maximize,
    Close,
    TaskEvent(String),
    Hotkey(i32),
    Record(hook::RecordEvent),
    GrabTick(i32),
    GrabResult(Value),
    Tray,
}

struct RecordingState {
    mode: String,
    combos: Vec<String>,
}

fn hwnd_from(h: isize) -> HWND {
    HWND(h as *mut core::ffi::c_void)
}

struct AppState {
    config: config::Config,
    config_path: PathBuf,
    hwnd: isize,
}

/// 单实例：已存在同名 Mutex 则提示并返回 false
fn ensure_single_instance() -> bool {
    unsafe {
        let m = windows::Win32::System::Threading::CreateMutexW(None, true, windows::core::w!("KeyClicker.SingleInstance"));
        if let Ok(h) = m {
            if windows::Win32::Foundation::GetLastError() == windows::Win32::Foundation::ERROR_ALREADY_EXISTS {
                let _ = windows::Win32::UI::WindowsAndMessaging::MessageBoxW(
                    None,
                    windows::core::w!("KeyClicker 已在运行"),
                    windows::core::w!("KeyClicker"),
                    windows::Win32::UI::WindowsAndMessaging::MB_OK | windows::Win32::UI::WindowsAndMessaging::MB_ICONINFORMATION,
                );
                let _ = h;
                return false;
            }
            std::mem::forget(h);
        }
        true
    }
}

/// 读系统主题：AppsUseLightTheme == 1 表示浅色
fn system_theme() -> String {
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "/v", "AppsUseLightTheme"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    if let Ok(out) = out {
        let text = String::from_utf8_lossy(&out.stdout);
        if text.contains("0x1") {
            return "light".into();
        }
    }
    "dark".into()
}

fn resolve_theme(theme: &str) -> String {
    if theme == "system" { system_theme() } else { theme.to_string() }
}
/// 调试日志：只有设置环境变量 KC_LOG=1 时才写（发布版默认不产生任何日志文件）
/// Win11 判断：CurrentBuildNumber >= 22000
fn is_windows_11() -> bool {
    let out = std::process::Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "/v", "CurrentBuildNumber"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    if let Ok(out) = out {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(idx) = text.find("REG_SZ") {
            if let Ok(build) = text[idx + 6..].trim().parse::<u32>() {
                return build >= 22000;
            }
        }
    }
    false
}
/// 用 ShellExecute 打开 URL（不经过 cmd，避免黑窗闪一下）
fn open_url(url: &str) {
    let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(wide.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        );
    }
}

/// 是否已安装 WebView2 运行时
fn webview2_installed() -> bool {
    for p in [
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
        r"C:\Program Files\Microsoft\EdgeWebView\Application",
    ] {
        if std::path::Path::new(p).is_dir() {
            return true;
        }
    }
    false
}

/// 从内嵌的 Evergreen bootstrapper 静默安装 WebView2
fn install_webview2() -> bool {
    let bytes: &[u8] = include_bytes!("../assets/MicrosoftEdgeWebview2Setup.exe");
    let path = std::env::temp_dir().join("MicrosoftEdgeWebview2Setup.exe");
    if std::fs::write(&path, bytes).is_err() {
        return false;
    }
    let ok = std::process::Command::new(&path)
        .args(["/silent", "/install"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|st| st.success())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&path);
    ok
}

/// 从内嵌 ICO 取 32x32 PNG 解码成窗口/任务栏图标
fn load_window_icon() -> Option<tao::window::Icon> {
    let bytes: &[u8] = include_bytes!("../assets/keyclicker.ico");
    if bytes.len() < 6 {
        return None;
    }
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    let mut best: Option<&[u8]> = None;
    for i in 0..count {
        let off = 6 + i * 16;
        if off + 16 > bytes.len() {
            break;
        }
        let w = bytes[off] as usize;
        let size = u32::from_le_bytes([bytes[off + 8], bytes[off + 9], bytes[off + 10], bytes[off + 11]]) as usize;
        let img = u32::from_le_bytes([bytes[off + 12], bytes[off + 13], bytes[off + 14], bytes[off + 15]]) as usize;
        if img + size <= bytes.len() && w == 32 {
            best = Some(&bytes[img..img + size]);
            break;
        }
    }
    let png_bytes = best?;
    let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    let rgba: Vec<u8> = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf
            .chunks(3)
            .flat_map(|c| [c[0], c[1], c[2], 255])
            .collect(),
        _ => return None,
    };
    tao::window::Icon::from_rgba(rgba, info.width, info.height).ok()
}
pub fn log_ipc(msg: &str) {
    if std::env::var_os("KC_LOG").is_none() {
        return;
    }
    let path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("keyclicker.log")))
        .unwrap_or_else(|| PathBuf::from("keyclicker.log"));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{msg}");
    }
}

fn start_ui_server(root: Option<PathBuf>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ui server");
    let port = listener.local_addr().expect("addr").port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let root = root.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let rel = if path == "/" { "/index.html" } else { path.as_str() };
                let (body, code) = if rel.contains("..") {
                    (b"bad request".to_vec(), "400 Bad Request")
                } else {
                    match &root {
                        Some(dir) => {
                            let full = dir.join(rel.trim_start_matches('/'));
                            match std::fs::read(&full) {
                                Ok(b) => (b, "200 OK"),
                                Err(_) => (b"not found".to_vec(), "404 Not Found"),
                            }
                        }
                        None => {
                            let key = rel.trim_start_matches('/');
                            match ui_assets::FILES.iter().find(|(name, _)| *name == key) {
                                Some((_, data)) => (data.to_vec(), "200 OK"),
                                None => (b"not found".to_vec(), "404 Not Found"),
                            }
                        }
                    }
                };
                let ext = std::path::Path::new(rel)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                let mime = match ext {
                    "html" => "text/html; charset=utf-8",
                    "css" => "text/css; charset=utf-8",
                    "js" => "text/javascript; charset=utf-8",
                    "svg" => "image/svg+xml",
                    "png" => "image/png",
                    "ico" => "image/x-icon",
                    _ => "application/octet-stream",
                };
                let head = format!(
                    "HTTP/1.1 {code}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(&body);
            });
        }
    });
    port
}

const SHIM: &str = r#"
(function () {
  var listeners = [];
  window.__kcWryBridge = {
    send: function (obj) {
      var text = JSON.stringify(obj);
      if (window.ipc && typeof window.ipc.postMessage === "function") {
        window.ipc.postMessage(text);
      } else if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(text);
      }
    },
    onMessage: function (cb) { listeners.push(cb); },
    dispatch: function (payload) {
      var ev = { data: payload };
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](ev); } catch (e) { console.log(e); }
      }
    }
  };
})();
"#;

fn dispatch_js(holder: &Rc<RefCell<Option<WebView>>>, raw: &str) {
    if let Some(wv) = holder.borrow().as_ref() {
        let js = format!("window.__kcWryBridge && window.__kcWryBridge.dispatch({raw})");
        if let Err(e) = wv.evaluate_script(&js) {
            log_ipc(&format!("evaluate error: {e}"));
        }
    }
}

fn respond(holder: &Rc<RefCell<Option<WebView>>>, value: Value) {
    dispatch_js(holder, &value.to_string());
}

fn toast(holder: &Rc<RefCell<Option<WebView>>>, level: &str, message: &str) {
    respond(holder, json!({ "event": "toast", "data": { "level": level, "message": message } }));
}

fn handle_ipc(
    body: &str,
    proxy: &EventLoopProxy<UserEvent>,
    holder: &Rc<RefCell<Option<WebView>>>,
    state: &Rc<RefCell<AppState>>,
    tasks: &Arc<tasks::TaskManager>,
    recording: &Rc<RefCell<Option<RecordingState>>>,
) {
    let req: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return,
    };
    log_ipc(&format!("ipc: {}", &body.chars().take(120).collect::<String>()));
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let cmd = req.get("cmd").and_then(|v| v.as_str()).unwrap_or("");

    let data = match cmd {
        "app.ready" => {
            let st = state.borrow();
            json!({
                "version": "0.3.0",
                "theme": resolve_theme(&st.config.theme),
                "portable": true,
                "elevated": false,
                "win11": true,
                "mica": false,
                "configPath": st.config_path.to_string_lossy(),
            })
        }
        "config.get" => serde_json::to_value(&state.borrow().config).unwrap_or(Value::Null),
        "config.set" => {
            let mut st = state.borrow_mut();
            if let Some(cfg_val) = req.pointer("/args/config") {
                if let Ok(text) = serde_json::to_string(cfg_val) {
                    if let Ok(cfg) = config::Config::from_json(&text) {
                        st.config = cfg;
                        if let Err(e) = config::save_config_atomic(&st.config_path, &st.config) {
                            log_ipc(&format!("save error: {e}"));
                        }
                    }
                }
            }
            json!({ "saved": true })
        }
        "keys.validate" => {
            let text = req.pointer("/args/text").and_then(|v| v.as_str()).unwrap_or("");
            let v = keys::validate_keys(text);
            json!({ "valid": v.valid, "normalized": v.normalized, "keys": v.keys, "error": v.error })
        }
        "hotkey.get" => {
            let st = state.borrow();
            json!({ "toggle": st.config.hotkeys.toggle, "panic": st.config.hotkeys.panic })
        }
        "hotkey.set" => {
            let mut st = state.borrow_mut();
            if let Some(t) = req.pointer("/args/toggle").and_then(|v| v.as_str()) {
                if !t.is_empty() {
                    st.config.hotkeys.toggle = t.to_string();
                }
            }
            if let Some(p) = req.pointer("/args/panic").and_then(|v| v.as_str()) {
                if !p.is_empty() {
                    st.config.hotkeys.panic = p.to_string();
                }
            }
            let (ok1, ok2) = hotkeys::re_register(st.hwnd, &st.config.hotkeys.toggle, &st.config.hotkeys.panic);
            log_ipc(&format!("hotkeys toggle={ok1} panic={ok2}"));
            let _ = config::save_config_atomic(&st.config_path, &st.config);
            json!({ "toggle": st.config.hotkeys.toggle, "panic": st.config.hotkeys.panic })
        }
        "app.setTheme" => {
            let theme = req.pointer("/args/theme").and_then(|v| v.as_str()).unwrap_or("dark").to_string();
            let mut st = state.borrow_mut();
            st.config.theme = theme.clone();
            let _ = config::save_config_atomic(&st.config_path, &st.config);
            json!({ "theme": resolve_theme(&theme) })
        }
        "task.add" => {
            let page = req.pointer("/args/pageIndex").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let spec_val = req.pointer("/args/task").cloned().unwrap_or(Value::Null);
            match serde_json::from_str::<config::TaskSpec>(&spec_val.to_string()) {
                Ok(spec) => json!({ "id": tasks.add(&spec, page) }),
                Err(e) => {
                    respond(holder, json!({ "id": id, "ok": false, "error": { "code": "invalid_args", "message": format!("任务参数错误：{e}") } }));
                    return;
                }
            }
        }
        "task.list" => tasks.snapshot_json(),
        "task.start" | "task.pause" | "task.resume" | "task.stop" | "task.remove" => {
            let tid = req.pointer("/args/id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            match cmd {
                "task.start" => {
                    tasks.start(&tid);
                }
                "task.pause" => {
                    tasks.pause(&tid);
                }
                "task.resume" => {
                    tasks.resume(&tid);
                }
                "task.stop" => {
                    tasks.stop(&tid);
                }
                _ => {
                    tasks.remove(&tid);
                }
            }
            tasks.snapshot_json()
        }
        "task.startAll" => {
            let page = req.pointer("/args/pageIndex").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            tasks.start_page(page);
            tasks.snapshot_json()
        }
        "task.stopAll" => {
            let page = req.pointer("/args/pageIndex").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            tasks.stop_page(page);
            tasks.snapshot_json()
        }
        "task.stopEverywhere" => {
            tasks.stop_all();
            tasks.snapshot_json()
        }
        "window.foreground" => json!({
            "title": winmatch::foreground_title(),
            "process": winmatch::foreground_process(),
        }),
        "window.list" => json!({ "titles": winmatch::list_visible_titles(40) }),
        "window.grabStart" => {
            let seconds = req.pointer("/args/seconds").and_then(|v| v.as_i64()).unwrap_or(3).max(1);
            let proxy_g = proxy.clone();
            std::thread::spawn(move || {
                for left in (0..seconds).rev() {
                    let _ = proxy_g.send_event(UserEvent::GrabTick(left as i32 + 1));
                    std::thread::sleep(std::time::Duration::from_millis(900));
                }
                let title = winmatch::foreground_title();
                let is_self = winmatch::foreground_is_self();
                let result = if is_self {
                    json!({ "ok": false, "reason": "self" })
                } else if title.trim().is_empty() {
                    json!({ "ok": false, "reason": "empty" })
                } else {
                    json!({ "ok": true, "title": title })
                };
                let _ = proxy_g.send_event(UserEvent::GrabResult(result));
            });
            json!({ "started": true })
        },
        "record.begin" => {
            let mode = req.pointer("/args/mode").and_then(|v| v.as_str()).unwrap_or("single").to_string();
            hook::set_recording(true);
            *recording.borrow_mut() = Some(RecordingState { mode, combos: Vec::new() });
            json!({ "recording": true })
        },
        "record.cancel" => {
            hook::set_recording(false);
            *recording.borrow_mut() = None;
            json!({ "recording": false })
        },
        "app.openConfigDir" => {
            let st = state.borrow();
            if let Some(dir) = st.config_path.parent() {
                let _ = std::process::Command::new("explorer.exe").arg(dir).spawn();
            }
            Value::Null
        },
        "app.devtools" => {
            if let Some(wv) = holder.borrow().as_ref() {
                wv.open_devtools();
            }
            Value::Null
        },
        "app.setAlwaysOnTop" => {
            let on = req.pointer("/args/on").and_then(|v| v.as_bool()).unwrap_or(false);
            let hwnd = state.borrow().hwnd;
            let insert_after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
            unsafe {
                let _ = SetWindowPos(hwnd_from(hwnd), Some(insert_after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            }
            let mut st = state.borrow_mut();
            st.config.window.always_on_top = on;
            json!({ "on": on })
        },
        "app.window" => {
            match req.pointer("/args/action").and_then(|v| v.as_str()).unwrap_or("") {
                "minimize" => {
                    let _ = proxy.send_event(UserEvent::Minimize);
                }
                "maximize" | "restore" => {
                    let _ = proxy.send_event(UserEvent::Maximize);
                }
                "close" => {
                    let _ = proxy.send_event(UserEvent::Close);
                }
                _ => {}
            }
            Value::Null
        }
        "app.drag" | "app.dragStart" => {
            let _ = proxy.send_event(UserEvent::Drag);
            Value::Null
        }
        _ => {
            respond(holder, json!({ "id": id, "ok": false, "error": { "code": "internal", "message": format!("未实现：{cmd}") } }));
            return;
        }
    };

    respond(holder, json!({ "id": id, "ok": true, "data": data }));
}

fn main() -> wry::Result<()> {
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(windows::core::w!("KeyClicker.Desktop"));
    }
    if !webview2_installed() {
        let proceed = unsafe {
            windows::Win32::UI::WindowsAndMessaging::MessageBoxW(
                None,
                windows::core::w!("检测到未安装 Microsoft Edge WebView2 运行时（Windows 10 需要单独安装）。\n\n点击“确定”将自动安装（需要联网，约 1 分钟）。"),
                windows::core::w!("KeyClicker"),
                windows::Win32::UI::WindowsAndMessaging::MB_OKCANCEL | windows::Win32::UI::WindowsAndMessaging::MB_ICONINFORMATION,
            )
        };
        if proceed == windows::Win32::UI::WindowsAndMessaging::IDOK {
            if install_webview2() && webview2_installed() {
                unsafe {
                    let _ = windows::Win32::UI::WindowsAndMessaging::MessageBoxW(
                        None,
                        windows::core::w!("WebView2 运行时安装完成，请重新打开 KeyClicker。"),
                        windows::core::w!("KeyClicker"),
                        windows::Win32::UI::WindowsAndMessaging::MB_OK | windows::Win32::UI::WindowsAndMessaging::MB_ICONINFORMATION,
                    );
                }
            } else {
                open_url("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            }
        }
        return Ok(());
    }
    if !ensure_single_instance() {
        return Ok(());
    }
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_window_icon(load_window_icon())
        .with_title("KeyClicker")
        .with_decorations(false)
        .with_min_inner_size(tao::dpi::LogicalSize::new(720.0, 520.0))
        .with_inner_size(tao::dpi::LogicalSize::new(900.0, 640.0))
        .with_maximizable(false)
        .with_max_inner_size(tao::dpi::LogicalSize::new(1120.0, 800.0))
        .build(&event_loop)
        .expect("create window");
    let hwnd = window.hwnd() as isize;
    if is_windows_11() {
    unsafe {
        let pref: i32 = 2; // DWMWCP_ROUND
        let _ = windows::Win32::Graphics::Dwm::DwmSetWindowAttribute(
            hwnd_from(hwnd),
            windows::Win32::Graphics::Dwm::DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
    }

    // 默认使用内嵌 UI（单 exe）；设置 KC_UI 环境变量可切换到磁盘目录（开发用）
    let dev_ui = std::env::var("KC_UI").ok().map(|p| {
        let path = PathBuf::from(p);
        path.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
    });
    log_ipc(if dev_ui.is_some() { "ui: disk (dev)" } else { "ui: embedded" });
    let port = start_ui_server(dev_ui);
    let url = format!("http://127.0.0.1:{port}/index.html");
    log_ipc(&format!("ui url: {url}"));

    let config_path = config::resolve_config_path();
    log_ipc(&format!("config: {}", config_path.display()));
    let mut loaded = config::load_config(&config_path);

    // 任务引擎：事件通过 channel -> 事件循环
    let (task_tx, task_rx) = std::sync::mpsc::channel::<String>();
    let proxy_task = proxy.clone();
    thread::spawn(move || {
        for msg in task_rx {
            let _ = proxy_task.send_event(UserEvent::TaskEvent(msg));
        }
    });
    let emitter: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |json: String| {
        let _ = task_tx.send(json);
    });
    let tasks = Arc::new(tasks::TaskManager::new(emitter));

    // 从配置恢复任务（idle）
    for (pi, page) in loaded.pages.iter().enumerate() {
        for spec in &page.tasks {
            tasks.add(spec, pi);
        }
    }

    let app_state = Rc::new(RefCell::new(AppState {
        config: std::mem::take(&mut loaded),
        config_path,
        hwnd,
    }));

    // 热键：子类化 + 注册
    let (hk_tx, hk_rx) = std::sync::mpsc::channel::<i32>();
    let proxy_hk = proxy.clone();
    thread::spawn(move || {
        for id in hk_rx {
            let _ = proxy_hk.send_event(UserEvent::Hotkey(id));
        }
    });
    hotkeys::install(hwnd, hk_tx);
    {
        let st = app_state.borrow();
        let (ok1, ok2) = hotkeys::re_register(hwnd, &st.config.hotkeys.toggle, &st.config.hotkeys.panic);
        log_ipc(&format!("hotkeys registered toggle={ok1} panic={ok2}"));
    }

    if std::env::var("KC_SELFTEST").is_ok() {
        let spec = config::TaskSpec { kind: "click".into(), keys: "f24".into(), interval: 50, ..Default::default() };
        let tid = tasks.add(&spec, 0);
        tasks.start(&tid);
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let snap = tasks.snapshot_json();
        log_ipc(&format!("selftest: {snap}"));
        tasks.stop(&tid);
        tasks.remove(&tid);
    }

    let recording: Rc<RefCell<Option<RecordingState>>> = Rc::new(RefCell::new(None));
    let (rec_tx, rec_rx) = std::sync::mpsc::channel::<hook::RecordEvent>();
    let hook_ok = hook::install(rec_tx);
    log_ipc(&format!("keyboard hook: {hook_ok}"));
    let proxy_rec = proxy.clone();
    thread::spawn(move || {
        for ev in rec_rx {
            let _ = proxy_rec.send_event(UserEvent::Record(ev));
        }
    });
    let tray_ok = tray::add(hwnd);
    log_ipc(&format!("tray: {tray_ok}"));
    let holder: Rc<RefCell<Option<WebView>>> = Rc::new(RefCell::new(None));
    let holder_ipc = holder.clone();
    let state_ipc = app_state.clone();
    let tasks_ipc = tasks.clone();
    let recording_ipc = recording.clone();
    let proxy_ipc = proxy.clone();

    let webview = WebViewBuilder::new()
        .with_url(&url)
        .with_devtools(true)
        .with_browser_accelerator_keys(false)
        .with_default_context_menus(false)
        .with_initialization_script(SHIM)
        .with_ipc_handler(move |req| handle_ipc(req.body(), &proxy_ipc, &holder_ipc, &state_ipc, &tasks_ipc, &recording_ipc))
        .build(&window);
    let webview = match webview {
        Ok(w) => w,
        Err(e) => {
            log_ipc(&format!("webview init failed: {e}"));
            unsafe {
                let _ = windows::Win32::UI::WindowsAndMessaging::MessageBoxW(
                    None,
                    windows::core::w!("未检测到 WebView2 运行时。\n\n请先安装 Microsoft Edge WebView2 Runtime 后重试（Windows 11 自带，Windows 10 需要安装）。\n\n点击“确定”将打开下载页面。"),
                    windows::core::w!("KeyClicker"),
                    windows::Win32::UI::WindowsAndMessaging::MB_OK | windows::Win32::UI::WindowsAndMessaging::MB_ICONERROR,
                );
            }
            open_url("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            return Ok(());
        }
    };

    *holder.borrow_mut() = Some(webview);
    let holder_run = holder.clone();
    let state_run = app_state.clone();
    let recording_run = recording.clone();
    let tasks_run = tasks.clone();
    let mut tasks_for_drop = Some(tasks.clone());

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Drag) => {
                let _ = window.drag_window();
            }
            Event::UserEvent(UserEvent::Minimize) => window.set_minimized(true),
            Event::UserEvent(UserEvent::Maximize) => {
                window.set_maximized(!window.is_maximized());
            }
            Event::UserEvent(UserEvent::Tray) => {
                let choice = tray::show_menu(hwnd);
                let page = state_run.borrow().config.selected_page;
                match choice {
                    1 => { window.set_visible(true); window.set_focus(); }
                    2 => { tasks_run.start_page(page); tasks_run.emit_now(); }
                    3 => {
                        if tasks_run.any_running() {
                            tasks_run.stop_all();
                        } else {
                            tasks_run.start_all();
                        }
                        tasks_run.emit_now();
                    }
                    4 => *control_flow = ControlFlow::Exit,
                    _ => {}
                }
            }
            Event::UserEvent(UserEvent::Close) => {
                tray::remove(hwnd);
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::TaskEvent(raw)) => {
                dispatch_js(&holder_run, &raw);
            }
            Event::UserEvent(UserEvent::Record(ev)) => {
                let mut rec = recording_run.borrow_mut();
                if let Some(state) = rec.as_mut() {
                    if ev.is_escape {
                        if state.mode == "sequence" && !state.combos.is_empty() {
                            let combos = state.combos.clone();
                            respond(&holder_run, json!({ "event": "record.finished", "data": { "combos": combos } }));
                        }
                        *rec = None;
                        hook::set_recording(false);
                    } else if !ev.only_modifiers {
                        if state.mode == "sequence" {
                            state.combos.push(ev.combo.clone());
                            respond(&holder_run, json!({ "event": "record.captured", "data": { "combo": ev.combo } }));
                        } else {
                            respond(&holder_run, json!({ "event": "record.captured", "data": { "combo": ev.combo } }));
                            *rec = None;
                            hook::set_recording(false);
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::GrabTick(n)) => {
                respond(&holder_run, json!({ "event": "window.grabTick", "data": { "secondsLeft": n } }));
            }
            Event::UserEvent(UserEvent::GrabResult(v)) => {
                respond(&holder_run, json!({ "event": "window.grabResult", "data": v }));
            }
            Event::UserEvent(UserEvent::Hotkey(hk)) => {
                let page = state_run.borrow().config.selected_page;
                if hk == hotkeys::ID_TOGGLE {
                    let running = {
                        let snap = tasks_run.snapshot_json();
                        snap.pointer("/tasks")
                            .and_then(|t| t.as_array())
                            .map(|arr| {
                                arr.iter().any(|t| {
                                    t.get("state").and_then(|s| s.as_str()) == Some("running")
                                })
                            })
                            .unwrap_or(false)
                    };
                    if running {
                        tasks_run.stop_page(page);
                        toast(&holder_run, "info", "已停止当前配置的全部任务");
                    } else {
                        tasks_run.start_page(page);
                        toast(&holder_run, "info", "已开始当前配置的全部任务");
                    }
                    tasks_run.emit_now();
                } else if hk == hotkeys::ID_PANIC {
                    // F6：启停全部配置页的全部任务
                    if tasks_run.any_running() {
                        tasks_run.stop_all();
                        toast(&holder_run, "info", "已停止全部任务（F6）");
                    } else {
                        tasks_run.start_all();
                        toast(&holder_run, "info", "已开始全部任务（F6）");
                    }
                    tasks_run.emit_now();
                }
            }
            _ => {}
        }
        let _ = &tasks_for_drop;
        let _ = &mut tasks_for_drop;
    });

    #[allow(unreachable_code)]
    Ok(())
}