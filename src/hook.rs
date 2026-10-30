// 低级键盘钩子：按键录入（录制时吞键，避免输入泄漏到前台程序）
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::OnceLock;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

#[derive(Debug, Clone)]
pub struct RecordEvent {
    pub combo: String,
    pub is_escape: bool,
    pub only_modifiers: bool,
}

static RECORDING: AtomicBool = AtomicBool::new(false);
static ALLOW_INJECTED: AtomicBool = AtomicBool::new(false);
static TX: OnceLock<Sender<RecordEvent>> = OnceLock::new();
static HOOK: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

pub fn set_recording(on: bool) {
    RECORDING.store(on, Ordering::SeqCst);
}

fn mod_mask() -> u32 {
    unsafe {
        let mut mask = 0u32;
        if (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 {
            mask |= 1;
        }
        if (GetAsyncKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0 {
            mask |= 2;
        }
        if (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0 {
            mask |= 4;
        }
        if (GetAsyncKeyState(VK_LWIN.0 as i32) as u16 & 0x8000) != 0
            || (GetAsyncKeyState(VK_RWIN.0 as i32) as u16 & 0x8000) != 0
        {
            mask |= 8;
        }
        mask
    }
}

fn is_modifier_vk(vk: u16) -> bool {
    crate::keys::is_modifier_vk(vk)
}

unsafe extern "system" fn hook_proc(ncode: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if ncode == HC_ACTION as i32 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let injected = (kb.flags.0 & LLKHF_INJECTED.0) != 0;
        if !injected || ALLOW_INJECTED.load(Ordering::SeqCst) {
            let vk = kb.vkCode as u16;
            let is_down = wparam.0 == WM_KEYDOWN as usize || wparam.0 == WM_SYSKEYDOWN as usize;
            if RECORDING.load(Ordering::SeqCst) {
                if is_down {
                    let mask = mod_mask();
                    let mut names: Vec<String> = Vec::new();
                    if mask & 1 != 0 {
                        names.push("ctrl".into());
                    }
                    if mask & 2 != 0 {
                        names.push("shift".into());
                    }
                    if mask & 4 != 0 {
                        names.push("alt".into());
                    }
                    if mask & 8 != 0 {
                        names.push("windows".into());
                    }
                    let only_mods = is_modifier_vk(vk);
                    if !only_mods {
                        let name = crate::keys::name_for_vk(vk);
                        if !name.is_empty() {
                            names.push(name);
                        }
                    }
                    let combo = crate::keys::format_keys(&names);
                    crate::log_ipc(&format!("hook key: vk=0x{vk:02X} combo=[{combo}]", vk = vk, combo = combo));
                    if !combo.is_empty() {
                        if let Some(tx) = TX.get() {
                            let _ = tx.send(RecordEvent {
                                combo,
                                is_escape: vk == 0x1B,
                                only_modifiers: only_mods,
                            });
                        }
                    }
                }
                return LRESULT(1); // 录制时吞掉所有按键
            }
        }
    }
    CallNextHookEx(None, ncode, wparam, lparam)
}

/// 在当前线程（UI 线程）安装低级键盘钩子：钩子回调依赖该线程的消息泵。
pub fn install(tx: Sender<RecordEvent>) -> bool {
    let _ = TX.set(tx);
    let allow = std::env::var_os("KC_RECORD_INJECTED").is_some();
    ALLOW_INJECTED.store(allow, Ordering::SeqCst);
    crate::log_ipc(&format!("hook install: allow_injected={allow}"));
    unsafe {
        let hinst = GetModuleHandleW(None).ok().map(|m| windows::Win32::Foundation::HINSTANCE(m.0));
        match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), hinst, 0) {
            Ok(h) => {
                HOOK.store(h.0 as isize, Ordering::SeqCst);
                true
            }
            Err(_) => false,
        }
    }
}

