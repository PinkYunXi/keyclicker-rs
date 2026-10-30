fn main() {
    #[cfg(windows)]
    {
        // 把 ico 与版本信息写进 PE 资源节：资源管理器/任务栏才有图标
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/keyclicker.ico");
        res.set("ProductName", "KeyClicker");
        res.set("FileDescription", "KeyClicker - keyboard auto-clicker");
        res.set("LegalCopyright", "MIT License");
        res.set("OriginalFilename", "KeyClicker.exe");
        let _ = res.compile();
    }
}
