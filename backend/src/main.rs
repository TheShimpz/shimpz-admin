//! `shimpz-admin`: serve the Local Admin, or run one of its bounded commands.

fn main() -> std::process::ExitCode {
    admin_backend::process::command::install_panic_hook();
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    admin_backend::process::command::run(&arguments)
}
