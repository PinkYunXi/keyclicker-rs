// 键名 <-> Win32 虚拟键码：解析、格式化、校验

pub const VK_NONE: u16 = 0;
const BK: char = '\u{60}'; // 反引号

struct KeyDef {
    name: &'static str,
    vk: u16,
}

macro_rules! k {
    ($n:literal, $v:literal) => {
        KeyDef { name: $n, vk: $v }
    };
}

/// 键名表（name 一律小写；组合键用 + 连接）
static KEYS: &[KeyDef] = &[
    k!("a", 0x41), k!("b", 0x42), k!("c", 0x43), k!("d", 0x44), k!("e", 0x45),
    k!("f", 0x46), k!("g", 0x47), k!("h", 0x48), k!("i", 0x49), k!("j", 0x4A),
    k!("k", 0x4B), k!("l", 0x4C), k!("m", 0x4D), k!("n", 0x4E), k!("o", 0x4F),
    k!("p", 0x50), k!("q", 0x51), k!("r", 0x52), k!("s", 0x53), k!("t", 0x54),
    k!("u", 0x55), k!("v", 0x56), k!("w", 0x57), k!("x", 0x58), k!("y", 0x59), k!("z", 0x5A),
    k!("0", 0x30), k!("1", 0x31), k!("2", 0x32), k!("3", 0x33), k!("4", 0x34),
    k!("5", 0x35), k!("6", 0x36), k!("7", 0x37), k!("8", 0x38), k!("9", 0x39),
    k!("f1", 0x70), k!("f2", 0x71), k!("f3", 0x72), k!("f4", 0x73), k!("f5", 0x74),
    k!("f6", 0x75), k!("f7", 0x76), k!("f8", 0x77), k!("f9", 0x78), k!("f10", 0x79),
    k!("f11", 0x7A), k!("f12", 0x7B), k!("f13", 0x7C), k!("f14", 0x7D), k!("f15", 0x7E),
    k!("f16", 0x7F), k!("f17", 0x80), k!("f18", 0x81), k!("f19", 0x82), k!("f20", 0x83),
    k!("f21", 0x84), k!("f22", 0x85), k!("f23", 0x86), k!("f24", 0x87),
    k!("enter", 0x0D), k!("tab", 0x09), k!("space", 0x20), k!("backspace", 0x08),
    k!("escape", 0x1B), k!("delete", 0x2E), k!("insert", 0x2D), k!("home", 0x24),
    k!("end", 0x23), k!("page up", 0x21), k!("page down", 0x22),
    k!("up", 0x26), k!("down", 0x28), k!("left", 0x25), k!("right", 0x27),
    k!("caps lock", 0x14), k!("num lock", 0x90), k!("scroll lock", 0x91),
    k!("print screen", 0x2C), k!("pause", 0x13),
    k!("ctrl", 0x11), k!("shift", 0x10), k!("alt", 0x12), k!("windows", 0x5B), k!("menu", 0x5D),
    k!("num0", 0x60), k!("num1", 0x61), k!("num2", 0x62), k!("num3", 0x63), k!("num4", 0x64),
    k!("num5", 0x65), k!("num6", 0x66), k!("num7", 0x67), k!("num8", 0x68), k!("num9", 0x69),
    k!("num multiply", 0x6A), k!("num add", 0x6B), k!("num subtract", 0x6D),
    k!("num decimal", 0x6E), k!("num divide", 0x6F),
    k!("volume mute", 0xAD), k!("volume down", 0xAE), k!("volume up", 0xAF),
    k!("media next", 0xB0), k!("media prev", 0xB1), k!("media play", 0xB3),
    k!(";", 0xBA), k!("=", 0xBB), k!(",", 0xBC), k!("-", 0xBD), k!(".", 0xBE), k!("/", 0xBF),
    k!("\u{60}", 0xC0), k!("[", 0xDB), k!("\\", 0xDC), k!("]", 0xDD), k!("'", 0xDE),
];

fn alias(name: &str) -> &str {
    match name {
        "win" | "super" | "cmd" | "meta" => "windows",
        "control" => "ctrl",
        "esc" => "escape",
        "return" => "enter",
        "pgup" | "pageup" => "page up",
        "pgdn" | "pagedown" => "page down",
        "ins" => "insert",
        "del" => "delete",
        "prtscn" | "printscreen" | "prt sc" => "print screen",
        "backtick" | "grave" => "\u{60}",
        "spacebar" => "space",
        "menu" | "apps" => "menu",
        other => other,
    }
}

/// 归一化单个键名（小写、去空白、别名转换）
pub fn normalize_key(raw: &str) -> String {
    let lowered = raw.trim().to_lowercase();
    if lowered.is_empty() {
        return String::new();
    }
    alias(&lowered).to_string()
}

