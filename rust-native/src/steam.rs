//! Read-only Steam discovery and diagnostics. No Steam writes or process changes.
use crate::bindings::{self, Bindings, Value};
use std::{fs, io, path::{Path, PathBuf}};

pub fn has_launch_flag(value: &str) -> bool {
    let value = format!(" {}", value.trim()).to_ascii_lowercase();
    value.match_indices(" -gamestateintegration").any(|(i, flag)| {
        value[i + flag.len()..].chars().next().is_none_or(char::is_whitespace)
    })
}
pub fn saved_launch_flag(text: &str) -> Result<Option<bool>, String> {
    let root = bindings::parse(text)?;
    let apps = root.get("userlocalconfigstore").and_then(|v| v.get("software"))
        .and_then(|v| v.get("valve")).and_then(|v| v.get("steam")).and_then(|v| v.get("apps"));
    let Some(Value::Object(_)) = apps else { return Ok(None); };
    Ok(Some(has_launch_flag(apps.and_then(|v| v.get("570")).and_then(|v| v.get("launchoptions")).and_then(Value::text).unwrap_or(""))))
}
pub fn choose_account(steam: &Path, active: Option<u64>) -> io::Result<Option<String>> {
    let mut ids = Vec::new();
    for entry in fs::read_dir(steam.join("userdata"))? {
        let name = entry?.file_name();
        let Some(id) = name.to_str() else { continue; };
        if !id.is_empty() && id != "0" && id.bytes().all(|b| b.is_ascii_digit()) {
            ids.push(id.to_owned());
        }
    }
    if let Some(id) = active.map(|v| v.to_string()).filter(|v| ids.contains(v)) { return Ok(Some(id)); }
    Ok(if ids.len() == 1 { ids.pop() } else { None })
}
fn valid_dota(path: &Path) -> bool { path.join("game/bin/win64/dota2.exe").is_file() }
pub fn discover_dota(steam: &Path, running_exe: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = running_exe.and_then(Path::parent).and_then(|p| p.ancestors().nth(3)).filter(|p| valid_dota(p)) {
        return Some(path.to_owned());
    }
    let mut libraries = vec![steam.to_owned()];
    if let Ok(text) = fs::read_to_string(steam.join("steamapps/libraryfolders.vdf")) {
        if let Ok(root) = bindings::parse(&text) {
            if let Some(Value::Object(entries)) = root.get("libraryfolders") {
                let mut entries: Vec<_> = entries.iter().collect();
                entries.sort_by_key(|(k,_)| k.parse::<u32>().unwrap_or(u32::MAX));
                libraries.extend(entries.into_iter().filter_map(|(_,v)| v.get("path").and_then(Value::text)).map(PathBuf::from));
            }
        }
    }
    for library in libraries {
        let apps = library.join("steamapps");
        if let Ok(text) = fs::read_to_string(apps.join("appmanifest_570.acf")) {
            if let Ok(root) = bindings::parse(&text) {
                if let Some(name) = root.get("appstate").and_then(|v| v.get("installdir")).and_then(Value::text) {
                    // A manifest must not turn discovery into arbitrary path traversal.
                    let mut parts = Path::new(name).components();
                    if matches!(parts.next(), Some(std::path::Component::Normal(_))) && parts.next().is_none() {
                        let path = apps.join("common").join(name);
                        if valid_dota(&path) { return Some(path); }
                    }
                }
            }
        }
        let path = apps.join("common/dota 2 beta");
        if valid_dota(&path) { return Some(path); }
    }
    None
}
#[derive(Debug)]
pub struct SteamInspection {
    pub launch_flag: Option<bool>,
    pub binding_file: Option<PathBuf>,
    pub bindings: Option<Bindings>,
    pub issue: Option<&'static str>,
}
pub fn inspect(steam: &Path, active: Option<u64>) -> SteamInspection {
    let empty = |issue| SteamInspection { launch_flag: None, binding_file: None, bindings: None, issue: Some(issue) };
    if !steam.join("steam.exe").is_file() { return empty("steam-not-found"); }
    let Ok(Some(id)) = choose_account(steam, active) else { return empty("account-unknown"); };
    let root = steam.join("userdata").join(id);
    let launch_flag = fs::read_to_string(root.join("config/localconfig.vdf")).ok()
        .and_then(|text| saved_launch_flag(&text).ok()).flatten();
    let file = root.join("570/remote/cfg/dotakeys_personal.lst");
    let bindings = fs::read_to_string(&file).ok().and_then(|text| bindings::read(&text).ok());
    let issue = if bindings.is_none() { Some("bindings-unreadable") } else { None };
    SteamInspection { launch_flag, binding_file: Some(file), bindings, issue }
}
#[cfg(windows)]
pub fn automatic_steam()->Option<(PathBuf,Option<u64>)>{
    use winreg::{enums::{HKEY_CURRENT_USER,HKEY_LOCAL_MACHINE},RegKey};
    let hkcu=RegKey::predef(HKEY_CURRENT_USER);let hklm=RegKey::predef(HKEY_LOCAL_MACHINE);
    let user=hkcu.open_subkey("Software\\Valve\\Steam").ok();
    let path=user.as_ref().and_then(|k|k.get_value::<String,_>("SteamPath").ok())
        .or_else(||hklm.open_subkey("SOFTWARE\\WOW6432Node\\Valve\\Steam").ok().and_then(|k|k.get_value::<String,_>("InstallPath").ok()))
        .map(PathBuf::from).or_else(||std::env::var_os("ProgramFiles(x86)").map(|p|PathBuf::from(p).join("Steam")))?;
    if !path.join("steam.exe").is_file(){return None;}
    let active=user.and_then(|k|k.open_subkey("ActiveProcess").ok()).and_then(|k|k.get_value::<u32,_>("ActiveUser").ok()).map(u64::from).filter(|v|*v!=0);
    Some((path,active))
}

