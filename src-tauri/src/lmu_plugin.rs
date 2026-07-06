//! Guided (not automated) setup for the rF2 Shared Memory Map Plugin that Le
//! Mans Ultimate needs before Trailbrake can read its telemetry.
//!
//! We deliberately never bundle or download the plugin binary — its only
//! public distribution is the upstream GitHub repo
//! (<https://github.com/TheIronWolfModding/rF2SharedMemoryMapPlugin>, GPL v3)
//! and we redistribute nothing. What we *can* do reliably:
//!   - detect whether LMU is installed (via the Steam library folders) and
//!     whether the plugin DLL is already sitting in its `Plugins` folder,
//!   - flip the "enabled" flag in LMU's own `CustomPluginVariables.JSON`
//!     once the user has dropped the DLL in place themselves, and
//!   - open the Plugins folder / the plugin's GitHub page for them.
//!
//! LMU is Steam app id 2399420, folder name "Le Mans Ultimate".

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// Steam library folder name under `steamapps\common`.
const LMU_FOLDER_NAME: &str = "Le Mans Ultimate";
/// The plugin DLL, and the key it's stored under in `CustomPluginVariables.JSON`.
const PLUGIN_DLL: &str = "rFactor2SharedMemoryMapPlugin64.dll";
/// rF2 quirk: the enabled flag's JSON key has a literal leading space. This
/// must be preserved exactly — the plugin loader reads the key verbatim.
const ENABLED_KEY: &str = " Enabled";
/// Only public source for the plugin binary — we link here, never host it.
pub const DOWNLOAD_URL: &str = "https://github.com/TheIronWolfModding/rF2SharedMemoryMapPlugin";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LmuPluginStatus {
    pub lmu_found: bool,
    pub plugins_dir: Option<String>,
    pub dll_present: bool,
    pub enabled: bool,
}

// --- LMU install detection (Windows: Steam registry + library folders) ---

#[cfg(windows)]
fn steam_path() -> PathBuf {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
        if let Ok(val) = key.get_value::<String, _>("SteamPath") {
            if !val.trim().is_empty() {
                return PathBuf::from(val);
            }
        }
    }
    if let Ok(key) =
        RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\WOW6432Node\\Valve\\Steam")
    {
        if let Ok(val) = key.get_value::<String, _>("InstallPath") {
            if !val.trim().is_empty() {
                return PathBuf::from(val);
            }
        }
    }
    PathBuf::from(r"C:\Program Files (x86)\Steam")
}

/// Pull every `"path"  "..."` value out of `libraryfolders.vdf`, unescaping
/// the doubled backslashes Steam writes. Deliberately a simple line scan
/// rather than a full VDF parser — the file format is stable and this is
/// all we need from it.
#[cfg(windows)]
fn parse_library_paths(vdf_text: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for line in vdf_text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("\"path\"") else {
            continue;
        };
        // `rest` is e.g. `\t\t"D:\\SteamLibrary"` — the value is the first
        // quoted segment after the key.
        let mut parts = rest.splitn(3, '"');
        parts.next(); // leading whitespace before the opening quote
        if let Some(value) = parts.next() {
            out.push(PathBuf::from(value.replace("\\\\", "\\")));
        }
    }
    out
}

#[cfg(windows)]
fn steam_libraries(steam: &Path) -> Vec<PathBuf> {
    let mut libs = vec![steam.to_path_buf()];
    let candidates = [
        steam.join("steamapps").join("libraryfolders.vdf"),
        steam.join("config").join("libraryfolders.vdf"),
    ];
    for vdf in candidates {
        if let Ok(text) = std::fs::read_to_string(&vdf) {
            for lib in parse_library_paths(&text) {
                if !libs.contains(&lib) {
                    libs.push(lib);
                }
            }
            break; // Only the first .vdf that exists is consulted.
        }
    }
    libs
}

#[cfg(windows)]
fn find_lmu_dir() -> Option<PathBuf> {
    steam_libraries(&steam_path()).into_iter().find_map(|lib| {
        let candidate = lib.join("steamapps").join("common").join(LMU_FOLDER_NAME);
        candidate.is_dir().then_some(candidate)
    })
}

#[cfg(not(windows))]
fn find_lmu_dir() -> Option<PathBuf> {
    None
}

