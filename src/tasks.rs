// 任务调度引擎：单线程 + 条件变量，连点按固定节拍，定时序列按秒推进
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::config::TaskSpec;
use crate::input;
use crate::keys;
use crate::winmatch;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TaskState {
    Idle,
    Running,
    Paused,
}

impl TaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskState::Idle => "idle",
            TaskState::Running => "running",
            TaskState::Paused => "paused",
        }
    }
}

struct Entry {
    id: String,
    page: usize,
    spec: TaskSpec,
    state: TaskState,
    count: u64,
    remaining: i32,
    window_blocked: bool,
    next_due: Instant,
    total_secs: i32,
    fired: bool,
}

struct Inner {
    entries: Vec<Entry>,
    next_id: u64,
    shutdown: bool,
    last_stats: Instant,
}

impl Inner {
    fn next_due(&self) -> Option<Instant> {
        self.entries
            .iter()
            .filter(|e| e.state == TaskState::Running)
            .map(|e| e.next_due)
            .min()
    }
}

pub struct TaskManager {
    inner: Arc<Mutex<Inner>>,
    wake: Arc<(Mutex<u64>, Condvar)>,
    emitter: Arc<dyn Fn(String) + Send + Sync>,
    worker: Option<JoinHandle<()>>,
}

impl TaskManager {
    pub fn new(emitter: Arc<dyn Fn(String) + Send + Sync>) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            entries: Vec::new(),
            next_id: 0,
            shutdown: false,
            last_stats: Instant::now(),
        }));
        let wake = Arc::new((Mutex::new(0u64), Condvar::new()));
        let worker = {
            let inner = inner.clone();
            let wake = wake.clone();
            let emitter = emitter.clone();
            std::thread::spawn(move || worker_loop(inner, wake, emitter))
        };
        Self {
            inner,
            wake,
            emitter,
            worker: Some(worker),
        }
    }

    fn signal(&self) {
        let (m, cv) = &*self.wake;
        let mut g = m.lock().unwrap();
        *g += 1;
        cv.notify_all();
    }

    pub fn add(&self, spec: &TaskSpec, page: usize) -> String {
        let mut g = self.inner.lock().unwrap();
        g.next_id += 1;
        let id = format!("t_{}", g.next_id);
        let total_secs = (spec.minutes * 60 + spec.seconds).max(1);
        let interval = spec.interval.clamp(16, 3_600_000) as u64;
        g.entries.push(Entry {
            id: id.clone(),
            page,
            spec: spec.clone(),
            state: TaskState::Idle,
            count: 0,
            remaining: if spec.kind == "timer" { total_secs } else { 0 },
            window_blocked: false,
            next_due: Instant::now() + Duration::from_millis(interval),
            total_secs,
            fired: false,
        });
        drop(g);
        self.signal();
        id
    }

    pub fn remove(&self, id: &str) -> bool {
        let mut g = self.inner.lock().unwrap();
        let before = g.entries.len();
        g.entries.retain(|e| e.id != id);
        let removed = g.entries.len() != before;
        drop(g);
        self.signal();
        removed
    }

    fn set_state(&self, id: &str, state: TaskState, reset_count: bool) -> bool {
        let mut g = self.inner.lock().unwrap();
        let interval = {
            let Some(e) = g.entries.iter_mut().find(|e| e.id == id) else {
                return false;
            };
            e.state = state;
            if reset_count {
                e.count = 0;
                e.remaining = if e.spec.kind == "timer" { e.total_secs } else { 0 };
            }
            if state == TaskState::Running {
                let ms = if e.spec.kind == "timer" {
                    1000
                } else {
                    e.spec.interval.clamp(16, 3_600_000) as u64
                };
                e.next_due = Instant::now() + Duration::from_millis(ms);
            }
            e.spec.interval
        };
        let _ = interval;
        drop(g);
        self.signal();
        true
    }

    pub fn start(&self, id: &str) -> bool {
        self.set_state(id, TaskState::Running, true)
    }
    pub fn pause(&self, id: &str) -> bool {
        self.set_state(id, TaskState::Paused, false)
    }
    pub fn resume(&self, id: &str) -> bool {
        self.set_state(id, TaskState::Running, false)
    }
    pub fn stop(&self, id: &str) -> bool {
        self.set_state(id, TaskState::Idle, true)
    }

    pub fn start_page(&self, page: usize) {
        let ids: Vec<String> = {
            let g = self.inner.lock().unwrap();
            g.entries
                .iter()
                .filter(|e| e.page == page && e.state == TaskState::Idle)
                .map(|e| e.id.clone())
                .collect()
        };
        for id in ids {
            self.start(&id);
        }
    }

    pub fn stop_page(&self, page: usize) {
        let ids: Vec<String> = {
            let g = self.inner.lock().unwrap();
            g.entries
                .iter()
                .filter(|e| e.page == page && e.state != TaskState::Idle)
                .map(|e| e.id.clone())
                .collect()
        };
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = {
            let g = self.inner.lock().unwrap();
            g.entries.iter().map(|e| e.id.clone()).collect()
        };
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn pause_all_running(&self) -> bool {
        let ids: Vec<String> = {
            let g = self.inner.lock().unwrap();
            g.entries
                .iter()
                .filter(|e| e.state == TaskState::Running)
                .map(|e| e.id.clone())
                .collect()
        };
        let any = !ids.is_empty();
        for id in ids {
            self.pause(&id);
        }
        any
    }

    pub fn resume_all_paused(&self) {
        let ids: Vec<String> = {
            let g = self.inner.lock().unwrap();
            g.entries
                .iter()
                .filter(|e| e.state == TaskState::Paused)
                .map(|e| e.id.clone())
                .collect()
        };
        for id in ids {
            self.resume(&id);
        }
    }

    pub fn snapshot_json(&self) -> serde_json::Value {
        let g = self.inner.lock().unwrap();
        let tasks: Vec<serde_json::Value> = g
            .entries
            .iter()
            .map(|e| {
                json!({
                    "id": e.id,
                    "pageIndex": e.page,
                    "type": e.spec.kind,
                    "state": e.state.as_str(),
                    "count": e.count,
                    "remaining": e.remaining,
                    "windowBlocked": e.window_blocked,
                })
            })
            .collect();
        json!({ "tasks": tasks })
    }

    pub fn emit_now(&self) {
        let snap = self.snapshot_json();
        (self.emitter)(json!({ "event": "task.stats", "data": snap }).to_string());
    }

    pub fn shutdown(&mut self) {
        {
            let mut g = self.inner.lock().unwrap();
            g.shutdown = true;
        }
        self.signal();
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

impl Drop for TaskManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn worker_loop(inner: Arc<Mutex<Inner>>, wake: Arc<(Mutex<u64>, Condvar)>, emitter: Arc<dyn Fn(String) + Send + Sync>) {
    loop {
        let (next_due, shutdown) = {
            let g = inner.lock().unwrap();
            (g.next_due(), g.shutdown)
        };
        if shutdown {
            break;
        }

        let now = Instant::now();
        match next_due {
            Some(t) if t <= now => {}
            Some(t) => {
                let dur = std::cmp::min(t - now, Duration::from_millis(50));
                let (m, cv) = &*wake;
                let guard = m.lock().unwrap();
                let _ = cv.wait_timeout(guard, dur);
                continue;
            }
            None => {
                let (m, cv) = &*wake;
                let guard = m.lock().unwrap();
                let _ = cv.wait_timeout(guard, Duration::from_millis(100));
                continue;
            }
        }

        // 取出所有到期任务
        let due: Vec<(String, TaskSpec, usize)> = {
            let mut g = inner.lock().unwrap();
            let now = Instant::now();
            let mut due = Vec::new();
            for e in g.entries.iter_mut() {
                if e.state != TaskState::Running || e.next_due > now {
                    continue;
                }
                due.push((e.id.clone(), e.spec.clone(), e.page));
                if e.spec.kind == "timer" {
                    e.next_due = now + Duration::from_millis(1000);
                } else {
                    let step = Duration::from_millis(e.spec.interval.clamp(16, 3_600_000) as u64);
                    e.next_due += step;
                    if e.next_due <= now {
                        e.next_due = now + step;
                    }
                }
            }
            due
        };

        for (id, spec, _page) in due {
            if spec.kind == "timer" {
                fire_timer(&inner, &emitter, &id, &spec);
            } else {
                fire_click(&inner, &emitter, &id, &spec);
            }
        }

        // 统计节流：100ms
        let mut g = inner.lock().unwrap();
        if g.last_stats.elapsed() >= Duration::from_millis(100) {
            g.last_stats = Instant::now();
            let snap = {
                let tasks: Vec<serde_json::Value> = g
                    .entries
                    .iter()
                    .map(|e| {
                        json!({
                            "id": e.id,
                            "pageIndex": e.page,
                            "type": e.spec.kind,
                            "state": e.state.as_str(),
                            "count": e.count,
                            "remaining": e.remaining,
                            "windowBlocked": e.window_blocked,
                        })
                    })
                    .collect();
                json!({ "tasks": tasks })
            };
            drop(g);
            (emitter)(json!({ "event": "task.stats", "data": snap }).to_string());
        }
    }
}

fn fire_click(inner: &Arc<Mutex<Inner>>, emitter: &Arc<dyn Fn(String) + Send + Sync>, id: &str, spec: &TaskSpec) {
    let allowed = winmatch::window_allows(&spec.window_match, &spec.window_mode);
    let sent = allowed && input::send_combo_str(&spec.keys, keys::hold_ms_for_interval(spec.interval));
    {
        let mut g = inner.lock().unwrap();
        let Some(e) = g.entries.iter_mut().find(|e| e.id == id) else {
            return;
        };
        if e.state != TaskState::Running {
            return;
        }
        if !allowed {
            e.window_blocked = true;
        } else if sent {
            e.count += 1;
            e.window_blocked = false;
        } else {
            e.window_blocked = false;
        }
    }
    if !sent && allowed {
        (emitter)(
            json!({ "event": "toast", "data": { "level": "error", "message": "按键发送被系统拒绝：目标窗口权限可能更高" } })
                .to_string(),
        );
    }
}

fn fire_timer(inner: &Arc<Mutex<Inner>>, emitter: &Arc<dyn Fn(String) + Send + Sync>, id: &str, spec: &TaskSpec) {
    let allowed = winmatch::window_allows(&spec.window_match, &spec.window_mode);
    let mut fired = false;
    if allowed {
        for step in &spec.seq {
            let keys = keys::parse_keys(step);
            let vks = keys::to_vk_sequence(&keys);
            if !input::send_combo(&vks, 20) {
                break;
            }
            std::thread::sleep(Duration::from_millis(spec.gap.clamp(16, 3_600_000) as u64));
        }
        fired = true;
    }
    let mut g = inner.lock().unwrap();
    let Some(e) = g.entries.iter_mut().find(|e| e.id == id) else {
        return;
    };
    if e.state != TaskState::Running {
        return;
    }
    if allowed && fired {
        e.count += 1;
        e.window_blocked = false;
    } else {
        e.window_blocked = !allowed;
    }
    e.remaining = e.total_secs;
    drop(g);
    let _ = emitter;
}