#[cfg(windows)]
pub fn diagnostic(c:&crate::config::Config)->serde_json::Value{
    use serde_json::json;
    let Some((steam,id))=automatic_steam()else{return json!({"dotaFound":false,"bindingsIssue":"steam-not-found"});};
    let status=inspect(&steam,id);
    let dota=discover_dota(&steam,None);
    let gsi=dota.as_ref().map(|p|p.join("game/dota/cfg/gamestate_integration/gamestate_integration_voice_invoke.cfg"));
    let raw=gsi.as_ref().and_then(|p|fs::read_to_string(p).ok());
    let matches=raw.as_ref().is_some_and(|v|v.contains(&format!("127.0.0.1:{}/gsi",c.port))&&v.contains(&format!("\"{}\"",c.auth_token)));
    let binding_matches=status.bindings.as_ref().map(|b|b.warnings.is_empty()&&["quas","wex","exort","invoke","slot1","slot2","voice"].iter().all(|k|b.keys.contains_key(*k))&&b.keys.iter().all(|(k,v)|if k=="voice"{&c.voice_chat_key==v}else{c.keys.get(k)==Some(v)})&&b.modes.iter().all(|(k,v)|c.slot_cast_modes.get(k).copied().unwrap_or(if crate::catalog::ITEM_KEYS.contains(&k.as_str()){crate::config::Mode::Quickcast}else{c.cast_mode})==*v));
    json!({"dotaFound":dota.is_some(),"gsiInstalled":raw.is_some(),"gsiConfigMatches":matches,"itemsConfigured":raw.as_ref().is_some_and(|v|v.split_whitespace().collect::<Vec<_>>().windows(2).any(|w|w==["\"items\"","\"1\""])),"savedLaunchFlag":status.launch_flag,"bindingsIssue":status.issue,"bindingMatches":binding_matches,"bindingWarningsCount":status.bindings.as_ref().map(|b|b.warnings.len()).unwrap_or(0),"local":{"gsiPath":gsi,"bindingWarnings":status.bindings.as_ref().map(|b|&b.warnings)}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_options_are_read_only() {
        assert!(has_launch_flag("-windowed -GAMESTATEINTEGRATION -noborder"));
        assert!(!has_launch_flag("-gamestateintegration-extra"));
        assert!(!has_launch_flag("-x-gamestateintegration"));
        let text = r#""UserLocalConfigStore" {"Software" {"Valve" {"Steam" {"Apps" {"570" {"LaunchOptions" "-gamestateintegration"}}}}}}"#;
        assert_eq!(saved_launch_flag(text).unwrap(), Some(true));
        assert_eq!(saved_launch_flag(r#""other" "1""#).unwrap(), None);
    }
    #[test]
    fn no_guess_when_multiple_steam_accounts() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("userdata/12")).unwrap();
        assert_eq!(choose_account(dir.path(), None).unwrap().as_deref(), Some("12"));
        fs::create_dir_all(dir.path().join("userdata/34")).unwrap();
        assert_eq!(choose_account(dir.path(), None).unwrap(), None);
        assert_eq!(choose_account(dir.path(), Some(34)).unwrap().as_deref(), Some("34"));
        assert_eq!(choose_account(dir.path(), Some(99)).unwrap(), None);
    }
    #[test]
    fn discover_from_running_executable_and_library_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let steam = dir.path().join("steam");
        let library = dir.path().join("library");
        let dota = library.join("steamapps/common/custom dota");
        let exe = dota.join("game/bin/win64/dota2.exe");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"").unwrap();
        fs::create_dir_all(steam.join("steamapps")).unwrap();
        let lib = library.to_string_lossy().replace('\\', "\\\\");
        fs::write(steam.join("steamapps/libraryfolders.vdf"), format!(r#""libraryfolders" {{"1" {{"path" "{lib}"}}}}"#)).unwrap();
        fs::write(library.join("steamapps/appmanifest_570.acf"), r#""AppState" {"installdir" "custom dota"}"#).unwrap();
        assert_eq!(discover_dota(&steam, None), Some(dota.clone()));
        assert_eq!(discover_dota(&steam, Some(&exe)), Some(dota));
    }
}

