use std::{future::Future, io, time::Duration};

fn is_sharing_error(error: &io::Error) -> bool {
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(32 | 33)) {
        return true;
    }
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::WouldBlock | io::ErrorKind::ResourceBusy
    )
}

// Windows scanners and editors can briefly hold a file across an atomic replace.
pub async fn retry_sharing<T, F, Fut>(mut operation: F) -> io::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = io::Result<T>>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        match operation().await {
            Err(error) if is_sharing_error(&error) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[tokio::test]
    async fn win32_sharing_and_lock_violations_retry_but_other_codes_do_not() {
        for code in [32, 33] {
            let mut attempts = 0;
            retry_sharing(|| {
                attempts += 1;
                std::future::ready(if attempts == 1 {
                    Err(io::Error::from_raw_os_error(code))
                } else {
                    Ok(())
                })
            })
            .await
            .unwrap();
            assert_eq!(attempts, 2);
        }
        for code in [2, 3, 87] {
            let mut attempts = 0;
            let error = retry_sharing(|| {
                attempts += 1;
                std::future::ready(Err::<(), _>(io::Error::from_raw_os_error(code)))
            })
            .await
            .unwrap_err();
            assert_eq!(error.raw_os_error(), Some(code));
            assert_eq!(attempts, 1);
        }
    }

    #[tokio::test]
    async fn sharing_failures_retry_but_other_failures_return_immediately() {
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::WouldBlock,
            io::ErrorKind::ResourceBusy,
        ] {
            let mut attempts = 0;
            let value = retry_sharing(|| {
                attempts += 1;
                std::future::ready(if attempts == 1 {
                    Err(io::Error::from(kind))
                } else {
                    Ok(42)
                })
            })
            .await
            .unwrap();
            assert_eq!(value, 42);
            assert_eq!(attempts, 2);
        }
        let mut attempts = 0;
        let error = retry_sharing(|| {
            attempts += 1;
            std::future::ready(Err::<(), _>(io::Error::from(io::ErrorKind::InvalidInput)))
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(attempts, 1);
    }

    #[tokio::test]
    async fn persistent_denials_have_a_deadline_and_preserve_the_error() {
        let started = tokio::time::Instant::now();
        let error = retry_sharing(|| {
            std::future::ready(Err::<(), _>(io::Error::from(
                io::ErrorKind::PermissionDenied,
            )))
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(started.elapsed() >= Duration::from_secs(1));
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
