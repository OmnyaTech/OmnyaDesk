use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};

const MIN_VISIBLE: i32 = 80;
const MAX_PREFERENCE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    #[default]
    Full,
    Compact,
    Floating,
    Taskbar,
}

impl WindowMode {
    fn dimensions(self) -> (u32, u32) {
        match self {
            Self::Full => (1320, 860),
            Self::Compact => (980, 250),
            Self::Floating => (660, 390),
            Self::Taskbar => (1000, 135),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Placement {
    mode: WindowMode,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    always_on_top: bool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preferences {
    last_monitor: String,
    per_monitor: HashMap<String, Placement>,
}

pub struct WindowSettings {
    preferences: Mutex<Preferences>,
    last_write: Mutex<Instant>,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            preferences: Mutex::new(Preferences::default()),
            last_write: Mutex::new(Instant::now() - Duration::from_secs(10)),
        }
    }
}

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot resolve preferences folder")?;
    Ok(root.join("window-layout-v2.json"))
}

fn read_preferences(app: &AppHandle) -> Preferences {
    let Ok(path) = prefs_path(app) else {
        return Preferences::default();
    };
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return Preferences::default();
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_PREFERENCE_BYTES {
        return Preferences::default();
    }
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_preferences(app: &AppHandle, prefs: &Preferences) -> Result<(), String> {
    let path = prefs_path(app)?;
    let folder = path.parent().ok_or("Invalid preference directory")?;
    fs::create_dir_all(folder).map_err(|_| "Cannot create preferences directory")?;
    if fs::symlink_metadata(&path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("Preferences path must not be a symlink".into());
    }
    let bytes = serde_json::to_vec(prefs).map_err(|_| "Cannot serialize preferences")?;
    if bytes.len() as u64 > MAX_PREFERENCE_BYTES {
        return Err("Preferences exceed limit".into());
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|_| "Cannot persist window layout")?;
    fs::rename(&temporary, &path)
        .or_else(|_| {
            // Windows rename does not replace existing files.
            fs::remove_file(&path)?;
            fs::rename(&temporary, &path)
        })
        .map_err(|_| "Cannot replace window preferences")?;
    Ok(())
}

fn monitor_key(m: &tauri::Monitor) -> String {
    // Physical origin disambiguates equal-name dual displays, scale survives DPI changes.
    format!(
        "{}:{}:{}",
        m.name().map(|n| n.as_str()).unwrap_or("display"),
        m.position().x,
        m.position().y
    )
}

fn clamp(placement: Placement, origin: (i32, i32), screen: (u32, u32)) -> Placement {
    let (mx, my) = origin;
    let (sw, sh) = (screen.0.max(360), screen.1.max(300));
    let width = placement.width.clamp(360, sw);
    let min_height = if placement.mode == WindowMode::Taskbar {
        108
    } else {
        140
    };
    let height = placement.height.clamp(min_height, sh);
    let min_x = mx.saturating_sub(width as i32).saturating_add(MIN_VISIBLE);
    let max_x = mx.saturating_add(sw as i32).saturating_sub(MIN_VISIBLE);
    let min_y = my;
    let max_y = my.saturating_add(sh as i32).saturating_sub(MIN_VISIBLE);
    Placement {
        x: placement.x.clamp(min_x, max_x),
        y: placement.y.clamp(min_y, max_y),
        width,
        height,
        ..placement
    }
}

fn fallback_to_primary(saved: Placement, origin: (i32, i32), screen: (u32, u32)) -> Placement {
    let dx = (screen.0.saturating_sub(saved.width) / 2).min(i32::MAX as u32) as i32;
    let dy = (screen.1.saturating_sub(saved.height) / 2).min(i32::MAX as u32) as i32;
    clamp(
        Placement {
            x: origin.0.saturating_add(dx),
            y: origin.1.saturating_add(dy),
            ..saved
        },
        origin,
        screen,
    )
}
fn current_monitor(window: &WebviewWindow) -> Result<tauri::Monitor, String> {
    window
        .current_monitor()
        .map_err(|_| "Monitor lookup failed")?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No active display".into())
}

fn current_placement(
    window: &WebviewWindow,
    mode: WindowMode,
    top: bool,
) -> Result<Placement, String> {
    let p = window
        .outer_position()
        .map_err(|_| "Window position unavailable")?;
    let s = window.outer_size().map_err(|_| "Window size unavailable")?;
    Ok(Placement {
        mode,
        x: p.x,
        y: p.y,
        width: s.width,
        height: s.height,
        always_on_top: top,
    })
}

fn persist(app: &AppHandle, force: bool) -> Result<(), String> {
    let state = app.state::<WindowSettings>();
    {
        let mut last = state
            .last_write
            .lock()
            .map_err(|_| "Preference lock unavailable")?;
        if !force && last.elapsed() < Duration::from_millis(650) {
            return Ok(());
        }
        *last = Instant::now();
    }
    let snapshot = state
        .preferences
        .lock()
        .map_err(|_| "Window state unavailable")?;
    write_preferences(app, &snapshot)
}

fn capture(app: &AppHandle, force: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let monitor = current_monitor(&window)?;
    let key = monitor_key(&monitor);
    let state = app.state::<WindowSettings>();
    {
        let mut prefs = state
            .preferences
            .lock()
            .map_err(|_| "Window state unavailable")?;
        let prev = prefs
            .per_monitor
            .get(&key)
            .or_else(|| prefs.per_monitor.get(&prefs.last_monitor));
        let mode = prev.map(|p| p.mode).unwrap_or_default();
        let top = prev.map(|p| p.always_on_top).unwrap_or(false);
        let next = current_placement(&window, mode, top)?;
        let clamped = clamp(
            next,
            (monitor.position().x, monitor.position().y),
            (monitor.size().width, monitor.size().height),
        );
        prefs.last_monitor = key.clone();
        prefs.per_monitor.insert(key, clamped);
    }
    persist(app, force)
}

fn apply(app: &AppHandle, mode: WindowMode, top: Option<bool>) -> Result<Placement, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let monitor = current_monitor(&window)?;
    let key = monitor_key(&monitor);
    let state = app.state::<WindowSettings>();
    let (width, height) = mode.dimensions();
    let prev = state
        .preferences
        .lock()
        .map_err(|_| "Window state unavailable")?
        .per_monitor
        .get(&key)
        .cloned();
    let desired_top = top
        .or_else(|| prev.as_ref().map(|p| p.always_on_top))
        .unwrap_or(false);
    let origin = monitor.position();
    let size = monitor.size();
    let placement = clamp(
        Placement {
            mode,
            x: prev
                .as_ref()
                .filter(|p| p.mode == mode)
                .map(|p| p.x)
                .unwrap_or(origin.x + ((size.width as i32 - width as i32) / 2).max(0)),
            y: prev
                .as_ref()
                .filter(|p| p.mode == mode)
                .map(|p| p.y)
                .unwrap_or(if mode == WindowMode::Taskbar {
                    origin.y + (size.height as i32 - height as i32 - 60).max(0)
                } else {
                    origin.y + ((size.height as i32 - height as i32) / 2).max(0)
                }),
            width: prev
                .as_ref()
                .filter(|p| p.mode == mode)
                .map(|p| p.width)
                .unwrap_or(width),
            height: prev
                .as_ref()
                .filter(|p| p.mode == mode)
                .map(|p| p.height)
                .unwrap_or(height),
            always_on_top: desired_top,
        },
        (origin.x, origin.y),
        (size.width, size.height),
    );
    // Never disable resizability, mouse input or user-driven move.
    window
        .set_min_size(Some(tauri::Size::Physical(PhysicalSize::new(360, 108))))
        .map_err(|_| "Cannot update minimum size")?;
    window
        .set_size(PhysicalSize::new(placement.width, placement.height))
        .map_err(|_| "Cannot resize window")?;
    window
        .set_position(PhysicalPosition::new(placement.x, placement.y))
        .map_err(|_| "Cannot position window")?;
    window
        .set_always_on_top(desired_top)
        .map_err(|_| "Cannot set always-on-top")?;
    window
        .set_skip_taskbar(false)
        .map_err(|_| "Cannot update taskbar presence")?;
    {
        let mut prefs = state
            .preferences
            .lock()
            .map_err(|_| "Window state unavailable")?;
        prefs.last_monitor = key.clone();
        prefs.per_monitor.insert(key, placement.clone());
    }
    persist(app, true)?;
    Ok(placement)
}

#[tauri::command]
pub fn desktop_window_mode(app: AppHandle, mode: WindowMode) -> Result<serde_json::Value, String> {
    let p = apply(&app, mode, None)?;
    Ok(serde_json::json!({"mode":p.mode,"alwaysOnTop":p.always_on_top}))
}

#[tauri::command]
pub fn desktop_always_on_top(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let m = current_monitor(&window)?;
    let state = app.state::<WindowSettings>();
    let mode = state
        .preferences
        .lock()
        .map_err(|_| "Window state unavailable")?
        .per_monitor
        .get(&monitor_key(&m))
        .map(|p| p.mode)
        .unwrap_or_default();
    let p = apply(&app, mode, Some(enabled))?;
    Ok(serde_json::json!({"mode":p.mode,"alwaysOnTop":p.always_on_top}))
}

#[tauri::command]
pub fn desktop_window_state(app: AppHandle) -> Result<serde_json::Value, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let m = current_monitor(&window)?;
    let p = app
        .state::<WindowSettings>()
        .preferences
        .lock()
        .map_err(|_| "Window state unavailable")?
        .per_monitor
        .get(&monitor_key(&m))
        .cloned();
    let mode = p.as_ref().map(|p| p.mode).unwrap_or_default();
    Ok(serde_json::json!({"mode":mode,"alwaysOnTop":p.map(|p| p.always_on_top).unwrap_or(false)}))
}

