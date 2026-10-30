// 全局热键：RegisterHotKey + 子类化窗口过程拦截 WM_HOTKEY
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::OnceLock;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use core::ffi::c_void;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT,
    MOD_WIN,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC, MINMAXINFO, SC_MAXIMIZE,
    WM_GETMINMAXINFO, WM_HOTKEY, WM_LBUTTONDBLCLK, WM_LBUTTONUP, WM_RBUTTONUP, WM_SYSCOMMAND, WNDPROC,
};

/// 窗口最大尺寸（逻辑像素）：超过后可能出现排布异常，直接锁死上限
pub const MAX_LOGICAL_W: f32 = 1120.0;
pub const MAX_LOGICAL_H: f32 = 800.0;

pub const ID_TOGGLE: i32 = 101;
pub const ID_PANIC: i32 = 102;

static ORIG: AtomicIsize = AtomicIsize::new(0);

fn hwnd_from(h: isize) -> HWND {
    HWND(h as *mut c_void)
}
static TX: OnceLock<std::sync::mpsc::Sender<i32>> = OnceLock::new();

unsafe extern "system" fn hotkey_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == crate::tray::WM_APP_TRAY {
        if let Some(tx) = TX.get() {
            // 只响应最终动作，避免 DOWN/UP 各弹一次菜单
            match lp.0 as u32 {
                WM_LBUTTONUP | WM_LBUTTONDBLCLK => {
                    let _ = tx.send(-3);
                }
                WM_RBUTTONUP => {
                    let _ = tx.send(-2);
                }
                _ => {}
            }
        }
    }
    if msg == WM_HOTKEY {
        if let Some(tx) = TX.get() {
            let _ = tx.send(wp.0 as i32);
        }
    }
    // 禁用最大化：系统菜单 / 双击标题栏 / Win+↑ 都会被这里挡掉
    if msg == WM_SYSCOMMAND && (wp.0 as u32 & 0xFFF0) == SC_MAXIMIZE {
        return LRESULT(0);
    }
    let orig = ORIG.load(Ordering::Acquire);
    let result = if orig == 0 {
        DefWindowProcW(hwnd, msg, wp, lp)
    } else {
        let f: WNDPROC = std::mem::transmute(orig);
        CallWindowProcW(f, hwnd, msg, wp, lp)
    };
    // 限制最大尺寸（拖拽与最大化都受此约束）
    if msg == WM_GETMINMAXINFO {
        let mmi = lp.0 as *mut MINMAXINFO;
        if !mmi.is_null() {
            let dpi = GetDpiForWindow(hwnd);
            let scale = if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 };
            let w = (MAX_LOGICAL_W * scale) as i32;
            let h = (MAX_LOGICAL_H * scale) as i32;
            (*mmi).ptMaxTrackSize = POINT { x: w, y: h };
            (*mmi).ptMaxSize = POINT { x: w, y: h };
        }
    }
    result
}

/// 子类化窗口并安装热键消息通道（必须在 UI 线程调用）
pub fn install(hwnd: isize, tx: std::sync::mpsc::Sender<i32>) {
    let _ = TX.set(tx);
    unsafe {
        let old = SetWindowLongPtrW(hwnd_from(hwnd), GWLP_WNDPROC, hotkey_proc as usize as isize);
        ORIG.store(old, Ordering::Release);
    }
}

pub fn parse_combo(combo: &str) -> Option<(HOT_KEY_MODIFIERS, u32)> {
    let keys = crate::keys::parse_keys(combo);
    let mut mods = HOT_KEY_MODIFIERS(0);
    let mut vk = 0u16;
    for k in &keys {
        match k.as_str() {
            "ctrl" => mods |= MOD_CONTROL,
            "shift" => mods |= MOD_SHIFT,
            "alt" => mods |= MOD_ALT,
            "windows" => mods |= MOD_WIN,
            _ => vk = crate::keys::vk_for_name(k),
        }
    }
    if vk == 0 {
        None
    } else {
        Some((mods | MOD_NOREPEAT, vk as u32))
    }
}

pub fn register(hwnd: isize, id: i32, combo: &str) -> bool {
    let Some((mods, vk)) = parse_combo(combo) else {
        return false;
    };
    unsafe { RegisterHotKey(Some(hwnd_from(hwnd)), id, mods, vk).is_ok() }
}

pub fn unregister(hwnd: isize, id: i32) {
    unsafe {
        let _ = UnregisterHotKey(Some(hwnd_from(hwnd)), id);
    }
}

/// 重新注册两个热键，返回 (toggle_ok, panic_ok)
pub fn re_register(hwnd: isize, toggle: &str, panic: &str) -> (bool, bool) {
    unregister(hwnd, ID_TOGGLE);
    unregister(hwnd, ID_PANIC);
    (register(hwnd, ID_TOGGLE, toggle), register(hwnd, ID_PANIC, panic))
}
