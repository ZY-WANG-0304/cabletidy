use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const BACKUPS: usize = 3;
static LOG: OnceLock<Mutex<RotatingLog>> = OnceLock::new();

struct RotatingLog {
    path: PathBuf,
    limit: u64,
}

impl RotatingLog {
    fn file(&self, index: usize) -> PathBuf {
        if index == 0 {
            self.path.clone()
        } else {
            self.path.with_file_name(format!("daemon.log.{index}"))
        }
    }

    fn open(path: PathBuf, limit: u64) -> io::Result<Self> {
        let log = Self { path, limit };
        // Bound files left by older versions too, retaining their most recent bytes.
        for index in 0..=BACKUPS {
            let path = log.file(index);
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(index == 0);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = match options.open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let size = file.metadata()?.len();
            if size > limit {
                file.seek(SeekFrom::Start(size - limit))?;
                let mut tail = Vec::with_capacity(limit as usize);
                file.read_to_end(&mut tail)?;
                file.seek(SeekFrom::Start(0))?;
                file.write_all(&tail)?;
                file.set_len(limit)?;
            }
        }
        Ok(log)
    }

    fn rotate(&self) -> io::Result<()> {
        match fs::remove_file(self.file(BACKUPS)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        for index in (0..BACKUPS).rev() {
            match fs::rename(self.file(index), self.file(index + 1)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn append(&mut self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&self.path)?;
            let size = file.metadata()?.len();
            if size >= self.limit
                || (size > 0
                    && bytes.len() as u64 <= self.limit
                    && size + bytes.len() as u64 > self.limit)
            {
                drop(file);
                self.rotate()?;
                continue;
            }
            let mut count = bytes.len().min((self.limit - size) as usize);
            // Keep UTF-8 characters intact even when a single record exceeds the file limit.
            while count > 0 && count < bytes.len() && bytes[count] & 0xc0 == 0x80 {
                count -= 1;
            }
            if count == 0 {
                drop(file);
                self.rotate()?;
                continue;
            }
            file.write_all(&bytes[..count])?;
            bytes = &bytes[count..];
        }
        Ok(())
    }
}

// Initialize only after acquiring the instance lock, so competing starts cannot rotate live logs.
pub fn init(home: &Path) -> io::Result<()> {
    if std::env::var_os("CABLETIDY_BACKGROUND_LOG").is_none() {
        return Ok(());
    }
    let log = RotatingLog::open(home.join("daemon.log"), MAX_BYTES)?;
    LOG.set(Mutex::new(log))
        .map_err(|_| io::Error::other("daemon logger already initialized"))?;
    std::panic::set_hook(Box::new(|info| error(format_args!("{info}"))));
    Ok(())
}

fn record(message: fmt::Arguments<'_>) -> bool {
    let Some(log) = LOG.get() else { return false };
    let mut log = log.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Err(error) = log.append(format!("{message}\n").as_bytes()) {
        let _ = writeln!(io::stderr(), "Cannot write daemon log: {error}");
    }
    true
}

pub fn message(message: fmt::Arguments<'_>) {
    if !record(message) {
        println!("{message}");
    }
}

pub fn error(message: fmt::Arguments<'_>) {
    record(message);
    // The launching CLI captures startup errors until readiness, then closes this pipe.
    let _ = writeln!(io::stderr(), "{message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_writer_rotates_and_bounds_large_writes() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = RotatingLog::open(dir.path().join("daemon.log"), 16).unwrap();
        for byte in b'a'..=b'f' {
            log.append(&[byte; 16]).unwrap();
        }
        for (index, byte) in b"fedc".iter().copied().enumerate() {
            assert_eq!(fs::read(log.file(index)).unwrap(), vec![byte; 16]);
        }
        log.append(&[b'z'; 200]).unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 4);
        for index in 0..=BACKUPS {
            assert!(fs::metadata(log.file(index)).unwrap().len() <= 16);
        }
    }

    #[test]
    fn rotation_preserves_utf8_and_keeps_normal_records_together() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = RotatingLog::open(dir.path().join("daemon.log"), 16).unwrap();
        log.append(b"previous line\n").unwrap();
        log.append("\u{65e5}\u{5fd7}\n".as_bytes()).unwrap();
        assert_eq!(fs::read(log.file(1)).unwrap(), b"previous line\n");
        log.append("\u{65e5}".repeat(30).as_bytes()).unwrap();
        for index in 0..=BACKUPS {
            let content = fs::read_to_string(log.file(index)).unwrap();
            assert!(content.len() <= 16);
        }
    }

    #[test]
    fn restart_preserves_logs_and_bounds_legacy_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        let mut log = RotatingLog::open(path.clone(), 16).unwrap();
        log.append(b"first\n").unwrap();
        drop(log);
        let mut log = RotatingLog::open(path.clone(), 16).unwrap();
        log.append(b"second\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first\nsecond\n");
        for index in 0..=BACKUPS {
            fs::write(log.file(index), b"old bytes discarded;keep recent tail").unwrap();
        }
        drop(log);
        let log = RotatingLog::open(path, 16).unwrap();
        for index in 0..=BACKUPS {
            assert_eq!(fs::read(log.file(index)).unwrap(), b"keep recent tail");
        }
    }
}