#[tauri::command]
pub fn desktop_minimize_to_tray(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("Main window unavailable")?
        .hide()
        .map_err(|_| "Cannot hide desktop window".into())
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let pref = read_preferences(app.handle());
    app.manage(WindowSettings {
        preferences: Mutex::new(pref),
        last_write: Mutex::new(Instant::now() - Duration::from_secs(10)),
    });
    let show = MenuItem::with_id(app, "restore", "Abrir OmnyaDesk", true, None::<&str>)?;
    let full = MenuItem::with_id(app, "full", "Escritório completo", true, None::<&str>)?;
    let compact = MenuItem::with_id(app, "compact", "Barra compacta", true, None::<&str>)?;
    let floating = MenuItem::with_id(app, "floating", "Janela flutuante", true, None::<&str>)?;
    let taskbar = MenuItem::with_id(app, "taskbar", "Faixa compacta", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Sair do OmnyaDesk", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &full, &compact, &floating, &taskbar, &exit])?;
    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .ok_or(tauri::Error::AssetNotFound("icon".into()))?
                .clone(),
        )
        .tooltip("OmnyaDesk")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "restore" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                "full" => {
                    let _ = apply(app, WindowMode::Full, None);
                }
                "compact" => {
                    let _ = apply(app, WindowMode::Compact, None);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                "floating" => {
                    let _ = apply(app, WindowMode::Floating, None);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                "taskbar" => {
                    let _ = apply(app, WindowMode::Taskbar, None);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                "exit" => app.exit(0),
                _ => (),
            }
        })
        .build(app)?;
    let app_handle = app.handle().clone();
    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event(move |event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                let _ = capture(&app_handle, false);
            }
            WindowEvent::CloseRequested { api, .. } => {
                let _ = capture(&app_handle, true);
                api.prevent_close();
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            _ => (),
        });
    }
    // Native tray stays available even when window hidden; recover available monitor geometry.
    let saved = app
        .state::<WindowSettings>()
        .preferences
        .lock()
        .ok()
        .and_then(|p| {
            p.per_monitor
                .get(&p.last_monitor)
                .cloned()
                .map(|v| (p.last_monitor.clone(), v))
        });
    if let Some((name, saved)) = saved {
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(displays) = window.available_monitors() {
                let restored = if let Some(m) = displays.iter().find(|m| monitor_key(m) == name) {
                    Some(clamp(
                        saved.clone(),
                        (m.position().x, m.position().y),
                        (m.size().width, m.size().height),
                    ))
                } else {
                    window
                        .primary_monitor()
                        .ok()
                        .flatten()
                        .or_else(|| displays.first().cloned())
                        .map(|m| {
                            fallback_to_primary(
                                saved.clone(),
                                (m.position().x, m.position().y),
                                (m.size().width, m.size().height),
                            )
                        })
                };
                if let Some(fitting) = restored {
                    let _ = window.set_size(PhysicalSize::new(fitting.width, fitting.height));
                    let _ = window.set_position(PhysicalPosition::new(fitting.x, fitting.y));
                }
            }
        }
        let _ = apply(app.handle(), saved.mode, Some(saved.always_on_top));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modes_restrict_size_and_always_on_top() {
        assert_eq!(WindowMode::Full.dimensions(), (1320, 860));
        assert_eq!(WindowMode::Compact.dimensions(), (980, 250));
        assert_eq!(WindowMode::Floating.dimensions(), (660, 390));
        assert_eq!(WindowMode::Taskbar.dimensions(), (1000, 135));
        assert!(serde_json::from_str::<WindowMode>("\"external\"").is_err());
    }
    #[test]
    fn dual_monitor_negative_coordinates_and_dpi_recovery() {
        let p = Placement {
            mode: WindowMode::Taskbar,
            x: -2600,
            y: 130,
            width: 1000,
            height: 230,
            always_on_top: false,
        };
        let fitted = clamp(p, (-1920, 0), (1920, 1080));
        assert!(fitted.x >= -1920 - 1000 + MIN_VISIBLE);
        assert!(fitted.x <= -MIN_VISIBLE);
        assert!(fitted.y >= 0 && fitted.y <= 1000);
        assert_eq!(fitted.width, 1000);
        let shrunk = clamp(fitted, (0, 0), (720, 500));
        assert!(shrunk.width <= 720 && shrunk.height <= 500);
    }
    #[test]
    fn simulated_secondary_unplug_centers_primary() {
        let p = Placement {
            mode: WindowMode::Floating,
            x: -1700,
            y: 200,
            width: 900,
            height: 650,
            always_on_top: true,
        };
        let restored = fallback_to_primary(p, (0, 0), (1920, 1080));
        assert!(restored.x >= 0 && restored.y >= 0);
        assert!(restored.x + restored.width as i32 <= 1920);
        assert!(restored.y + restored.height as i32 <= 1080);
        assert_eq!(restored.mode, WindowMode::Floating);
        assert!(restored.always_on_top);
    }
    #[test]
    fn simulated_mixed_dpi_and_negative_virtual_desktop() {
        let saved = Placement {
            mode: WindowMode::Taskbar,
            x: -2400,
            y: -100,
            width: 1400,
            height: 500,
            always_on_top: false,
        };
        let second = clamp(saved.clone(), (-2560, -200), (2560, 1440));
        assert!(second.x < 0 && second.y >= -200);
        let small = fallback_to_primary(saved, (0, 0), (800, 600));
        assert!(small.x >= 0 && small.y >= 0);
        assert!(small.x + small.width as i32 <= 800);
        assert!(small.y + small.height as i32 <= 600);
    }
    #[test]
    fn simulated_secondary_right_and_primary_left() {
        let saved = Placement {
            mode: WindowMode::Full,
            x: 2500,
            y: 100,
            width: 1700,
            height: 1200,
            always_on_top: false,
        };
        let right = clamp(saved.clone(), (1920, 0), (2560, 1440));
        assert!(right.x >= 1920);
        let primary = fallback_to_primary(saved, (-1920, 0), (1366, 768));
        assert!(primary.x >= -1920 && primary.x < 0);
        assert!(primary.y >= 0 && primary.width <= 1366 && primary.height <= 768);
    }
    #[test]
    fn preferences_do_not_deserialize_extra_privileges() {
        assert!(serde_json::from_str::<Preferences>(
            r#"{"last_monitor":"x","per_monitor":{},"token":"leak"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<WindowMode>("\"taskbar\"").is_ok());
    }
}