// --- Plugin file / config helpers (cross-platform path logic) ---

fn plugins_dir(lmu: &Path) -> PathBuf {
    lmu.join("Plugins")
}

fn dll_path(lmu: &Path) -> PathBuf {
    plugins_dir(lmu).join(PLUGIN_DLL)
}

/// The two places LMU may keep `CustomPluginVariables.JSON`. Both are updated
/// when enabling (if present); when neither exists, the first is created.
fn custom_plugin_variable_paths(lmu: &Path) -> [PathBuf; 2] {
    [
        plugins_dir(lmu).join("CustomPluginVariables.JSON"),
        lmu.join("UserData")
            .join("player")
            .join("CustomPluginVariables.JSON"),
    ]
}

fn plugin_enabled(lmu: &Path) -> bool {
    custom_plugin_variable_paths(lmu).iter().any(|path| {
        let Ok(text) = std::fs::read_to_string(path) else {
            return false;
        };
        let Ok(json) = serde_json::from_str::<Value>(&text) else {
            return false;
        };
        json.get(PLUGIN_DLL)
            .and_then(|entry| entry.get(ENABLED_KEY))
            .map(|v| v.as_i64() == Some(1) || v.as_bool() == Some(true))
            .unwrap_or(false)
    })
}

fn status_for(lmu: &Path) -> LmuPluginStatus {
    LmuPluginStatus {
        lmu_found: true,
        plugins_dir: Some(plugins_dir(lmu).to_string_lossy().into_owned()),
        dll_present: dll_path(lmu).is_file(),
        enabled: plugin_enabled(lmu),
    }
}

// --- Tauri commands ---

#[tauri::command]
pub fn lmu_plugin_status() -> LmuPluginStatus {
    match find_lmu_dir() {
        Some(lmu) => status_for(&lmu),
        None => LmuPluginStatus::default(),
    }
}

/// Flip `" Enabled": 1` for the plugin in whichever `CustomPluginVariables.JSON`
/// files exist (creating `<LMU>\Plugins\CustomPluginVariables.JSON` if
/// neither does), merging into any existing content rather than overwriting
/// it. Never touches the DLL itself — the user has to have already put it in
/// place, since we don't redistribute the plugin.
#[tauri::command]
pub fn lmu_enable_plugin() -> Result<LmuPluginStatus, String> {
    let lmu = find_lmu_dir().ok_or_else(|| {
        "Couldn't find your Le Mans Ultimate install — is it installed via Steam?".to_string()
    })?;
    if !dll_path(&lmu).is_file() {
        return Err(
            "The plugin DLL isn't in LMU's Plugins folder yet — install it there first."
                .to_string(),
        );
    }

    let mut targets: Vec<PathBuf> = custom_plugin_variable_paths(&lmu)
        .into_iter()
        .filter(|p| p.is_file())
        .collect();
    if targets.is_empty() {
        let plugins = plugins_dir(&lmu);
        std::fs::create_dir_all(&plugins).map_err(|e| e.to_string())?;
        targets.push(plugins.join("CustomPluginVariables.JSON"));
    }

    for path in &targets {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let mut root: Value = if text.trim().is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?
        };

        let obj = root
            .as_object_mut()
            .ok_or_else(|| format!("{} does not contain a JSON object", path.display()))?;
        let entry = obj
            .entry(PLUGIN_DLL.to_string())
            .or_insert_with(|| Value::Object(Default::default()));
        let entry_obj = entry.as_object_mut().ok_or_else(|| {
            format!(
                "{}: existing '{PLUGIN_DLL}' entry isn't a JSON object",
                path.display()
            )
        })?;
        entry_obj.insert(ENABLED_KEY.to_string(), Value::from(1));

        let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        std::fs::write(path, pretty).map_err(|e| e.to_string())?;
    }

    Ok(status_for(&lmu))
}

#[tauri::command]
pub fn lmu_open_plugins_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let lmu = find_lmu_dir().ok_or_else(|| {
        "Couldn't find your Le Mans Ultimate install — is it installed via Steam?".to_string()
    })?;
    let plugins = plugins_dir(&lmu);
    std::fs::create_dir_all(&plugins).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(plugins.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lmu_open_download_page(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_url(DOWNLOAD_URL, None::<&str>)
        .map_err(|e| e.to_string())
}
