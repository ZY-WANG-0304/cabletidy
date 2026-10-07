use crate::config::{text, Paths};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, watch},
    task::{JoinHandle, JoinSet},
};

pub const TIMEOUT: Duration = Duration::from_secs(2);
const VERSION: u64 = 1;
const MAX_FRAME: usize = 4096;

pub trait Connection: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Connection for T {}
pub type Stream = Box<dyn Connection>;

pub async fn read(stream: &mut Stream) -> Result<Value> {
    let length = stream.read_u32().await? as usize;
    if length > MAX_FRAME {
        bail!("Control message exceeds {MAX_FRAME} bytes");
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub async fn write(stream: &mut Stream, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    stream.write_u32(bytes.len() as u32).await?;
    stream.write_all(&bytes).await?;
    stream.flush().await?;
    Ok(())
}

fn address(paths: &Paths, id: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(id).context("Invalid daemon controlId")?;
    let home = std::fs::canonicalize(&paths.home)?;
    let hash = format!("{:x}", Sha256::digest(home.as_os_str().as_encoded_bytes()));
    #[cfg(unix)]
    {
        // Keep socket paths below macOS's sockaddr_un limit, even for long data paths.
        let uid = unsafe { libc::geteuid() };
        Ok(
            PathBuf::from(format!("/tmp/cabletidy-{uid}-{}", &hash[..24]))
                .join(format!("{id}.sock")),
        )
    }
    #[cfg(windows)]
    {
        Ok(PathBuf::from(format!(
            r"\\.\pipe\cabletidy-{}-{id}",
            &hash[..24]
        )))
    }
}

pub struct Listener {
    address: PathBuf,
    #[cfg(unix)]
    inner: tokio::net::UnixListener,
    #[cfg(windows)]
    inner: tokio::net::windows::named_pipe::NamedPipeServer,
}

impl Listener {
    pub fn bind(paths: &Paths, id: &str) -> Result<Self> {
        let address = address(paths, id)?;
        #[cfg(unix)]
        let inner = {
            use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
            let parent = address.parent().unwrap();
            match std::fs::DirBuilder::new().mode(0o700).create(parent) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            let metadata = std::fs::symlink_metadata(parent)?;
            if !metadata.is_dir()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.permissions().mode() & 0o777 != 0o700
            {
                bail!(
                    "Control directory must belong to the current user with mode 0700: {}",
                    parent.display()
                );
            }
            // The caller holds the store lock; only previous generations can be here.
            for entry in std::fs::read_dir(parent)? {
                let entry = entry?;
                if entry.file_type()?.is_socket()
                    && entry
                        .path()
                        .file_stem()
                        .and_then(|v| v.to_str())
                        .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
                {
                    std::fs::remove_file(entry.path())?;
                }
            }
            tokio::net::UnixListener::bind(&address)?
        };
        #[cfg(windows)]
        let inner = windows_pipe(&address, true)?;
        Ok(Self { address, inner })
    }

    async fn accept(&mut self) -> Result<Stream> {
        #[cfg(unix)]
        {
            Ok(Box::new(self.inner.accept().await?.0))
        }
        #[cfg(windows)]
        {
            self.inner.connect().await?;
            let next = windows_pipe(&self.address, false)?;
            Ok(Box::new(std::mem::replace(&mut self.inner, next)))
        }
    }

    pub fn serve(mut self, id: String, shutdown: mpsc::UnboundedSender<()>) -> Server {
        let (state, mut changed) = watch::channel("running");
        let updates = state.clone();
        let task = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    result = changed.changed() => {
                        if result.is_err() || *changed.borrow() == "stopped" { break; }
                    }
                    Some(_) = clients.join_next(), if !clients.is_empty() => {}
                    incoming = self.accept(), if clients.len() < 32 => {
                        match incoming {
                            Ok(stream) => {
                                clients.spawn(handle(stream, id.clone(), updates.subscribe(), shutdown.clone()));
                            }
                            Err(error) => {
                                crate::daemon_log::message(format_args!("Control listener failed: {error:#}"));
                                let _ = shutdown.send(());
                                break;
                            }
                        }
                    }
                }
            }
            // Give accepted stop clients time to receive the completion acknowledgement.
            let _ = tokio::time::timeout(TIMEOUT, async {
                while clients.join_next().await.is_some() {}
            })
            .await;
        });
        Server { state, task }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.address);
    }
}

