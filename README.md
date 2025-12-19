## Tool SVG-To-PNG

A lightweight offline desktop tool to convert **SVG** files to **PNG** locally (built with **Tauri + React**).
No uploads — your files never leave your computer.

### Features
- **File mode**: convert one or multiple `.svg` files
- **Folder mode**: batch convert all SVGs in a folder
- **Resize**
  - **Scale** (e.g. 1x / 2x / 3x / 4x)
  - **Exact size** (set width × height)
- **Optional background color** (leave empty for transparent PNG)
- **Progress + results list**

### Download (macOS)
**Direct download:** go to [Releases (latest)](https://github.com/TaoisPrisetK/Svg-To-Png/releases/latest) and download the latest `.dmg`.

If you prefer a specific version, open the [Releases page](https://github.com/TaoisPrisetK/Svg-To-Png/releases) and pick a tag.

### Development
```bash
npm install
npm run tauri:dev
```

### Build (Release)
```bash
npm install
npm run tauri:build
```

### Notes
- This tool runs fully offline.
- The app icon is generated from an SVG and matches the UI background theme.

### License
MIT

