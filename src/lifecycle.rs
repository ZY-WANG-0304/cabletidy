use crate::config::{ensure_dir, read_json, text, Paths};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::time::Duration;
#[cfg(any(target_os = "linux", test))]
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
            // The process can exit between the initial liveness check and the query.
            #[cfg(unix)]
            if unsafe { libc::kill(pid as i32, 0) } != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return "dead";
            }
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
    file: std::fs::File,
}

fn legacy_lock(paths: &Paths) -> Result<()> {
    match std::fs::symlink_metadata(&paths.lock) {
        Ok(m) if m.is_dir() => bail!("ELOCKLEGACY: 检测到旧版 daemon.lock 目录。请核对旧进程后手动执行 kill <PID>（Windows: taskkill /PID <PID>），确认实例已退出，再手动删除旧锁目录并启动新版: {}", paths.lock.display()),
        Ok(m) if !m.is_file() => bail!("Daemon lock must be a regular file: {}", paths.lock.display()),
        Ok(_) => {},
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(e).context("Inspect daemon lock path"),
    }
    Ok(())
}

fn open_lock(paths: &Paths, create: bool) -> Result<Option<std::fs::File>> {
    legacy_lock(paths)?;
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(create)
        .truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = match options.open(&paths.lock) {
        Ok(file) => file,
        Err(e) if !create && e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).context("Open daemon lock"),
    };
    if !file.metadata()?.is_file() {
        bail!("Daemon lock must be a regular file");
    }
    Ok(Some(file))
}

pub fn locked(paths: &Paths) -> Result<bool> {
    let Some(file) = open_lock(paths, false)? else {
        return Ok(false);
    };
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(std::fs::TryLockError::WouldBlock) => Ok(true),
        Err(std::fs::TryLockError::Error(e)) => Err(e).context("Inspect daemon lock"),
    }
}

impl InstanceLock {
    pub async fn acquire(paths: &Paths) -> Result<Self> {
        ensure_dir(&paths.home).await?;
        let file = open_lock(paths, true)?.unwrap();
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => bail!(
                "ELOCKED: 此数据目录已有 CableTidy 实例运行或正在退出: {}",
                paths.home.display()
            ),
            Err(std::fs::TryLockError::Error(e)) => return Err(e).context("Acquire daemon lock"),
        }
        let identity = json!({"pid":std::process::id(),"startTime":start_time(std::process::id()).await,"hostname":hostname(),"controlId":uuid::Uuid::new_v4().to_string()});
        Ok(Self { identity, file })
    }
    pub async fn release(self) -> Result<()> {
        // Never unlink this file: all starters must lock the same underlying object.
        self.file.unlock()?;
        Ok(())
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
    crate::config::write_json(&paths.runtime,&json!({"pid":std::process::id(),"pidStartTime":identity["startTime"],"hostname":identity["hostname"],"controlId":identity["controlId"],"controlVersion":1,"startedAt":started,"web":{"host":host,"port":port,"url":format!("http://{}:{port}/",crate::config::url_host(host))},"revision":config["revision"]})).await
}
async fn prepare_stop(paths: &Paths) -> Result<Option<(Value, crate::control::Stream)>> {
    if !locked(paths)? {
        return Ok(None);
    }
    let runtime = read_json(&paths.runtime).await?.context(
        "Daemon holds its lock but runtime is unavailable; startup or cleanup may be in progress",
    )?;
    let stream = tokio::time::timeout(
        crate::control::TIMEOUT,
        crate::control::connect(paths, &runtime),
    )
    .await
    .context("Daemon holds its lock but the control channel timed out")?
    .context("Daemon holds its lock but the control channel is unavailable")?;
    Ok(Some((runtime, stream)))
}

fn cancelled_stop(code: i32, submitted: u8) -> i32 {
    match submitted {
        0 => println!("未发送停止请求"),
        1 => println!("已取消等待，停止请求可能已提交；请使用 cabletidy status 查询状态"),
        _ => println!("已取消等待，停止请求仍将继续执行"),
    }
    code
}

