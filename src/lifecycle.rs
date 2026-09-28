use crate::config::{ensure_dir, read_json, text, Paths};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use tokio::fs;
#[cfg(target_os = "macos")]
use tokio::process::Command;

pub async fn start_time(pid: u32) -> Option<String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).await.ok()?;
        let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .await
            .ok()?;
        return parse_start_time("linux", &stat, &boot);
    }
    #[cfg(target_os = "macos")]
    {
        let out = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "lstart="])
                .env("LC_ALL", "C")
                .env("TZ", "UTC")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .ok()?
        .ok()?;
        let s = String::from_utf8(out.stdout)
            .ok()?
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        return out
            .status
            .success()
            .then(|| parse_start_time("darwin", &s, ""))
            .flatten();
    }
    #[cfg(windows)]
    {
        return windows_start_time(pid).ok().flatten();
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(windows)]
fn windows_start_time(pid: u32) -> std::io::Result<Option<String>> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{ERROR_INVALID_PARAMETER, FILETIME, STILL_ACTIVE},
        System::Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };

    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    // Own the handle so all query and error paths close it without launching a shell.
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut exit_code = 0;
    if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit_code) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if exit_code != STILL_ACTIVE as u32 {
        return Ok(None);
    }
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe {
        GetProcessTimes(
            process.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    // FILETIME starts in 1601; preserve the .NET tick epoch used by existing lock files.
    Ok(ticks
        .checked_add(504_911_232_000_000_000)
        .and_then(|ticks| parse_start_time("win32", &ticks.to_string(), "")))
}

fn parse_start_time(platform: &str, output: &str, boot: &str) -> Option<String> {
    match platform {
        "linux" => {
            let fields = output
                .rsplit_once(") ")?
                .1
                .split_whitespace()
                .collect::<Vec<_>>();
            let ticks = *fields.get(19)?;
            if ticks.is_empty()
                || !ticks.bytes().all(|c| c.is_ascii_digit())
                || uuid::Uuid::parse_str(boot.trim()).is_err()
            {
                return None;
            }
            Some(format!("linux:{}:{ticks}", boot.trim()))
        }
        "darwin" => {
            let value = output.split_whitespace().collect::<Vec<_>>().join(" ");
            chrono::NaiveDateTime::parse_from_str(&value, "%a %b %e %T %Y").ok()?;
            Some(format!("darwin:{value}"))
        }
        "win32"
            if output.trim().len() >= 17 && output.trim().bytes().all(|c| c.is_ascii_digit()) =>
        {
            Some(format!("win32:{}", output.trim()))
        }
        _ => None,
    }
}

pub fn powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}
pub fn hostname() -> String {
    hostname::get()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
pub async fn inspect(identity: &Value) -> &'static str {
    let Some(pid) = identity["pid"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= i32::MAX as u64)
        .map(|v| v as u32)
    else {
        return "unknown";
    };
    if !identity["hostname"].is_null() && identity["hostname"] != hostname() {
        return "unknown";
    }
    #[cfg(unix)]
    if unsafe { libc::kill(pid as i32, 0) } != 0 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::ESRCH) {
            return "dead";
        }
        if e.raw_os_error() != Some(libc::EPERM) {
            return "unknown";
        }
    }
    #[cfg(windows)]
    {
        match windows_start_time(pid) {
            Ok(Some(current)) => compare_start_time(&identity["startTime"], &current),
            Ok(None) => "dead",
            Err(_) => "unknown",
        }
    }
    #[cfg(not(windows))]
    {
        let Some(current) = start_time(pid).await else {
            return "unknown";
        };
        compare_start_time(&identity["startTime"], &current)
    }
}
fn compare_start_time(previous: &Value, current: &str) -> &'static str {
    let previous = text(previous);
    if previous.is_empty() || current.is_empty() {
        return "unknown";
    }
    if ["linux:", "darwin:", "win32:"]
        .iter()
        .any(|p| previous.starts_with(p))
    {
        if previous.split(':').next() != current.split(':').next() {
            return "unknown";
        }
        return if previous == current { "alive" } else { "dead" };
    }
    if previous.bytes().all(|b| b.is_ascii_digit())
        && current.starts_with("linux:")
        && current.split(':').next_back() != Some(previous)
    {
        return "dead";
    }
    "unknown"
}
pub struct InstanceLock {
    pub identity: Value,
    path: PathBuf,
    marker: String,
    heartbeat: tokio::task::JoinHandle<()>,
}
async fn remove_generation(path: &Path, marker: &str) -> Result<()> {
    for remove_marker in [true, false] {
        let result = crate::fsutil::retry_sharing(|| async {
            if remove_marker {
                fs::remove_file(path.join(marker)).await
            } else {
                fs::remove_dir(path).await
            }
        })
        .await;
        match result {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
impl InstanceLock {
    pub async fn acquire(paths: &Paths) -> Result<Self> {
        ensure_dir(&paths.home).await?;
        let identity = json!({"pid":std::process::id(),"startTime":start_time(std::process::id()).await,"hostname":hostname()});
        let marker = format!("owner-{}.json", uuid::Uuid::new_v4());
        loop {
            if fs::symlink_metadata(&paths.lock).await.is_ok() {
                let mut read =
                    match crate::fsutil::retry_sharing(|| fs::read_dir(&paths.lock)).await {
                        Ok(read) => read,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(e) => return Err(e.into()),
                    };
                let mut names = Vec::new();
                while let Some(e) = read.next_entry().await? {
                    names.push(e.file_name().to_string_lossy().into_owned());
                }
                let generation = names.first().filter(|n| {
                    names.len() == 1
                        && (n.as_str() == "owner.json"
                            || n.strip_prefix("owner-")
                                .and_then(|n| n.strip_suffix(".json"))
                                .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok()))
                });
                let owner = if let Some(m) = generation {
                    match crate::fsutil::retry_sharing(|| fs::read_to_string(paths.lock.join(m)))
                        .await
                    {
                        Ok(v) => serde_json::from_str(&v).unwrap_or(Value::Null),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(_) => Value::Null,
                    }
                } else {
                    Value::Null
                };
                let state = inspect(&owner).await;
                let metadata = match fs::metadata(&paths.lock).await {
                    Ok(m) => m,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                };
                let stale = SystemTime::now()
                    .duration_since(metadata.modified()?)
                    .unwrap_or_default()
                    >= Duration::from_secs(10);
                if state == "alive" || !stale {
                    bail!("ELOCKED: 此数据目录已有 CableTidy 实例运行，或异常退出后的锁尚未过期；异常退出后等待 10 秒再重试: {}",paths.home.display());
                }
                if state == "unknown" || generation.is_none() {
                    bail!("ELOCKUNKNOWN: 无法确认旧实例锁的进程身份。请确认实例已退出后，手动删除锁目录并重新启动: {}",paths.lock.display());
                }
                remove_generation(&paths.lock, generation.unwrap()).await?;
                continue;
            }
            let staged = paths
                .home
                .join(format!(".daemon-lock-{}", uuid::Uuid::new_v4()));
            ensure_dir(&staged).await?;
            let result = async {
                crate::config::write_json(&staged.join(&marker), &identity).await?;
                // Windows can deny a directory rename until competing handles close.
                crate::fsutil::retry_sharing(|| fs::rename(&staged, &paths.lock))
                    .await
                    .context("publish daemon lock")?;
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                // The competing owner may release its lock before the metadata check.
                let contended = error.downcast_ref::<std::io::Error>().is_some_and(|e| {
                    matches!(
                        e.kind(),
                        std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty
                    )
                });
                let _ = fs::remove_dir_all(&staged).await;
                if contended || fs::metadata(&paths.lock).await.is_ok() {
                    continue;
                }
                return Err(error);
            }
            let path = paths.lock.clone();
            let heart_path = path.clone();
            let heart_marker = marker.clone();
            let heartbeat = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if fs::metadata(heart_path.join(&heart_marker)).await.is_err() {
                        break;
                    }
                    let _ = filetime::set_file_mtime(
                        &heart_path,
                        filetime::FileTime::from_system_time(SystemTime::now()),
                    );
                }
            });
            return Ok(Self {
                identity,
                path,
                marker,
                heartbeat,
            });
        }
    }
    pub async fn release(self) -> Result<()> {
        self.heartbeat.abort();
        remove_generation(&self.path, &self.marker).await
    }
}
impl Drop for InstanceLock {
    fn drop(&mut self) {
        self.heartbeat.abort();
    }
}
pub async fn persist_runtime(
    paths: &Paths,
    identity: &Value,
    config: &Value,
    started: &str,
) -> Result<()> {
    let host = text(&config["web"]["listenHost"]);
    let port = &config["web"]["port"];
    crate::config::write_json(&paths.runtime,&json!({"pid":std::process::id(),"pidStartTime":identity["startTime"],"startedAt":started,"web":{"host":host,"port":port,"url":format!("http://{}:{port}/",crate::config::url_host(host))},"revision":config["revision"]})).await
}
pub async fn status(paths: &Paths) -> Result<Value> {
    let Some(raw) = read_json(&paths.config).await? else {
        return Ok(
            json!({"runtime":{"status":"offline","liveness":"尚未启动，未找到配置；请执行 cabletidy start"}}),
        );
    };
    let config = crate::config::normalize(&raw);
    let mut runtime = read_json(&paths.runtime).await?.unwrap_or_else(
        || json!({"web":{"host":config["web"]["listenHost"],"port":config["web"]["port"]}}),
    );
    let host = text(&runtime["web"]["host"]);
    let port = &runtime["web"]["port"];
    let url = format!("http://{}:{port}/", crate::config::url_host(host));
    let valid = runtime["pid"].as_u64().is_some_and(|v| v > 0)
        && crate::validation::loopback(host)
        && port.as_u64().is_some_and(|v| v > 0 && v <= 65535);
    let mut online = false;
    if valid {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(1500))
            .build()?;
        if let Ok(r) = client.get(format!("{url}api/v1/runtime")).send().await {
            if r.status() == 200
                && r.headers()
                    .get("x-cabletidy")
                    .is_some_and(|v| v == "cabletidy")
            {
                if let Ok(v) = r.json::<Value>().await {
                    online = v["pid"] == runtime["pid"] && v["startedAt"] == runtime["startedAt"];
                }
            }
        }
    }
    runtime["web"]["url"] = json!(url);
    runtime["status"] = json!(if online { "online" } else { "offline" });
    runtime["liveness"] = json!(if online {
        "Web runtime probe 正常"
    } else {
        "CableTidy daemon 不在线或管理台无响应"
    });
    Ok(
        json!({"configRevision":config["revision"],"runtime":runtime,"configurations":crate::config::entries(&config["bindings"]).map(|(id,b)|json!({"id":id,"name":b.get("name").unwrap_or(&json!(id)),"target":b["target"],"url":format!("{}/v1",crate::config::base_url(&config,id)),"enabled":crate::config::enabled(b)&&crate::config::enabled(&config["virtualProviders"][text(&b["virtualProvider"])])})).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_identities_parse_platform_outputs_and_reject_garbage() {
        let boot = "bf23e060-d468-4a6b-97bd-7ff0b95a3aab";
        let mut fields = vec!["S"];
        fields.extend(["0"; 18]);
        fields.extend(["123", "456"]);
        let stat = format!("1234 (a ) tricky (name) {}", fields.join(" "));
        assert_eq!(
            parse_start_time("linux", &stat, boot),
            Some(format!("linux:{boot}:123"))
        );
        assert_eq!(parse_start_time("linux", &stat, "invalid"), None);
        assert_eq!(
            parse_start_time("darwin", " Tue Sep 22  08:01:02 2026\n", ""),
            Some("darwin:Tue Sep 22 08:01:02 2026".into())
        );
        assert_eq!(
            parse_start_time("win32", "639256032620000000\r\n", ""),
            Some("win32:639256032620000000".into())
        );
        for platform in ["linux", "darwin", "win32", "unsupported"] {
            assert_eq!(parse_start_time(platform, "bad", "bad"), None);
        }
    }

    #[test]
    fn generations_distinguish_reused_pids_reboots_and_legacy_records() {
        let current = "linux:bf23e060-d468-4a6b-97bd-7ff0b95a3aab:123";
        assert_eq!(compare_start_time(&json!(current), current), "alive");
        assert_eq!(
            compare_start_time(&json!(current.replace(":123", ":456")), current),
            "dead"
        );
        assert_eq!(
            compare_start_time(
                &json!("linux:00000000-0000-0000-0000-000000000000:123"),
                current
            ),
            "dead"
        );
        assert_eq!(compare_start_time(&json!("123"), current), "unknown");
        assert_eq!(compare_start_time(&json!("456"), current), "dead");
        for value in [
            json!(123),
            json!({}),
            json!([current]),
            Value::Null,
            json!(""),
        ] {
            assert_eq!(compare_start_time(&value, current), "unknown");
        }
        assert_eq!(
            compare_start_time(&json!("win32:639256032620000000"), current),
            "unknown"
        );
        assert_eq!(compare_start_time(&json!(current), ""), "unknown");
    }

    #[tokio::test]
    async fn current_process_is_identifiable_and_foreign_hosts_are_unknown() {
        let pid = std::process::id();
        let start = start_time(pid)
            .await
            .expect("supported OS must identify its own process");
        assert_eq!(
            inspect(&json!({"pid":pid,"startTime":start})).await,
            "alive"
        );
        assert_eq!(
            inspect(&json!({"pid":pid,"startTime":start,"hostname":"another-host"})).await,
            "unknown"
        );
        for pid in [
            Value::Null,
            json!(-1),
            json!(0),
            json!("42"),
            json!(1.5),
            json!(u32::MAX),
        ] {
            assert_eq!(inspect(&json!({"pid":pid})).await, "unknown");
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn exited_process_is_dead_while_its_child_handle_is_retained() {
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(child.wait().unwrap().success());
        assert_eq!(inspect(&json!({"pid":pid})).await, "dead");
        drop(child);
    }

    #[tokio::test]
    async fn releasing_an_old_generation_preserves_the_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_owned());
        let old = InstanceLock::acquire(&paths).await.unwrap();
        fs::remove_file(paths.lock.join(&old.marker)).await.unwrap();
        fs::remove_dir(&paths.lock).await.unwrap();
        let new = InstanceLock::acquire(&paths).await.unwrap();
        old.release().await.unwrap();
        assert_eq!(
            read_json(&paths.lock.join(&new.marker)).await.unwrap(),
            Some(new.identity.clone())
        );
        new.release().await.unwrap();
        assert!(!paths.lock.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_short_lived_owners_only_report_lock_contention() {
        let dir = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(8));
        let tasks = (0..8).map(|_| {
            let paths = Paths::new(dir.path().to_owned());
            let barrier = barrier.clone();
            tokio::spawn(async move {
                let mut errors = Vec::new();
                for _ in 0..20 {
                    barrier.wait().await;
                    match InstanceLock::acquire(&paths).await {
                        Ok(lock) => {
                            tokio::task::yield_now().await;
                            if let Err(error) = lock.release().await {
                                errors.push(error.to_string());
                            }
                        }
                        Err(error) if error.to_string().starts_with("ELOCKED:") => {}
                        Err(error) => errors.push(format!("{error:#}")),
                    }
                }
                errors
            })
        });
        for result in futures_util::future::join_all(tasks).await {
            assert!(
                result.as_ref().is_ok_and(|errors| errors.is_empty()),
                "{result:?}"
            );
        }
        assert!(!dir.path().join("daemon.lock").exists());
    }

    #[tokio::test]
    async fn removing_a_stale_marker_does_not_recursively_delete_new_owners() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("old"), "old").await.unwrap();
        fs::write(dir.path().join("new"), "new").await.unwrap();
        remove_generation(dir.path(), "old").await.unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("new")).await.unwrap(),
            "new"
        );
    }
}
