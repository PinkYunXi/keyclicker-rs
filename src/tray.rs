// 托盘图标与右键菜单
use std::mem::size_of;

use windows::core::w;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{CreateIconFromResourceEx, HICON, LR_DEFAULTCOLOR,
    AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, LoadIconW, SetForegroundWindow,
    TrackPopupMenu, IDI_APPLICATION, MF_SEPARATOR, MF_STRING, TPM_RETURNCMD, TPM_RIGHTBUTTON,
};

pub const WM_APP_TRAY: u32 = 0x8000 + 2;
const TRAY_ID: u32 = 1;

fn hwnd_from(h: isize) -> HWND {
    HWND(h as *mut core::ffi::c_void)
}

/// 从内嵌 ICO 里取 32x32 图像
fn load_app_icon() -> Option<HICON> {
    let bytes: &[u8] = include_bytes!("../assets/keyclicker.ico");
    if bytes.len() < 6 {
        return None;
    }
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    let mut best: Option<(usize, usize)> = None;
    for i in 0..count {
        let off = 6 + i * 16;
        if off + 16 > bytes.len() {
            break;
        }
        let w = bytes[off] as usize;
        let size = u32::from_le_bytes([bytes[off + 8], bytes[off + 9], bytes[off + 10], bytes[off + 11]]) as usize;
        let img = u32::from_le_bytes([bytes[off + 12], bytes[off + 13], bytes[off + 14], bytes[off + 15]]) as usize;
        if img + size <= bytes.len() && w >= 32 {
            best = Some((img, size));
            if w == 32 {
                break;
            }
        }
    }
    let (off, size) = best?;
    unsafe {
        CreateIconFromResourceEx(&bytes[off..off + size], true, 0x0003_0000, 32, 32, LR_DEFAULTCOLOR).ok()
    }
}
pub fn add(hwnd: isize) -> bool {
    let mut nid = NOTIFYICONDATAW::default();
    nid.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd_from(hwnd);
    nid.uID = TRAY_ID;
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    nid.uCallbackMessage = WM_APP_TRAY;
    if let Some(icon) = load_app_icon() {
        nid.hIcon = icon;
    } else if let Ok(icon) = unsafe { LoadIconW(None, IDI_APPLICATION) } {
        nid.hIcon = icon;
    }
    let tip: Vec<u16> = "KeyClicker 键盘连点器\0".encode_utf16().collect();
    let n = tip.len().min(nid.szTip.len());
    nid.szTip[..n].copy_from_slice(&tip[..n]);
    unsafe { Shell_NotifyIconW(NIM_ADD, &nid).as_bool() }
}

pub fn remove(hwnd: isize) {
    let mut nid = NOTIFYICONDATAW::default();
    nid.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd_from(hwnd);
    nid.uID = TRAY_ID;
    unsafe {
        let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
    }
}

/// 弹出托盘菜单，返回选中的命令 id（0 = 取消）
pub fn show_menu(hwnd: isize) -> u16 {
    unsafe {
        let Ok(menu) = CreatePopupMenu() else {
            return 0;
        };
        let _ = AppendMenuW(menu, MF_STRING, 1, w!("显示主窗口"));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
        let _ = AppendMenuW(menu, MF_STRING, 2, w!("启停当前配置"));
        let _ = AppendMenuW(menu, MF_STRING, 3, w!("启停全部配置（F6）"));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
        let _ = AppendMenuW(menu, MF_STRING, 4, w!("退出"));
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let _ = SetForegroundWindow(hwnd_from(hwnd));
        let cmd = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            pt.x,
            pt.y,
            Some(0),
            hwnd_from(hwnd),
            None,
        );
        let _ = DestroyMenu(menu);
        cmd.0 as u16
    }
}
