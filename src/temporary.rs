//! Process-local temporary storage, configured before the async runtime starts.
use crate::config::{self, Paths};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

static DIRECTORIES: OnceLock<Directories> = OnceLock::new();

pub struct Directories {
    root: PathBuf,
    spool: PathBuf,
    sqlite: PathBuf,
    helpers: PathBuf,
}

pub fn valid_setting(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(|s| {
            !s.trim().is_empty() && !s.chars().any(char::is_control) && Path::new(s).is_absolute()
        })
}

fn directory(home: &Path, config: &Value) -> Result<PathBuf> {
    if !valid_setting(&config["temporaryDirectory"]) {
        bail!("临时目录必须是服务器上的绝对路径，或 null（使用默认目录）");
    }
    let path = config["temporaryDirectory"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("tmp"));
    Ok(if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    })
}

fn private_directory(path: &Path) -> Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .with_context(|| format!("无法创建临时目录: {}", path.display()))?;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!(
            "临时目录必须是实际目录，不能是文件或符号链接: {}",
            path.display()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o777 != 0o700
        {
            bail!("临时目录必须属于当前用户且权限为 0700: {}", path.display());
        }
    }
    Ok(())
}

impl Directories {
    pub fn prepare(home: &Path, config: &Value) -> Result<Self> {
        let root = directory(home, config)?;
        private_directory(&root)?;
        // PowerShell and other Windows tools reject verbatim paths even for
        // ordinary directories. Keep that form only when Windows requires it.
        let root = dunce::canonicalize(root)?;
        let dirs = Self {
            spool: root.join("spool"),
            sqlite: root.join("sqlite"),
            helpers: root.join("helpers"),
            root,
        };
        for path in [&dirs.spool, &dirs.sqlite, &dirs.helpers] {
            private_directory(path)?;
            // Test actual file creation without leaving a named probe behind.
            tempfile::tempfile_in(path)
                .with_context(|| format!("临时目录不可写: {}", path.display()))?;
        }
        Ok(dirs)
    }
}

/// Called only from a synchronous executable entry point, before any threads
/// or SQLite connections exist. Environment changes are never made on reload.
pub fn initialize() -> Result<()> {
    let paths = Paths::from_env()?;
    let input = match std::fs::read(&paths.config) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("Invalid JSON: {}", paths.config.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.into()),
    };
    let config = config::normalize(&input);
    let dirs = Directories::prepare(&paths.home, &config)?;
    #[cfg(unix)]
    {
        std::env::set_var("SQLITE_TMPDIR", &dirs.sqlite);
        std::env::set_var("TMPDIR", &dirs.helpers);
    }
    #[cfg(windows)]
    {
        // SQLite's native Windows VFS uses GetTempPath, not SQLITE_TMPDIR.
        std::env::set_var("TMP", &dirs.sqlite);
        std::env::set_var("TEMP", &dirs.sqlite);
    }
    DIRECTORIES
        .set(dirs)
        .map_err(|_| anyhow::anyhow!("Temporary storage already initialized"))
}

pub(crate) fn spool_file() -> std::io::Result<std::fs::File> {
    if let Some(dirs) = DIRECTORIES.get() {
        tempfile::tempfile_in(&dirs.spool)
    } else {
        // Unit tests and library consumers may run without the CLI bootstrap.
        tempfile::tempfile()
    }
}

#[cfg(windows)]
pub(crate) fn helpers_directory() -> PathBuf {
    DIRECTORIES
        .get()
        .map(|dirs| dirs.helpers.clone())
        .unwrap_or_else(std::env::temp_dir)
}

pub(crate) fn status(home: &Path, config: &Value) -> Value {
    let default = directory(home, &json!({})).ok();
    let desired = directory(home, config).ok();
    let configured = desired
        .as_ref()
        .map(|path| dunce::canonicalize(path).unwrap_or_else(|_| path.clone()));
    let active = DIRECTORIES.get().map(|dirs| dirs.root.clone());
    json!({"defaultDirectory":default,"activeDirectory":active,
        "configuredDirectory":desired,"restartRequired":active != configured,
        "spoolDirectory":active.as_ref().map(|path| path.join("spool")),
        "sqliteDirectory":active.as_ref().map(|path| path.join("sqlite"))})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_directories_are_writable_and_probes_leave_no_files() {
        let home = tempfile::tempdir().unwrap();
        let dirs = Directories::prepare(home.path(), &json!({})).unwrap();
        assert_eq!(
            dirs.root.canonicalize().unwrap(),
            home.path().canonicalize().unwrap().join("tmp")
        );
        for path in [&dirs.spool, &dirs.sqlite, &dirs.helpers] {
            assert_eq!(std::fs::read_dir(path).unwrap().count(), 0);
        }
        let custom = home.path().join("custom temporary files");
        assert_eq!(
            Directories::prepare(home.path(), &json!({"temporaryDirectory":custom}))
                .unwrap()
                .root
                .canonicalize()
                .unwrap(),
            custom.canonicalize().unwrap()
        );
        let blocked = home.path().join("blocked");
        std::fs::write(&blocked, "sentinel").unwrap();
        assert!(Directories::prepare(home.path(), &json!({"temporaryDirectory":blocked})).is_err());
        assert_eq!(std::fs::read_to_string(blocked).unwrap(), "sentinel");
    }

    #[cfg(unix)]
    #[test]
    fn shared_or_symlinked_directories_are_rejected_without_changing_them() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let home = tempfile::tempdir().unwrap();
        let shared = home.path().join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Directories::prepare(home.path(), &json!({"temporaryDirectory":shared})).is_err());
        assert_eq!(
            std::fs::metadata(&shared).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let link = home.path().join("link");
        symlink(&shared, &link).unwrap();
        assert!(Directories::prepare(home.path(), &json!({"temporaryDirectory":link})).is_err());
    }
}