pub async fn stop(
    paths: &Paths,
    cancellation: impl std::future::Future<Output = i32>,
) -> Result<i32> {
    tokio::pin!(cancellation);
    let prepared = tokio::select! {
        biased;
        code = &mut cancellation => return Ok(cancelled_stop(code, 0)),
        prepared = prepare_stop(paths) => prepared?,
    };
    let Some((runtime, mut stream)) = prepared else {
        println!("CableTidy is not running");
        return Ok(0);
    };
    let mut submitted = 0;
    tokio::select! {
        biased;
        code = &mut cancellation => Ok(cancelled_stop(code, submitted)),
        result = async {
            // Once writing starts, cancellation cannot promise that nothing was sent.
            submitted = 1;
            tokio::time::timeout(crate::control::TIMEOUT, async {
                crate::control::write(&mut stream, &crate::control::request(&runtime, "stop")).await?;
                let ack = crate::control::read(&mut stream).await?;
                if ack["state"] != "stopping" { bail!("Daemon did not acknowledge the stop request"); }
                Ok::<_, anyhow::Error>(())
            }).await.context("Stop acknowledgement timed out; the request may have been accepted")??;
            submitted = 2;
            println!("Stopping CableTidy; waiting for active requests and cleanup...");
            let finished = crate::control::read(&mut stream).await
                .context("Control channel closed before shutdown completed; daemon may have exited abnormally")?;
            if finished["state"] != "stopped" { bail!("Invalid shutdown completion acknowledgement"); }
            println!("CableTidy stopped");
            Ok(0)
        } => result,
    }
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
    let held = locked(paths)?;
    let control_state = if held {
        let probe = async {
            let mut stream = crate::control::connect(paths, &runtime).await?;
            crate::control::write(&mut stream, &crate::control::request(&runtime, "status"))
                .await?;
            crate::control::read(&mut stream).await
        };
        match tokio::time::timeout(crate::control::TIMEOUT, probe).await {
            Ok(Ok(reply)) => match text(&reply["state"]) {
                "running" => "online",
                "draining" => "stopping",
                _ => "unresponsive",
            },
            _ => "unresponsive",
        }
    } else {
        "offline"
    };
    runtime["web"]["url"] = json!(url);
    runtime["status"] = json!(control_state);
    runtime["liveness"] = json!(match control_state {
        "online" => "本地控制通道正常",
        "stopping" => "正在等待请求和清理完成",
        "unresponsive" => "实例持有锁，但控制通道无响应；可能正在启动、清理或进程暂停",
        _ => "CableTidy daemon 未运行",
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
    async fn file_lock_survives_metadata_changes_and_releases_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_owned());
        let lock = InstanceLock::acquire(&paths).await.unwrap();
        assert!(locked(&paths).unwrap());
        assert!(InstanceLock::acquire(&paths).await.is_err());
        fs::write(&paths.runtime, b"{\"hostname\":\"changed\"}")
            .await
            .unwrap();
        assert!(locked(&paths).unwrap());
        drop(lock);
        assert!(!locked(&paths).unwrap());
        assert!(paths.lock.is_file());
        InstanceLock::acquire(&paths)
            .await
            .unwrap()
            .release()
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn legacy_lock_is_never_automatically_removed() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_owned());
        fs::create_dir(&paths.lock).await.unwrap();
        let error = InstanceLock::acquire(&paths).await.err().unwrap();
        assert!(error.to_string().contains("ELOCKLEGACY"));
        assert!(paths.lock.is_dir());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_executed_child_does_not_keep_the_lock_alive() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_owned());
        let lock = InstanceLock::acquire(&paths).await.unwrap();
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        drop(lock);
        let result = locked(&paths);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!result.unwrap());
    }

    #[test]
    fn inspecting_an_uninitialized_store_does_not_create_files() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().join("missing"));
        assert!(!locked(&paths).unwrap());
        assert!(!paths.home.exists());
    }
}
