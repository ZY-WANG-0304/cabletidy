use cabletidy::{
    config::Paths,
    server::{self, Shutdown},
    targets,
};
use tokio::io::AsyncBufReadExt;

#[tokio::main(worker_threads = 2)]
async fn main() {
    let result = async {
        let paths = Paths::from_env()?;
        let options = targets::Options::new(paths.clone())?;
        let preferred = std::env::var("CABLETIDY_PREFERRED_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(43100);
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
