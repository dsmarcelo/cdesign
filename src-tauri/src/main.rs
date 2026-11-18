#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    ffi::OsStr,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicU16, Ordering},
        Arc,
    },
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    webview::NewWindowResponse,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn viewer_url(app: &AppHandle, folder: Option<&Path>) -> Result<Url, String> {
    // Tauri installs external binaries next to the application executable.
    let bun = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name(if cfg!(windows) {
            "cdesign-bun.exe"
        } else {
            "cdesign-bun"
        });
    let cli = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("runtime/src/cli.ts");
    let mut command = Command::new(&bun);
    command.arg(cli).arg("desktop-url");
    command.args(folder.map(Path::as_os_str));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .map_err(|e| format!("Could not run {}: {e}", bun.display()))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let url = Url::parse(String::from_utf8_lossy(&output.stdout).trim())
        .map_err(|e| format!("Invalid viewer address: {e}"))?;
    if !url
        .port_or_known_default()
        .is_some_and(|port| is_viewer(&url, port))
    {
        return Err("cdesign returned an address outside the local viewer.".into());
    }
    Ok(url)
}

fn is_viewer(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.port_or_known_default() == Some(port)
        && url
            .host_str()
            .is_some_and(|host| host == "localhost" || host.ends_with(".localhost"))
}

fn show_error(app: &AppHandle, error: String, exit: bool) {
    let handle = app.clone();
    app.dialog()
        .message(error)
        .title("cdesign")
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .show(move |_| {
            if exit {
                handle.exit(1);
            }
        });
}

fn open_viewer(app: &AppHandle) -> tauri::Result<()> {
    let folder = std::env::args_os()
        .nth(1)
        .filter(|arg| arg != OsStr::new("--"));
    let url = match viewer_url(app, folder.as_deref().map(Path::new)) {
        Ok(url) => url,
        Err(error) => {
            show_error(app, error, true);
            return Ok(());
        }
    };
    let port = Arc::new(AtomicU16::new(url.port_or_known_default().unwrap()));
    let nav_port = port.clone();

    let open = MenuItemBuilder::with_id("open", "Open Folder…")
        .accelerator("Ctrl+O")
        .build(app)?;
    let home = MenuItemBuilder::with_id("home", "Project Picker").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .items(&[&open, &home, &quit])
        .build()?;
    let menu = MenuBuilder::new(app).item(&file_menu).build()?;
    let opener = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("cdesign")
        .inner_size(1280.0, 850.0)
        .menu(menu)
        .on_navigation(move |url| is_viewer(url, nav_port.load(Ordering::Relaxed)))
        .on_new_window(move |url, _| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .on_menu_event(move |window, event| {
            let app = window.app_handle().clone();
            let port = port.clone();
            let Some(target) = app.get_webview_window("main") else {
                return;
            };
            let navigate = move |folder: Option<std::path::PathBuf>| {
                // A folder selection can scaffold a project and start a fresh daemon.
                tauri::async_runtime::spawn_blocking(move || {
                    match viewer_url(&app, folder.as_deref()) {
                        Ok(url) => {
                            port.store(url.port_or_known_default().unwrap(), Ordering::Relaxed);
                            if let Err(error) = target.navigate(url) {
                                show_error(&app, error.to_string(), false);
                            }
                        }
                        Err(error) => show_error(&app, error, false),
                    }
                });
            };
            match event.id().as_ref() {
                "open" => window
                    .app_handle()
                    .dialog()
                    .file()
                    .pick_folder(move |path| {
                        if let Some(path) = path.and_then(|path| path.into_path().ok()) {
                            navigate(Some(path));
                        }
                    }),
                "home" => navigate(None),
                "quit" => window.app_handle().exit(0),
                _ => {}
            }
        })
        .build()?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| Ok(open_viewer(app.handle())?))
        .run(tauri::generate_context!())
        .expect("could not start cdesign desktop");
}
