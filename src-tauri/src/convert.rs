use std::{
  fs,
  path::{Path, PathBuf},
};

use resvg::{tiny_skia, usvg};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use walkdir::WalkDir;
use std::sync::mpsc::Sender;

const MAX_PIXELS: u64 = 80_000_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
  pub input_mode: String, // "file" | "folder"
  pub input_path: String,
  pub output_dir: Option<String>,
  pub size_mode: String, // "scale" | "exact"
  pub scale: Option<f64>,
  pub width: Option<u32>,
  pub height: Option<u32>,
  pub crop: Option<bool>, // Exact mode only: center-crop (cover) instead of stretch
  pub background: Option<String>, // "#RRGGBB" (optional)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgSize {
  pub width: u32,
  pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSizeInfo {
  pub total: u32,
  pub all_same: bool,
  pub base_size: Option<SvgSize>,
  pub unique_sizes: Vec<SvgSize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertProgressEvent {
  pub phase: String,
  pub current: u32,
  pub active: Option<u32>,
  pub total: u32,
  pub ok: u32,
  pub failed: u32,
  pub last_svg: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertItemEvent {
  pub index: u32,
  pub total: u32,
  pub svg: String,
  pub png: String,
  pub out_width: Option<u32>,
  pub out_height: Option<u32>,
  pub ok: bool,
  pub engine: Option<String>,
  pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertSummary {
  pub total: u32,
  pub ok: u32,
  pub failed: u32,
}

fn is_svg(path: &Path) -> bool {
  path
    .extension()
    .and_then(|s| s.to_str())
    .map(|s| s.eq_ignore_ascii_case("svg"))
    .unwrap_or(false)
}

fn parse_bg_color(bg: &str) -> Option<tiny_skia::Color> {
  let s = bg.trim().trim_start_matches('#');
  if s.len() != 6 {
    return None;
  }
  let r = u8::from_str_radix(&s[0..2], 16).ok()?;
  let g = u8::from_str_radix(&s[2..4], 16).ok()?;
  let b = u8::from_str_radix(&s[4..6], 16).ok()?;
  Some(tiny_skia::Color::from_rgba8(r, g, b, 255))
}

fn enforce_pixel_cap(w: u32, h: u32) -> Result<(), String> {
  let pixels = (w as u64) * (h as u64);
  if pixels > MAX_PIXELS {
    let max_sq = (MAX_PIXELS as f64).sqrt().floor() as u32;
    let max_mp = (MAX_PIXELS as f64) / 1_000_000.0;
    return Err(format!(
      "Too large. Max is ~{}×{} ({:.0}MP).",
      max_sq, max_sq, max_mp
    ));
  }
  Ok(())
}

fn read_svg_size(svg_path: &Path) -> Result<SvgSize, String> {
  let data = fs::read(svg_path).map_err(|e| e.to_string())?;
  let opt = usvg::Options::default();
  let tree = usvg::Tree::from_data(&data, &opt).map_err(|e| e.to_string())?;
  let sz = tree.size();
  Ok(SvgSize {
    width: sz.width().ceil().max(1.0) as u32,
    height: sz.height().ceil().max(1.0) as u32,
  })
}

fn compute_output_size(req: &ConvertRequest, src: &SvgSize) -> Result<(u32, u32), String> {
  match req.size_mode.as_str() {
    "scale" => {
      let s = req.scale.unwrap_or(1.0);
      if !s.is_finite() || s <= 0.0 {
        return Err("Scale must be a positive number.".into());
      }
      let w = (src.width as f64 * s).round().max(1.0) as u32;
      let h = (src.height as f64 * s).round().max(1.0) as u32;
      Ok((w, h))
    }
    "exact" => {
      let w = req.width.ok_or_else(|| "Width is required in Exact mode.".to_string())?;
      let h = req.height.ok_or_else(|| "Height is required in Exact mode.".to_string())?;
      if w == 0 || h == 0 {
        return Err("Width/Height must be positive numbers.".into());
      }
      Ok((w, h))
    }
    _ => Err("Invalid size mode.".into()),
  }
}

fn make_output_path(svg_path: &Path, root: Option<&Path>, out_dir: Option<&Path>, out_w: u32, out_h: u32) -> PathBuf {
  let base = svg_path
    .file_stem()
    .and_then(|s| s.to_str())
    .unwrap_or("output")
    .to_string();
  let file_name = format!("{base}_{out_w}x{out_h}.png");

  let mut rel_prefix = String::new();
  if let Some(root) = root {
    if let Ok(rel) = svg_path.strip_prefix(root) {
      if let Some(parent) = rel.parent() {
        let p = parent.to_string_lossy();
        if !p.is_empty() && p != "." {
          rel_prefix = p.replace(['/', '\\'], "_");
        }
      }
    }
  }
  // When exporting multiple files to a single output directory (file mode),
  // prefix with the parent folder name to reduce collisions.
  if rel_prefix.is_empty() && root.is_none() && out_dir.is_some() {
    if let Some(parent_name) = svg_path
      .parent()
      .and_then(|p| p.file_name())
      .and_then(|s| s.to_str())
      .filter(|s| !s.is_empty())
    {
      rel_prefix = parent_name.to_string();
    }
  }

  let final_name = if rel_prefix.is_empty() {
    file_name
  } else {
    format!("{rel_prefix}_{file_name}")
  };

  if let Some(out_dir) = out_dir {
    out_dir.join(final_name)
  } else {
    svg_path.with_file_name(final_name)
  }
}

fn render_one_with_stage(
  svg_path: &Path,
  req: &ConvertRequest,
  root: Option<&Path>,
  out_dir: Option<&Path>,
  stage_tx: Sender<String>,
) -> Result<(PathBuf, u32, u32), String> {
  let _ = stage_tx.send("read".into());
  let data = fs::read(svg_path).map_err(|e| e.to_string())?;

  let _ = stage_tx.send("parse".into());
  let opt = usvg::Options::default();
  let tree = usvg::Tree::from_data(&data, &opt).map_err(|e| e.to_string())?;

  let src_sz = {
    let sz = tree.size();
    SvgSize {
      width: sz.width().ceil().max(1.0) as u32,
      height: sz.height().ceil().max(1.0) as u32,
    }
  };

  let (out_w, out_h) = compute_output_size(req, &src_sz)?;
  enforce_pixel_cap(out_w, out_h)?;

  let _ = stage_tx.send("render".into());
  let mut pixmap = tiny_skia::Pixmap::new(out_w, out_h)
    .ok_or_else(|| "Failed to allocate pixmap.".to_string())?;

  if let Some(bg) = req.background.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
    let c = parse_bg_color(bg).ok_or_else(|| "Invalid background color (expected #RRGGBB).".to_string())?;
    pixmap.fill(c);
  } else {
    pixmap.fill(tiny_skia::Color::from_rgba8(0, 0, 0, 0));
  }

  let size = tree.size();
  let src_w = size.width() as f32;
  let src_h = size.height() as f32;
  let out_w_f = out_w as f32;
  let out_h_f = out_h as f32;

  // Default behavior:
  // - Scale mode: scale to exact output size.
  // - Exact mode + crop=true: scale to cover and center-crop (no stretching).
  let transform = if req.size_mode == "exact" && req.crop.unwrap_or(false) {
    let scale = (out_w_f / src_w).max(out_h_f / src_h);
    // Translate so the scaled SVG is centered, cropping equally from both sides.
    let tx = (out_w_f - (src_w * scale)) * 0.5;
    let ty = (out_h_f - (src_h * scale)) * 0.5;
    // Note: translate is applied after scale in the matrix constructor.
    usvg::Transform::from_row(scale, 0.0, 0.0, scale, tx, ty)
  } else {
    let sx = out_w_f / src_w;
    let sy = out_h_f / src_h;
    usvg::Transform::from_scale(sx, sy)
  };
  let mut pm = pixmap.as_mut();
  resvg::render(&tree, transform, &mut pm);

  let _ = stage_tx.send("write".into());
  let out_path = make_output_path(svg_path, root, out_dir, out_w, out_h);
  if let Some(parent) = out_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let png = pixmap.encode_png().map_err(|e| e.to_string())?;
  fs::write(&out_path, png).map_err(|e| e.to_string())?;
  Ok((out_path, out_w, out_h))
}

#[tauri::command(rename_all = "camelCase")]
pub fn count_svg_files(dir_path: String) -> Result<u32, String> {
  let p = PathBuf::from(dir_path);
  if !p.is_dir() {
    return Err("Invalid folder path.".into());
  }
  let mut count = 0u32;
  for e in WalkDir::new(&p).into_iter().filter_map(Result::ok) {
    if e.file_type().is_file() && is_svg(e.path()) {
      count += 1;
    }
  }
  Ok(count)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_svg_size(svg_path: String) -> Result<SvgSize, String> {
  let p = PathBuf::from(svg_path);
  if !p.is_file() || !is_svg(&p) {
    return Err("Invalid SVG file path.".into());
  }
  read_svg_size(&p)
}

#[tauri::command(rename_all = "camelCase")]
pub fn scan_svg_folder_sizes(dir_path: String) -> Result<FolderSizeInfo, String> {
  let p = PathBuf::from(dir_path);
  if !p.is_dir() {
    return Err("Invalid folder path.".into());
  }

  let mut total = 0u32;
  let mut all_same = true;
  let mut base_size: Option<SvgSize> = None;

  // Keep only a few unique sizes for UI preview.
  let mut unique_sizes: Vec<SvgSize> = Vec::new();

  // Once a mismatch is detected, we stop parsing sizes to save time,
  // but keep counting total SVG files.
  let mut keep_parsing = true;

  for e in WalkDir::new(&p).into_iter().filter_map(Result::ok) {
    if !e.file_type().is_file() || !is_svg(e.path()) {
      continue;
    }
    total += 1;

    if !keep_parsing {
      continue;
    }

    let sz = read_svg_size(e.path())?;
    if base_size.is_none() {
      base_size = Some(sz.clone());
    } else if let Some(bs) = base_size.as_ref() {
      if sz.width != bs.width || sz.height != bs.height {
        all_same = false;
        // record the mismatching size for preview
        if unique_sizes.iter().all(|u| u.width != sz.width || u.height != sz.height) {
          unique_sizes.push(sz);
        }
        keep_parsing = false;
        continue;
      }
    }

    // collect unique sizes (up to 6)
    if unique_sizes.iter().all(|u| u.width != sz.width || u.height != sz.height) {
      unique_sizes.push(sz);
      if unique_sizes.len() >= 6 {
        // Enough for UI preview; if we already found >1 unique, we can stop parsing.
        if unique_sizes.len() > 1 {
          all_same = false;
          keep_parsing = false;
        }
      }
    }
  }

  // If all same and we have base_size, ensure unique_sizes contains it.
  if all_same {
    if let Some(bs) = base_size.as_ref() {
      if unique_sizes.is_empty() {
        unique_sizes.push(bs.clone());
      }
    }
  }

  Ok(FolderSizeInfo {
    total,
    all_same,
    base_size,
    unique_sizes,
  })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn convert_svg_to_png(
  window: tauri::Window,
  input_mode: String,
  input_path: String,
  input_paths: Option<Vec<String>>,
  output_dir: Option<String>,
  size_mode: String,
  scale: Option<f64>,
  width: Option<u32>,
  height: Option<u32>,
  crop: Option<bool>,
  background: Option<String>,
) -> Result<ConvertSummary, String> {
  let req = ConvertRequest {
    input_mode,
    input_path,
    output_dir,
    size_mode,
    scale,
    width,
    height,
    crop,
    background,
  };
  let input_path = PathBuf::from(&req.input_path);
  if req.input_mode == "folder" {
    if !input_path.is_dir() {
      return Err("Invalid folder path.".into());
    }
  }

  if let Some(bg) = req.background.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
    if parse_bg_color(bg).is_none() {
      return Err("Invalid background color (expected #RRGGBB).".into());
    }
  }

  let out_dir = req.output_dir.as_ref().map(PathBuf::from);

  let mut svgs: Vec<PathBuf> = Vec::new();
  if req.input_mode == "folder" {
    for e in WalkDir::new(&input_path).into_iter().filter_map(Result::ok) {
      if e.file_type().is_file() && is_svg(e.path()) {
        svgs.push(e.path().to_path_buf());
      }
    }
    svgs.sort();
  } else {
    let provided = input_paths.unwrap_or_default();
    if !provided.is_empty() {
      for p in provided {
        let pb = PathBuf::from(p);
        if !pb.is_file() || !is_svg(&pb) {
          return Err("Invalid SVG file path.".into());
        }
        svgs.push(pb);
      }
    } else {
      if !input_path.is_file() || !is_svg(&input_path) {
        return Err("Invalid SVG file path.".into());
      }
      svgs.push(input_path.clone());
    }
  }

  let total = svgs.len() as u32;
  let mut ok = 0u32;
  let mut failed = 0u32;

  let _ = window.emit(
    "convert-progress",
    ConvertProgressEvent {
      phase: "start".into(),
      current: 0,
      active: None,
      total,
      ok,
      failed,
      last_svg: None,
    },
  );

  for (i, svg) in svgs.iter().enumerate() {
    let index = (i as u32) + 1;
    let svg_str = svg.to_string_lossy().to_string();

    let req_cloned = req.clone();
    let svg_cloned = svg.clone();
    let root = if req.input_mode == "folder" { Some(input_path.clone()) } else { None };
    let out_dir_for_task = out_dir.clone();

    let (stage_tx, stage_rx) = std::sync::mpsc::channel::<String>();
    let win_for_stage = window.clone();
    let svg_for_stage = svg_str.clone();
    let stage_handle = tauri::async_runtime::spawn_blocking(move || {
      while let Ok(stage) = stage_rx.recv() {
        let _ = win_for_stage.emit(
          "convert-progress",
          ConvertProgressEvent {
            phase: stage,
            current: index,
            active: Some(index),
            total,
            ok: ok,       // last known from main loop; updated after item finishes
            failed: failed,
            last_svg: Some(svg_for_stage.clone()),
          },
        );
      }
    });

    let res = tauri::async_runtime::spawn_blocking(move || {
      render_one_with_stage(
        &svg_cloned,
        &req_cloned,
        root.as_ref().map(|p| p.as_path()),
        out_dir_for_task.as_ref().map(|p| p.as_path()),
        stage_tx,
      )
    })
    .await
    .map_err(|e| e.to_string())?;

    // Ensure stage emitter ends
    let _ = stage_handle.await;

    match res {
      Ok((png_path, out_w, out_h)) => {
        ok += 1;
        let _ = window.emit(
          "convert-item",
          ConvertItemEvent {
            index,
            total,
            svg: svg_str.clone(),
            png: png_path.to_string_lossy().to_string(),
            out_width: Some(out_w),
            out_height: Some(out_h),
            ok: true,
            engine: Some("resvg".into()),
            error: None,
          },
        );
      }
      Err(err) => {
        failed += 1;
        let _ = window.emit(
          "convert-item",
          ConvertItemEvent {
            index,
            total,
            svg: svg_str.clone(),
            png: "".into(),
            out_width: None,
            out_height: None,
            ok: false,
            engine: Some("resvg".into()),
            error: Some(err),
          },
        );
      }
    }

    let _ = window.emit(
      "convert-progress",
      ConvertProgressEvent {
        phase: "done".into(),
        current: index,
        active: None,
        total,
        ok,
        failed,
        last_svg: Some(svg_str.clone()),
      },
    );
  }

  Ok(ConvertSummary { total, ok, failed })
}


