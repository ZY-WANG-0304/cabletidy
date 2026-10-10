use anyhow::{bail, Result};
use cabletidy::{config::Paths, lifecycle, server, targets};
use tokio::io::AsyncBufReadExt;

#[tokio::main(worker_threads = 2)]
async fn main() {
    if let Err(error) = run().await {
        cabletidy::daemon_log::error(format_args!("{error:#}"));
        std::process::exit(1);
    }
    // All daemon work has drained; Tokio's blocking stdin reader may still be waiting on the launcher.
    std::process::exit(0);
}
async fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("status");
    if ["--help", "-h", "help"].contains(&command) {
        println!("CableTidy CLI\n\nUsage: cabletidy <command>\n\nCommands:\n  start [--foreground]        Start daemon (npm: background; native: foreground)\n  restart [--foreground]      Stop gracefully, then start (also starts if offline)\n  stop                        Stop a running daemon\n  --help, -h                  Show this help\n  --version, -v               Print the installed version\n  status                      Show daemon status and management URL\n\nData: CABLETIDY_HOME or ~/.cabletidy\nNative start/restart run in the foreground without options\nNo command: show status");
        return Ok(());
    }
    if ["--version", "-v"].contains(&command) {
        println!("{}", cabletidy::VERSION);
        return Ok(());
    }
    if args.len() > 1 {
        bail!("用法: cabletidy {command}");
    }
    let paths = Paths::from_env()?;
    match command {
        "stop" => std::process::exit(lifecycle::stop(&paths, stop_cancellation(true)?).await?),
        "status" => println!(
            "{}",
            serde_json::to_string_pretty(&lifecycle::status(&paths).await?)?
        ),
        "start" | "restart" => {
            let mut managed = managed_shutdown();
            if command == "restart" {
                let cancellation = stop_cancellation(false)?;
                let code = lifecycle::stop(&paths, async {
                    tokio::select! {
                        code = cancellation => code,
                        event = async {
                            match managed.as_mut() {
                                Some(receiver) => receiver.recv().await,
                                None => std::future::pending().await,
                            }
                        } => match event {
                            Some(server::Shutdown::Terminate) => 143,
                            _ => 130,
                        },
                    }
                })
                .await?;
                if code != 0 {
                    std::process::exit(code);
                }
            }
            let options = targets::Options::new(paths.clone())?;
            let preferred = std::env::var("CABLETIDY_PREFERRED_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(43100);
            let app = server::create(paths, options, preferred).await?;
            if let Some(receiver) = managed {
                server::serve_controlled(app, receiver).await?;
            } else {
                server::serve(app).await?;
            }
        }
        _ => bail!("未知命令: {command}\nUsage: cabletidy <command>"),
    }
    Ok(())
}

fn managed_shutdown() -> Option<tokio::sync::mpsc::UnboundedReceiver<server::Shutdown>> {
    std::env::var_os("CABLETIDY_MANAGED_STDIN")?;
    // One reader spans both restart phases so a cancelled stop cannot consume future signals.
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let event = match line.as_str() {
                "SIGINT" => server::Shutdown::Interrupt,
                "SIGTERM" => server::Shutdown::Terminate,
                _ => continue,
            };
            if sender.send(event).is_err() {
                return;
            }
        }
        let _ = sender.send(server::Shutdown::ParentGone);
    });
    Some(receiver)
}

fn stop_cancellation(read_managed_stdin: bool) -> Result<impl std::future::Future<Output = i32>> {
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let managed = read_managed_stdin && std::env::var_os("CABLETIDY_MANAGED_STDIN").is_some();
    Ok(async move {
        let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        loop {
            tokio::select! {
                signal = lines.next_line(), if managed => match signal {
                    Ok(Some(line)) if line == "SIGINT" => return 130,
                    Ok(Some(line)) if line == "SIGTERM" => return 143,
                    Ok(Some(_)) => continue,
                    _ => return 130,
                },
                _ = async {
                    if tokio::signal::ctrl_c().await.is_err() {
                        std::future::pending::<()>().await;
                    }
                } => return 130,
                _ = async {
                    #[cfg(unix)]
                    term.recv().await;
                    #[cfg(not(unix))]
                    std::future::pending::<()>().await;
                } => return 143,
            }
        }
    })
}
