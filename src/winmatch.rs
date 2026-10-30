// 前台窗口、可见窗口枚举与窗口匹配
use windows::core::PWSTR;
use regex::RegexBuilder;
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, MAX_PATH, RECT};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

pub fn foreground_title() -> String {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n <= 0 {
            return String::new();
        }
        wide_to_string(&buf)
    }
}

pub fn foreground_process() -> String {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return String::new();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return String::new();
        }
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; MAX_PATH as usize];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(handle);
        if ok.is_err() || size == 0 {
            return String::new();
        }
        let path = wide_to_string(&buf);
        path.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    }
}

fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

fn window_offscreen(hwnd: HWND) -> bool {
    unsafe {
        let mut rc = RECT::default();
        if GetWindowRect(hwnd, &mut rc).is_err() {
            return false;
        }
        if rc.right <= rc.left || rc.bottom <= rc.top {
            return false;
        }
        let (vx, vy, vw, vh) = virtual_screen();
        rc.right <= vx || rc.left >= vx + vw || rc.bottom <= vy || rc.top >= vy + vh
    }
}

struct EnumCtx {
    self_pid: u32,
    titles: Vec<String>,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumCtx);
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == ctx.self_pid {
        return BOOL(1);
    }
    let mut buf = [0u16; 512];
    let n = GetWindowTextW(hwnd, &mut buf);
    if n <= 0 {
        return BOOL(1);
    }
    if window_offscreen(hwnd) {
        return BOOL(1);
    }
    let title = wide_to_string(&buf);
    if !title.trim().is_empty() {
        ctx.titles.push(title);
    }
    BOOL(1)
}

/// 可见且非屏外的窗口标题（去重，最多 limit 条）
pub fn list_visible_titles(limit: usize) -> Vec<String> {
    let mut ctx = EnumCtx {
        self_pid: unsafe { windows::Win32::System::Threading::GetCurrentProcessId() },
        titles: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut EnumCtx as isize));
    }
    ctx.titles.sort();
    ctx.titles.dedup();
    ctx.titles.truncate(limit.max(1));
    ctx.titles
}

/// 自己是否前台
pub fn foreground_is_self() -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid == windows::Win32::System::Threading::GetCurrentProcessId()
    }
}

pub fn match_window(pattern: &str, title: &str, mode: &str) -> bool {
    let p = pattern.trim();
    if p.is_empty() {
        return true;
    }
    if mode == "regex" {
        return validate_regex(p)
            && RegexBuilder::new(p)
                .case_insensitive(true)
                .build()
                .map(|re| re.is_match(title))
                .unwrap_or(false);
    }
    let t = title.to_lowercase();
    let pl = p.to_lowercase();
    match mode {
        "exact" => t == pl,
        _ => t.contains(&pl),
    }
}

/// 正则是否合法（用于保存任务前的校验）
pub fn validate_regex(pattern: &str) -> bool {
    RegexBuilder::new(pattern).case_insensitive(true).build().is_ok()
}

pub fn window_allows(pattern: &str, mode: &str) -> bool {
    if pattern.trim().is_empty() {
        return true;
    }
    match_window(pattern, &foreground_title(), mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_modes() {
        assert!(match_window("", "anything", "contains"));
        assert!(match_window("记事本", "无标题 - 记事本", "contains"));
        assert!(!match_window("记事本", "无标题 - 记事本", "exact"));
        assert!(match_window("无标题 - 记事本", "无标题 - 记事本", "exact"));
        // 正则：大小写不敏感、部分匹配
        assert!(match_window("^无标题.*记事本$", "无标题 - 记事本", "regex"));
        assert!(match_window("notepad|记事本", "无标题 - 记事本", "regex"));
        assert!(!match_window("^记事本$", "无标题 - 记事本", "regex"));
        // 非法正则不能命中，也不能 panic
        assert!(!match_window("([", "任意标题", "regex"));
        assert!(!validate_regex("(["));
        assert!(validate_regex("^abc.*"));
    }
}
