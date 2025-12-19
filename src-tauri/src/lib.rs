mod convert;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if let Some(win) = app.get_webview_window("main") {
        // Force a consistent startup window size (avoid macOS restore geometry surprises).
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::<f64> {
          width: 1240.0,
          height: 850.0,
        }));
        let _ = win.set_resizable(false);
        let _ = win.center();

        // Best-effort: apply a vibrancy style on macOS so the desktop can show through.
        // Note: Some variants are deprecated upstream, but still work on current Tauri.
        let _ = win.set_effects(Some(
          tauri::window::EffectsBuilder::new()
            .effect(tauri::window::Effect::UnderWindowBackground)
            .state(tauri::window::EffectState::Active)
            .radius(22.0)
            .build(),
        ));

        let _ = win.show();
        let _ = win.set_focus();
      }

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      convert::get_svg_size,
      convert::count_svg_files,
      convert::scan_svg_folder_sizes,
      convert::convert_svg_to_png
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}


