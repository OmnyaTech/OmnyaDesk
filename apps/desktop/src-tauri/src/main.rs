#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
mod window_modes;

const API: &str = "http://127.0.0.1:4317";
const VAULT: &str = "tech.omnya.desk.workstation";
const ACCOUNT: &str = "operator";

#[derive(Clone)]
struct Active {
    project_id: String,
    bearer: String,
}
#[derive(Default)]
struct Session(Mutex<Option<Active>>);

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(VAULT, ACCOUNT).map_err(|_| "Windows credential storage unavailable".into())
}
fn secret() -> Result<String, String> {
    entry()?
        .get_password()
        .map_err(|_| "Workstation not enrolled".into())
}
fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(9))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot initialize localhost client".into())
}
fn is_workstation_secret(value: &str) -> bool {
    value.len() == 68
        && value.starts_with("ods_")
        && value[4..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
async fn session_projects(credential: &str) -> Result<Value, String> {
    let response = client()?
        .get(format!("{API}/v1/workstation/projects"))
        .bearer_auth(credential)
        .send()
        .await
        .map_err(|_| "Local API unavailable".to_string())?;
    if response.status() != StatusCode::OK {
        return Err("Workstation session is invalid or expired".into());
    }
    response
        .json()
        .await
        .map_err(|_| "Invalid API response".into())
}
#[tauri::command]
async fn desktop_restore() -> Result<Value, String> {
    session_projects(&secret()?).await
}
#[tauri::command]
async fn desktop_login(value: String) -> Result<Value, String> {
    if !is_workstation_secret(&value) {
        return Err("Invalid workstation enrollment key".into());
    }
    let projects = session_projects(&value).await?;
    entry()?
        .set_password(&value)
        .map_err(|_| "Cannot secure workstation credential".to_string())?;
    Ok(projects)
}
#[tauri::command]
async fn desktop_register(app: tauri::AppHandle) -> Result<Value, String> {
    let credential = secret()?;
    // Dialog is OS-native; the renderer never has filesystem permissions.
    let selection =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| "Folder picker failed".to_string())?;
    let selected = selection.ok_or("Folder selection cancelled")?;
    let path = selected
        .into_path()
        .map_err(|_| "A local folder is required".to_string())?;
    let folder = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid project directory name")?
        .to_owned();
    if folder.len() > 140 {
        return Err("Project folder name too long".into());
    }
    let response = client()?
        .post(format!("{API}/v1/workstation/projects"))
        .bearer_auth(credential)
        .json(&json!({"path":path.to_string_lossy(),"name":folder}))
        .send()
        .await
        .map_err(|_| "Local API unavailable".to_string())?;
    if response.status() != StatusCode::CREATED {
        return Err("Folder is not authorized or registered".into());
    }
    response
        .json()
        .await
        .map_err(|_| "Invalid project registration response".into())
}
async fn grant(project_id: &str) -> Result<String, String> {
    if uuid::Uuid::parse_str(project_id).is_err() {
        return Err("Invalid project id".into());
    }
    let credential = secret()?;
    let projects = session_projects(&credential).await?;
    let list = projects
        .get("projects")
        .and_then(Value::as_array)
        .ok_or("Invalid project list")?;
    if !list
        .iter()
        .any(|p| p.get("id").and_then(Value::as_str) == Some(project_id))
    {
        return Err("Project not authorized for this workstation".into());
    }
    let response = client()?
        .post(format!("{API}/v1/workstation/projects/{project_id}/access"))
        .bearer_auth(credential)
        .send()
        .await
        .map_err(|_| "Local API unavailable".to_string())?;
    if response.status() != StatusCode::OK {
        return Err("Workstation project authorization refused".into());
    }
    let info: Value = response
        .json()
        .await
        .map_err(|_| "Invalid access response".to_string())?;
    let token = info
        .get("token")
        .and_then(Value::as_str)
        .ok_or("Missing scoped token")?;
    if token.len() != 68 || !token.starts_with("odt_") {
        return Err("Invalid scoped token".into());
    }
    Ok(token.to_owned())
}
#[tauri::command]
async fn desktop_select(project_id: String, session: State<'_, Session>) -> Result<Value, String> {
    let token = grant(&project_id).await?;
    *session.0.lock().map_err(|_| "Session unavailable")? = Some(Active {
        project_id: project_id.clone(),
        bearer: token,
    });
    Ok(json!({"projectId":project_id}))
}
fn approved_path(path: &str, project_id: &str) -> bool {
    if path == "/v1/projects" {
        return true;
    }
    if path.contains('%')
        || path.contains('#')
        || path.contains("..")
        || path.contains("//")
        || path.contains('\\')
    {
        return false;
    }
    let root = format!("/v1/projects/{project_id}/");
    let Some(rest) = path.strip_prefix(&root) else {
        return false;
    };
    if rest == "tasks" {
        return true;
    }
    if let Some(cursor) = rest.strip_prefix("events?after=") {
        return !cursor.is_empty()
            && cursor.len() <= 16
            && cursor.bytes().all(|c| c.is_ascii_digit());
    }
    let segments: Vec<_> = rest.split('/').collect();
    segments.len() == 3
        && segments[0] == "tasks"
        && segments[2] == "evidence"
        && uuid::Uuid::parse_str(segments[1]).is_ok()
}
async fn scoped_get(path: &str, session: &Session) -> Result<Value, String> {
    let active = session
        .0
        .lock()
        .map_err(|_| "Session unavailable")?
        .clone()
        .ok_or("Select an authorized project")?;
    if !approved_path(path, &active.project_id) {
        return Err("Project/path outside native read allowlist".into());
    }
    let http = client()?;
    let mut response = http
        .get(format!("{API}{path}"))
        .bearer_auth(&active.bearer)
        .send()
        .await
        .map_err(|_| "Local API unavailable".to_string())?;
    if response.status() == StatusCode::UNAUTHORIZED {
        // Refresh the 1-hour read-only token via the same authorized workstation ACL.
        let token = grant(&active.project_id).await?;
        {
            let mut lock = session.0.lock().map_err(|_| "Session unavailable")?;
            if lock.as_ref().map(|s| s.project_id.as_str()) != Some(active.project_id.as_str()) {
                return Err("Project changed during refresh".into());
            }
            *lock = Some(Active {
                project_id: active.project_id,
                bearer: token.clone(),
            });
        }
        response = http
            .get(format!("{API}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| "Local API unavailable".to_string())?;
    }
    if !response.status().is_success() {
        return Err(format!("Scoped API request denied ({})", response.status()));
    }
    response
        .json()
        .await
        .map_err(|_| "Invalid JSON from API".into())
}
#[tauri::command]
async fn desktop_read(path: String, session: State<'_, Session>) -> Result<Value, String> {
    scoped_get(&path, &session).await
}
#[tauri::command]
async fn desktop_poll(after: u64, session: State<'_, Session>) -> Result<Value, String> {
    if after > 9_007_199_254_740_991 {
        return Err("Invalid event cursor".into());
    }
    let id = session
        .0
        .lock()
        .map_err(|_| "Session unavailable")?
        .as_ref()
        .ok_or("Not connected")?
        .project_id
        .clone();
    scoped_get(&format!("/v1/projects/{id}/events?after={after}"), &session).await
}
#[tauri::command]
async fn desktop_logout(session: State<'_, Session>) -> Result<(), String> {
    *session.0.lock().map_err(|_| "Session unavailable")? = None;
    // Remove only this product's entry, not other projects' credentials.
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(_) => Ok(()),
    }
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Session::default())
        .setup(|app| window_modes::setup(app).map_err(Into::into))
        .invoke_handler(tauri::generate_handler![
            desktop_restore,
            desktop_login,
            desktop_register,
            desktop_select,
            desktop_read,
            desktop_poll,
            desktop_logout,
            window_modes::desktop_window_state,
            window_modes::desktop_window_mode,
            window_modes::desktop_always_on_top,
            window_modes::desktop_minimize_to_tray
        ])
        .run(tauri::generate_context!())
        .expect("OmnyaDesk desktop failed");
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_read_allowlist() {
        let id = "11111111-1111-4111-8111-111111111111";
        assert!(approved_path("/v1/projects", id));
        assert!(approved_path(&format!("/v1/projects/{id}/tasks"), id));
        assert!(approved_path(
            &format!("/v1/projects/{id}/events?after=16"),
            id
        ));
        assert!(!approved_path("/v1/workstation/projects", id));
        assert!(!approved_path(
            &format!("/v1/projects/{id}/tasks/../secrets"),
            id
        ));
        assert!(!approved_path(
            "/v1/projects/22222222-2222-4222-8222-222222222222/tasks",
            id
        ));
        assert!(!approved_path(
            &format!("/v1/projects/{id}/events?after=1%26access=1"),
            id
        ));
    }
    #[test]
    fn enrollment_key_shape() {
        assert!(is_workstation_secret(&format!("ods_{}", "a".repeat(64))));
        assert!(!is_workstation_secret(&format!("odt_{}", "a".repeat(64))));
        assert!(!is_workstation_secret(&format!("ods_{}", "A".repeat(64))));
    }
    #[cfg(windows)]
    #[test]
    fn windows_vault_roundtrip_uses_isolated_test_entry() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let service = format!("tech.omnya.desk.qa.{}.{}", std::process::id(), nonce);
        let vault = keyring::Entry::new(&service, "test-only").expect("OS vault available");
        let synthetic = format!("ods_{}", "a".repeat(64));
        vault
            .set_password(&synthetic)
            .expect("OS stores synthetic test secret");
        let actual = vault.get_password();
        let cleanup = vault.delete_credential();
        assert!(
            cleanup.is_ok(),
            "Synthetic OS credential must be cleaned up"
        );
        assert_eq!(
            actual.expect("OS retrieves synthetic test secret"),
            synthetic
        );
    }
}
