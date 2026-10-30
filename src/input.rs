// SendInput 发送引擎（扫描码模式，与旧版 keyboard 库一致）
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
};

fn is_extended(vk: u16) -> bool {
    matches!(
        vk,
        0x2D | 0x2E | 0x24 | 0x23 | 0x21 | 0x22 | 0x25 | 0x26 | 0x27 | 0x28 | 0x90 | 0x6F |
            0xA3 | 0xA5 | 0x5B | 0x5C | 0x5D | 0x2C | 0xAD | 0xAE | 0xAF | 0xB0 | 0xB1 | 0xB3
    )
}

fn make_input(vk: u16, down: bool) -> Option<INPUT> {
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    if scan == 0 {
        return None;
    }
    let mut flags = KEYEVENTF_SCANCODE;
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    Some(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}

/// 依次按下、等待、逆序释放；事件数不足视为失败。
pub fn send_combo(vks: &[u16], hold_ms: i32) -> bool {
    let valid: Vec<u16> = vks.iter().copied().filter(|v| *v != 0).collect();
    if valid.is_empty() {
        return false;
    }
    let downs: Vec<INPUT> = valid.iter().filter_map(|v| make_input(*v, true)).collect();
    if downs.len() != valid.len() {
        return false;
    }
    let sent = unsafe { SendInput(&downs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != valid.len() {
        return false;
    }
    std::thread::sleep(std::time::Duration::from_millis(hold_ms.max(1) as u64));
    let ups: Vec<INPUT> = valid.iter().rev().filter_map(|v| make_input(*v, false)).collect();
    let sent_up = unsafe { SendInput(&ups, std::mem::size_of::<INPUT>() as i32) };
    sent_up as usize == valid.len()
}

pub fn send_combo_str(combo: &str, hold_ms: i32) -> bool {
    let keys = crate::keys::parse_keys(combo);
    let vks = crate::keys::to_vk_sequence(&keys);
    send_combo(&vks, hold_ms)
}
