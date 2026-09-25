use anyhow::{bail, Result};
use cabletidy::{config::Paths, lifecycle, server, targets};
use tokio::io::AsyncBufReadExt;

#[tokio::main(worker_threads = 2)]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
    // All daemon work has drained; Tokio's blocking stdin reader may still be waiting on the launcher.
    std::process::exit(0);
}
async fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("status");
    if ["--help", "-h", "help"].contains(&command) {
        println!("CableTidy CLI\n\nUsage: cabletidy <command>\n\nCommands:\n  start                       Start the daemon in the foreground\n  --help, -h                  Show this help\n  --version, -v               Print the installed version\n  status                      Show daemon status and management URL\n\nData: CABLETIDY_HOME or ~/.cabletidy\nNo command: show status");
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
        "status" => println!(
            "{}",
            serde_json::to_string_pretty(&lifecycle::status(&paths).await?)?
        ),
        "start" => {
            let options = targets::Options::new(paths.clone())?;
            let preferred = std::env::var("CABLETIDY_PREFERRED_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(43100);
            let app = server::create(paths, options, preferred).await?;
            if std::env::var_os("CABLETIDY_MANAGED_STDIN").is_some() {
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
                server::serve_controlled(app, receiver).await?;
            } else {
                server::serve(app).await?;
            }
        }
        _ => bail!("未知命令: {command}\nUsage: cabletidy <command>"),
    }
    Ok(())
}
