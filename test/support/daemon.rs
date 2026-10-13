use cabletidy::{
    config::Paths,
    server::{self, Shutdown},
    targets,
};
use tokio::io::AsyncBufReadExt;

fn main() {
    if let Err(error) = cabletidy::temporary::initialize() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
    if std::env::args().nth(1).as_deref() == Some("--sqlite-temp-probe") {
        if let Err(error) = sqlite_temp_probe() {
            eprintln!("{error:#}");
            std::process::exit(1);
        }
        return;
    }
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(run());
}

// Observe real temporary-file opens in a fresh process, before starting threads.
// The test binary uses the same bootstrap and bundled SQLite as the daemon.
type VfsOpen = unsafe extern "C" fn(
    *mut rusqlite::ffi::sqlite3_vfs,
    *const std::ffi::c_char,
    *mut rusqlite::ffi::sqlite3_file,
    i32,
    *mut i32,
) -> i32;
static VFS_OPEN: std::sync::OnceLock<VfsOpen> = std::sync::OnceLock::new();
static TEMPORARY_FILES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static TEMPORARY_FILENAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();

unsafe extern "C" fn observe_open(
    vfs: *mut rusqlite::ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    file: *mut rusqlite::ffi::sqlite3_file,
    flags: i32,
    out_flags: *mut i32,
) -> i32 {
    let result = VFS_OPEN.get().unwrap()(vfs, name, file, flags, out_flags);
    if result == rusqlite::ffi::SQLITE_OK && flags & rusqlite::ffi::SQLITE_OPEN_DELETEONCLOSE != 0 {
        TEMPORARY_FILES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if TEMPORARY_FILENAME.get().is_none() {
            let mut generated: *mut std::ffi::c_char = std::ptr::null_mut();
            let control = (*(*file).pMethods).xFileControl.unwrap();
            let status = control(
                file,
                rusqlite::ffi::SQLITE_FCNTL_TEMPFILENAME,
                (&mut generated as *mut *mut std::ffi::c_char).cast(),
            );
            if !generated.is_null() {
                if status == rusqlite::ffi::SQLITE_OK {
                    let _ = TEMPORARY_FILENAME.set(
                        std::ffi::CStr::from_ptr(generated)
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
                rusqlite::ffi::sqlite3_free(generated.cast());
            }
        }
    }
    result
}

fn sqlite_temp_probe() -> anyhow::Result<()> {
    let connection = rusqlite::Connection::open_in_memory()?;
    // Keep the default TEMP_STORE=1 behavior; the 50 MiB sort exceeds SQLite's
    // in-memory sorter threshold and must open a temporary file.
    let vfs = unsafe { rusqlite::ffi::sqlite3_vfs_find(std::ptr::null()) };
    anyhow::ensure!(!vfs.is_null(), "SQLite VFS unavailable");
    let original = unsafe { (*vfs).xOpen }.expect("SQLite VFS xOpen");
    VFS_OPEN.set(original).unwrap();
    unsafe { (*vfs).xOpen = Some(observe_open) };
    let count = connection.query_row(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000)
         SELECT count(*) FROM (SELECT x FROM n ORDER BY randomblob(1024))",
        [],
        |row| row.get::<_, i64>(0),
    );
    unsafe { (*vfs).xOpen = Some(original) };
    println!(
        "{}",
        serde_json::json!({
            "count":count?,
            "temporaryFiles":TEMPORARY_FILES.load(std::sync::atomic::Ordering::Relaxed),
            "generatedTemporaryFilename":TEMPORARY_FILENAME.get(),
            "maxPathname":unsafe { (*vfs).mxPathname },
        })
    );
    Ok(())
}

async fn run() {
    let result = async {
        let paths = Paths::from_env()?;
        let options = targets::Options::new(paths.clone())?;
        let preferred = std::env::var("CABLETIDY_PREFERRED_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let app = server::create(paths, options, preferred).await?;
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let signal = if line == "SIGINT" {
                    Shutdown::Interrupt
                } else {
                    Shutdown::Terminate
                };
                let _ = sender.send(signal);
            }
            let _ = sender.send(Shutdown::Terminate);
        });
        server::serve_controlled(app, receiver).await
    }
    .await;
    if let Err(error) = result {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
