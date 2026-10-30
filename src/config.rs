// 配置结构、路径解析、旧版兼容（对应 C++ 版 config.cpp）
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

fn d_interval() -> i32 { 100 }
fn d_seconds() -> i32 { 10 }
fn d_gap() -> i32 { 200 }
fn d_mode() -> String { "contains".into() }
fn d_page() -> String { "配置".into() }
fn d_theme() -> String { "dark".into() }
fn d_toggle() -> String { "alt+\u{60}".into() }
fn d_panic() -> String { "f6".into() }
fn d_click() -> String { "click".into() }
fn d_keys() -> String { "a".into() }
fn d_version() -> i32 { 3 }
fn d_close_action() -> String { "ask".into() }
fn d_true() -> bool { true }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct WindowFilter {
    #[serde(default)]
    pub pattern: String,
    #[serde(default = "d_mode")]
    pub mode: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TaskSpec {
    #[serde(rename = "type", default = "d_click")]
    pub kind: String,
    #[serde(default = "d_keys")]
    pub keys: String,
    #[serde(default = "d_interval")]
    pub interval: i32,
    #[serde(default)]
    pub seq: Vec<String>,
    #[serde(default)]
    pub minutes: i32,
    #[serde(default = "d_seconds")]
    pub seconds: i32,
    #[serde(default = "d_gap")]
    pub gap: i32,
    #[serde(default, alias = "window_match", alias = "windowMatch")]
    pub window_match: String,
    #[serde(default, alias = "window_mode", alias = "windowMode")]
    pub window_mode: String,
}

impl Default for TaskSpec {
    fn default() -> Self {
        Self {
            kind: d_click(), keys: d_keys(), interval: d_interval(),
            seq: vec!["a".into()], minutes: 0, seconds: d_seconds(), gap: d_gap(),
            window_match: String::new(), window_mode: d_mode(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Page {
    #[serde(default = "d_page")]
    pub name: String,
    #[serde(default)]
    pub tasks: Vec<TaskSpec>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Hotkeys {
    #[serde(default = "d_toggle")]
    pub toggle: String,
    #[serde(default = "d_panic")]
    pub panic: String,
}

impl Default for Hotkeys {
    fn default() -> Self { Self { toggle: d_toggle(), panic: d_panic() } }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct WindowState {
    #[serde(default, alias = "always_on_top")]
    pub always_on_top: bool,
}

/// 关闭窗口的行为：ask（首次询问）/ tray（最小化到托盘）/ exit（直接退出）
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClosePrefs {
    #[serde(default = "d_close_action")]
    pub action: String,
}

impl Default for ClosePrefs {
    fn default() -> Self {
        Self { action: d_close_action() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    #[serde(default = "d_version")]
    pub version: i32,
    #[serde(default = "d_theme")]
    pub theme: String,
    #[serde(default, alias = "selected_page")]
    pub selected_page: usize,
    #[serde(default)]
    pub hotkeys: Hotkeys,
    #[serde(default, rename = "window")]
    pub window: WindowState,
    #[serde(default)]
    pub close: ClosePrefs,
    /// 删除配置页前是否弹确认框（可在设置里关闭）
    #[serde(default = "d_true")]
    pub confirm_delete_page: bool,
    #[serde(default)]
    pub pages: Vec<Page>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 3, theme: d_theme(), selected_page: 0,
            hotkeys: Hotkeys::default(), window: WindowState::default(),
            close: ClosePrefs::default(),
            confirm_delete_page: true,
            pages: vec![Page::default()],
        }
    }
}

impl Config {
    /// 兼容：顶层对象（v2+）或顶层数组（v1.1.0 页面数组）
    pub fn from_json(text: &str) -> Result<Self, String> {
        if let Ok(cfg) = serde_json::from_str::<Config>(text) {
            return Ok(cfg.normalized());
        }
        if let Ok(pages) = serde_json::from_str::<Vec<Page>>(text) {
            let mut cfg = Config::default();
            cfg.pages = pages;
            return Ok(cfg.normalized());
        }
        Err("配置文件格式无法识别".into())
    }

    pub fn normalized(mut self) -> Self {
        if self.theme != "dark" && self.theme != "light" {
            self.theme = d_theme();
        }
        if self.hotkeys.toggle.is_empty() || self.hotkeys.toggle == "ctrl+\u{60}" {
            self.hotkeys.toggle = d_toggle();
        }
        if self.hotkeys.panic.is_empty() {
            self.hotkeys.panic = d_panic();
        }
        if self.pages.is_empty() {
            self.pages.push(Page::default());
        }
        for page in &mut self.pages {
            if page.name.is_empty() {
                page.name = d_page();
            }
            for t in &mut page.tasks {
                t.interval = t.interval.clamp(16, 3_600_000);
                t.gap = t.gap.clamp(16, 3_600_000);
                t.minutes = t.minutes.clamp(0, 1440);
                if t.minutes == 0 && t.seconds < 1 {
                    t.seconds = 1;
                }
                if t.kind == "timer" && t.seq.is_empty() {
                    t.seq.push("a".into());
                }
                if t.keys.is_empty() {
                    t.keys = "a".into();
                }
                match t.window_mode.as_str() {
                    "contains" | "exact" | "regex" => {}
                    _ => t.window_mode = d_mode(),
                }
            }
        }
        if self.selected_page >= self.pages.len() {
            self.selected_page = 0;
        }
        self
    }
}

pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn apdata_config() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    Path::new(&base).join("KeyClicker").join("config.json")
}

fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(".kc_write_probe");
    if std::fs::write(&probe, b"").is_ok() {
        let _ = std::fs::remove_file(&probe);
        true
    } else {
        false
    }
}

/// 优先级：KEYCLICKER_CONFIG > exe 目录已有配置 > exe 目录可写 > %APPDATA%
pub fn resolve_config_path() -> PathBuf {
    if let Ok(env) = std::env::var("KEYCLICKER_CONFIG") {
        if !env.trim().is_empty() {
            return PathBuf::from(env);
        }
    }
    let base = exe_dir();
    let portable = base.join("clicker_config.json");
    if portable.exists() {
        return portable;
    }
    if dir_writable(&base) {
        return portable;
    }
    apdata_config()
}

pub fn load_config(path: &Path) -> Config {
    match std::fs::read_to_string(path) {
        Ok(text) => Config::from_json(&text).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}

pub fn save_config_atomic(path: &Path, cfg: &Config) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_v2_object() {
        let text = r#"{"version":2,"theme":"light","pages":[{"name":"A","tasks":[{"type":"click","keys":"ctrl+f9","interval":50,"window_match":"x","window_mode":"contains"},{"type":"timer","seq":["f5","1"],"minutes":0,"seconds":10,"gap":200}]}]}"#;
        let cfg = Config::from_json(text).unwrap();
        assert_eq!(cfg.pages.len(), 1);
        assert_eq!(cfg.pages[0].tasks.len(), 2);
        assert_eq!(cfg.pages[0].tasks[0].keys, "ctrl+f9");
        assert_eq!(cfg.pages[0].tasks[0].window_match, "x");
        assert_eq!(cfg.pages[0].tasks[1].seq.len(), 2);
        assert_eq!(cfg.theme, "light");
    }

    #[test]
    fn legacy_v1_array() {
        let text = r#"[{"name":"P1","tasks":[{"type":"click","keys":"a","interval":100}]}]"#;
        let cfg = Config::from_json(text).unwrap();
        assert_eq!(cfg.pages.len(), 1);
        assert_eq!(cfg.pages[0].name, "P1");
    }

    #[test]
    fn normalize_clamps() {
        let text = r#"{"pages":[{"name":"","tasks":[{"type":"click","keys":"a","interval":5}]}]}"#;
        let cfg = Config::from_json(text).unwrap();
        assert_eq!(cfg.pages[0].tasks[0].interval, 16);
        assert_eq!(cfg.pages[0].name, "配置");
    }

    #[test]
    fn roundtrip() {
        let cfg = Config::default();
        let text = serde_json::to_string(&cfg).unwrap();
        let back = Config::from_json(&text).unwrap();
        assert_eq!(back.pages.len(), 1);
        assert_eq!(back.hotkeys.panic, "f6");
    }
}