pub struct Server {
    pub state: watch::Sender<&'static str>,
    task: JoinHandle<()>,
}
impl Server {
    pub async fn finish(&mut self) {
        self.state.send_replace("stopped");
        let _ = (&mut self.task).await;
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handle(
    mut stream: Stream,
    id: String,
    mut state: watch::Receiver<&'static str>,
    shutdown: mpsc::UnboundedSender<()>,
) -> Result<()> {
    let hello = json!({"version":VERSION,"controlId":id,"state":*state.borrow()});
    tokio::time::timeout(TIMEOUT, write(&mut stream, &hello)).await??;
    let request = tokio::time::timeout(TIMEOUT, read(&mut stream)).await??;
    if request["version"] != VERSION || request["controlId"] != id {
        bail!("Control protocol or instance mismatch");
    }
    match text(&request["command"]) {
        "status" => {
            let reply = json!({"state":*state.borrow()});
            tokio::time::timeout(TIMEOUT, write(&mut stream, &reply)).await??;
        }
        "stop" => {
            shutdown
                .send(())
                .context("Daemon is no longer accepting control requests")?;
            tokio::time::timeout(TIMEOUT, write(&mut stream, &json!({"state":"stopping"})))
                .await??;
            while *state.borrow_and_update() != "stopped" {
                // Shutdown is already committed; release the slot when its waiter leaves.
                tokio::select! {
                    result = state.changed() => result?,
                    _ = stream.read_u8() => return Ok(()),
                }
            }
            tokio::time::timeout(TIMEOUT, write(&mut stream, &json!({"state":"stopped"})))
                .await??;
        }
        _ => bail!("Unknown control command"),
    }
    // Keep the pipe alive until the peer consumes the reply and closes. Tokio's
    // Windows pipe flush is a no-op; closing immediately can lose buffered replies.
    let _ = tokio::time::timeout(TIMEOUT, stream.read_u8()).await;
    Ok(())
}

pub async fn connect(paths: &Paths, runtime: &Value) -> Result<Stream> {
    if runtime["controlVersion"] != VERSION {
        bail!("Unsupported daemon control protocol; stop the old daemon manually before upgrading");
    }
    let id = text(&runtime["controlId"]);
    let address = address(paths, id)?;
    let mut stream: Stream;
    #[cfg(unix)]
    {
        stream = Box::new(tokio::net::UnixStream::connect(address).await?);
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        loop {
            match ClientOptions::new().open(&address) {
                Ok(pipe) => {
                    stream = Box::new(pipe);
                    break;
                }
                Err(e) if e.raw_os_error() == Some(231) => {
                    tokio::time::sleep(Duration::from_millis(20)).await
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
    let hello = read(&mut stream).await?;
    if hello["version"] != VERSION || hello["controlId"] != id {
        bail!("Daemon control handshake does not match the expected instance");
    }
    Ok(stream)
}

pub fn request(runtime: &Value, command: &str) -> Value {
    json!({"version":VERSION,"controlId":runtime["controlId"],"command":command})
}

#[cfg(windows)]
fn windows_pipe(
    address: &std::path::Path,
    first: bool,
) -> Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use std::{
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    // Explicit user SID: the default named-pipe DACL can also grant access to other users.
    unsafe {
        let mut raw = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let token = OwnedHandle::from_raw_handle(raw);
        let mut size = 0;
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut size,
        );
        let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut length = 0;
        while *sid.add(length) != 0 {
            length += 1;
        }
        let sid_text = String::from_utf16_lossy(std::slice::from_raw_parts(sid, length));
        LocalFree(sid.cast());
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid_text})")
            .encode_utf16()
            .chain([0])
            .collect();
        let mut descriptor = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let result = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                address,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            );
        LocalFree(descriptor);
        Ok(result?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> (
        tempfile::TempDir,
        Paths,
        Value,
        Server,
        mpsc::UnboundedReceiver<()>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let paths = Paths::new(directory.path().to_owned());
        let id = uuid::Uuid::new_v4().to_string();
        let runtime = json!({"controlVersion":1,"controlId":id});
        let listener = Listener::bind(&paths, &id).unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let server = listener.serve(id, tx);
        (directory, paths, runtime, server, rx)
    }

    #[tokio::test]
    async fn rejects_wrong_instances_versions_and_oversized_frames() {
        let (_dir, paths, runtime, mut server, mut shutdown) = fixture().await;
        for invalid in [
            json!({"version":1,"controlId":"other","command":"stop"}),
            json!({"version":99,"controlId":runtime["controlId"],"command":"stop"}),
        ] {
            let mut stream = connect(&paths, &runtime).await.unwrap();
            write(&mut stream, &invalid).await.unwrap();
            assert!(tokio::time::timeout(TIMEOUT, read(&mut stream))
                .await
                .unwrap()
                .is_err());
        }
        let mut stream = connect(&paths, &runtime).await.unwrap();
        stream.write_u32(MAX_FRAME as u32 + 1).await.unwrap();
        assert!(tokio::time::timeout(TIMEOUT, read(&mut stream))
            .await
            .unwrap()
            .is_err());
        assert!(shutdown.try_recv().is_err());
        let mut status = connect(&paths, &runtime).await.unwrap();
        write(&mut status, &request(&runtime, "status"))
            .await
            .unwrap();
        assert_eq!(read(&mut status).await.unwrap()["state"], "running");
        drop(status);
        server.finish().await;
    }

    #[tokio::test]
    async fn disconnected_stop_clients_release_slots_without_cancelling_shutdown() {
        let (_dir, paths, runtime, mut server, mut shutdown) = fixture().await;
        // Exceed the listener's capacity while keeping shutdown pending throughout.
        for attempt in 0..64 {
            tokio::time::timeout(TIMEOUT, async {
                let mut client = connect(&paths, &runtime).await.unwrap();
                write(&mut client, &request(&runtime, "stop"))
                    .await
                    .unwrap();
                shutdown.recv().await.unwrap();
                assert_eq!(read(&mut client).await.unwrap()["state"], "stopping");
                server.state.send_replace("draining");
            })
            .await
            .unwrap_or_else(|_| {
                panic!("disconnected clients exhausted slots at attempt {attempt}")
            });
        }
        let mut second = connect(&paths, &runtime).await.unwrap();
        write(&mut second, &request(&runtime, "stop"))
            .await
            .unwrap();
        assert_eq!(read(&mut second).await.unwrap()["state"], "stopping");
        let mut status = connect(&paths, &runtime).await.unwrap();
        write(&mut status, &request(&runtime, "status"))
            .await
            .unwrap();
        assert_eq!(read(&mut status).await.unwrap()["state"], "draining");
        drop(status);
        let (_, reply) = tokio::join!(server.finish(), async {
            let reply = read(&mut second).await.unwrap();
            drop(second);
            reply
        });
        assert_eq!(reply["state"], "stopped");
    }

    #[tokio::test]
    async fn disconnect_before_request_never_stops_daemon() {
        let (_dir, paths, runtime, mut server, mut shutdown) = fixture().await;
        drop(connect(&paths, &runtime).await.unwrap());
        let mut status = connect(&paths, &runtime).await.unwrap();
        write(&mut status, &request(&runtime, "status"))
            .await
            .unwrap();
        assert_eq!(read(&mut status).await.unwrap()["state"], "running");
        assert!(shutdown.try_recv().is_err());
        drop(status);
        server.finish().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn socket_directory_is_private_and_paths_fit_even_for_long_homes() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let paths = Paths::new(directory.path().join("long-home-".repeat(20)));
        std::fs::create_dir(&paths.home).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let listener = Listener::bind(&paths, &id).unwrap();
        assert!(listener.address.as_os_str().len() < 104);
        let parent = listener.address.parent().unwrap().to_owned();
        let metadata = std::fs::symlink_metadata(&parent).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
        assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
        drop(listener);
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Listener::bind(&paths, &id).is_err());
        std::fs::remove_dir(&parent).unwrap();
    }
}
