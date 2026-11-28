//! Native preferences. During migration, all writes are isolated from 1.1.1.
use crate::config::Config;
use std::{fs, io::{self, Write}, path::{Path, PathBuf}};
use tempfile::NamedTempFile;

pub fn native_directory() -> io::Result<PathBuf> {
    let base = std::env::var_os("APPDATA").filter(|p| !p.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData/Roaming").into_os_string()))
        .ok_or_else(|| io::Error::other("Windows AppData directory unavailable"))?;
    Ok(PathBuf::from(base).join("VoiceInvokerNative"))
}

fn copy_once(path: &Path, bytes: &[u8]) -> io::Result<bool> {
    let parent = path.parent().ok_or_else(|| io::Error::other("Missing parent"))?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    match tmp.persist_noclobber(path) {
        Ok(_) => Ok(true),
        Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e.error),
    }
}
pub struct Store { directory: PathBuf }
impl Store {
    pub fn open(directory: &Path) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        Ok(Self { directory: directory.canonicalize()? })
    }
    pub fn path(&self) -> PathBuf { self.directory.join("config.json") }
    pub fn migrate(&self, source: &Path) -> io::Result<bool> {
        if self.path().exists() { return Ok(false); }
        match fs::read(source) {
            Ok(bytes) => copy_once(&self.path(), &bytes),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
    pub fn load(&self) -> Result<Option<Config>, Box<dyn std::error::Error>> {
        let bytes = match fs::read(self.path()) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let parsed = std::str::from_utf8(&bytes).map_err(|e| Box::new(e) as Box<dyn std::error::Error>).and_then(Config::from_json);
        match parsed {
            Ok(config) => Ok(Some(config)),
            Err(e) => {
                // Preserve both the live config and the first broken snapshot.
                copy_once(&self.directory.join("config.json.broken"), &bytes)?;
                Err(e)
            }
        }
    }
    pub fn save(&self, config: &Config) -> Result<(), Box<dyn std::error::Error>> {
        crate::input::validate_keys(config)?;
        let mut bytes = serde_json::to_vec_pretty(config)?;
        bytes.push(b'\n');
        let mut tmp = NamedTempFile::new_in(&self.directory)?;
        tmp.write_all(&bytes)?;
        tmp.as_file().sync_all()?;
        // persist replaces atomically on the same filesystem; the temporary
        // file is removed by its RAII guard on failure.
        tmp.persist(self.path()).map_err(|e| e.error)?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_preserves_source_unicode_and_unknown_fields() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("legacy.json");
        let text = br#"{"microphone":"Mic","custom":{"unknown":42}}"#;
        fs::write(&source, text).unwrap();
        let store = Store::open(&root.path().join("native")).unwrap();
        assert!(store.migrate(&source).unwrap());
        let mut config = store.load().unwrap().unwrap();
        config.microphone = "Микрофон".into();
        store.save(&config).unwrap();
        assert!(!store.migrate(&source).unwrap());
        let config = store.load().unwrap().unwrap();
        assert_eq!(config.microphone, "Микрофон");
        assert_eq!(config.other["custom"]["unknown"], 42);
        assert_eq!(fs::read(source).unwrap(), text);
        assert_eq!(fs::read_dir(store.directory).unwrap().count(), 1);
    }
    #[test]
    fn broken_preferences_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        fs::write(store.path(), b"{broken").unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(store.path()).unwrap(), b"{broken");
        assert_eq!(fs::read(root.path().join("config.json.broken")).unwrap(), b"{broken");
        fs::write(store.path(), b"{other").unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(root.path().join("config.json.broken")).unwrap(), b"{broken");
    }
    #[test]
    fn invalid_config_and_failed_replace_keep_existing_data() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        let mut config = Config::default();
        store.save(&config).unwrap();
        let before = fs::read(store.path()).unwrap();
        config.voice_chat_key = "Q".into();
        assert!(store.save(&config).is_err());
        assert_eq!(fs::read(store.path()).unwrap(), before);
        fs::remove_file(store.path()).unwrap();
        fs::create_dir(store.path()).unwrap();
        fs::write(store.path().join("keep"), b"safe").unwrap();
        assert!(store.save(&Config::default()).is_err());
        assert_eq!(fs::read(store.path().join("keep")).unwrap(), b"safe");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}