pub fn vk_for_name(name: &str) -> u16 {
    let n = normalize_key(name);
    if n.is_empty() {
        return VK_NONE;
    }
    if n == BK.to_string() {
        return 0xC0;
    }
    KEYS.iter().find(|k| k.name == n).map(|k| k.vk).unwrap_or(VK_NONE)
}

pub fn name_for_vk(vk: u16) -> String {
    if vk == 0xC0 {
        return BK.to_string();
    }
    KEYS.iter().find(|k| k.vk == vk).map(|k| k.name.to_string()).unwrap_or_default()
}

pub fn is_modifier_vk(vk: u16) -> bool {
    matches!(vk, 0x10 | 0x11 | 0x12 | 0x5B | 0x5C)
}

fn is_modifier_name(name: &str) -> bool {
    matches!(name, "ctrl" | "shift" | "alt" | "windows")
}

fn modifier_order(name: &str) -> usize {
    match name {
        "ctrl" => 0,
        "shift" => 1,
        "alt" => 2,
        "windows" => 3,
        _ => 9,
    }
}

/// "ctrl+shift+a" -> ["ctrl","shift","a"]（归一化、去重保序、修饰键在前）
pub fn parse_keys(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw.split('+') {
        let name = normalize_key(part);
        if name.is_empty() {
            continue;
        }
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out.sort_by_key(|n| modifier_order(n));
    out.truncate(4);
    out
}

pub fn format_keys(keys: &[String]) -> String {
    let mut sorted: Vec<&String> = keys.iter().collect();
    sorted.sort_by_key(|n| modifier_order(n));
    sorted.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("+")
}

#[derive(Debug, Clone)]
pub struct KeyValidation {
    pub valid: bool,
    pub keys: Vec<String>,
    pub normalized: String,
    pub error: String,
}

pub fn validate_keys(raw: &str) -> KeyValidation {
    let keys = parse_keys(raw);
    if keys.is_empty() {
        return KeyValidation { valid: false, keys, normalized: String::new(), error: "按键不能为空".into() };
    }
    let mut bad: Option<String> = None;
    for name in &keys {
        if vk_for_name(name) == VK_NONE {
            bad = Some(name.clone());
            break;
        }
    }
    if let Some(name) = bad {
        let error = format!("无法识别的键名：{name}");
        return KeyValidation { valid: false, keys, normalized: String::new(), error };
    }
    if keys.iter().all(|n| is_modifier_name(n)) {
        return KeyValidation { valid: false, keys, normalized: String::new(), error: "至少要有一个非修饰键".into() };
    }
    let normalized = format_keys(&keys);
    KeyValidation { valid: true, keys, normalized, error: String::new() }
}

/// 组合键 -> VK 序列（修饰键已在前面）
pub fn to_vk_sequence(keys: &[String]) -> Vec<u16> {
    keys.iter().map(|n| vk_for_name(n)).filter(|v| *v != VK_NONE).collect()
}

/// 按住时长：间隔 >= 40ms 用 20ms；更短时取 max(2, interval/2)
pub fn hold_ms_for_interval(interval_ms: i32) -> i32 {
    if interval_ms >= 40 {
        20
    } else {
        std::cmp::max(2, interval_ms / 2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases() {
        assert_eq!(normalize_key("WIN"), "windows");
        assert_eq!(normalize_key("control"), "ctrl");
        assert_eq!(normalize_key("Esc"), "escape");
        assert_eq!(normalize_key("pgup"), "page up");
    }

    #[test]
    fn parse_and_format() {
        let keys = parse_keys("Ctrl+F9");
        assert_eq!(keys, vec!["ctrl".to_string(), "f9".to_string()]);
        assert_eq!(format_keys(&keys), "ctrl+f9");
        let b = parse_keys("alt+\u{60}");
        assert_eq!(b, vec!["alt".to_string(), "\u{60}".to_string()]);
    }

    #[test]
    fn validate_errors() {
        assert!(!validate_keys("").valid);
        assert!(validate_keys("").error.contains("不能为空"));
        assert!(validate_keys("zzz").error.contains("无法识别"));
        assert!(validate_keys("ctrl+shift").error.contains("非修饰键"));
    }

    #[test]
    fn vk_mapping() {
        assert_eq!(vk_for_name("a"), 0x41);
        assert_eq!(vk_for_name("f6"), 0x75);
        assert_eq!(vk_for_name("\u{60}"), 0xC0);
        assert_eq!(name_for_vk(0x75), "f6");
    }

    #[test]
    fn hold_ms() {
        assert_eq!(hold_ms_for_interval(100), 20);
        assert_eq!(hold_ms_for_interval(16), 8);
        assert_eq!(hold_ms_for_interval(4), 2);
    }
}
