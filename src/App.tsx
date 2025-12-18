import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { Link2, Link2Off, Play, Settings2, Wand2, XCircle } from 'lucide-react'
import { motion } from 'framer-motion'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import AppIcon from '@/assets/AppIcon.svg'
import { HoverFolderIcon } from '@/components/icons/HoverFolderIcon'
import { HoverImageMoonIcon } from '@/components/icons/HoverImageMoonIcon'

type InputMode = 'file' | 'folder'
type SizeMode = 'scale' | 'exact'

type SvgSize = { width: number; height: number }
type FolderSizeInfo = {
  total: number
  allSame: boolean
  baseSize?: SvgSize | null
  uniqueSizes: SvgSize[]
}

type ConvertProgressEvent = {
  phase: string
  current: number
  active?: number | null
  total: number
  ok: number
  failed: number
  last_svg?: string | null
}

type ConvertItemEvent = {
  index: number
  total: number
  svg: string
  png: string
  out_width?: number | null
  out_height?: number | null
  ok: boolean
  engine?: string | null
  error?: string | null
}

const MAX_PIXELS = 80_000_000
const MAX_MP = MAX_PIXELS / 1_000_000
const MAX_SQUARE_SIDE = Math.floor(Math.sqrt(MAX_PIXELS))

function sanitizeDecimalInput(raw: string) {
  // Keep digits and a single dot; strip everything else.
  let out = ''
  let dot = false
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch
    else if (ch === '.' && !dot) {
      out += '.'
      dot = true
    }
  }
  return out
}

function sanitizeMathInput(raw: string) {
  // Allow digits, dot, spaces, and basic operators for simple math expressions.
  // Used for Width/Height fields.
  return raw.replace(/[^0-9+\-*/().\s]/g, '')
}

function tryEvalMathExpr(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null

  const tokens: string[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ') {
      i++
      continue
    }
    if ('()+-*/'.includes(c)) {
      // unary +/- -> 0 +/- x
      if ((c === '+' || c === '-') && (tokens.length === 0 || '()+-*/'.includes(tokens[tokens.length - 1]))) {
        tokens.push('0')
      }
      tokens.push(c)
      i++
      continue
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i + 1
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++
      tokens.push(s.slice(i, j))
      i = j
      continue
    }
    return null
  }

  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }
  const out: string[] = []
  const ops: string[] = []

  for (const t of tokens) {
    if (!Number.isNaN(Number(t)) && t !== '(' && t !== ')') {
      out.push(t)
      continue
    }
    if (t === '(') {
      ops.push(t)
      continue
    }
    if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop()!)
      if (!ops.length) return null
      ops.pop()
      continue
    }
    if (t in prec) {
      while (ops.length) {
        const top = ops[ops.length - 1]
        if (!(top in prec)) break
        if (prec[top] >= prec[t]) out.push(ops.pop()!)
        else break
      }
      ops.push(t)
      continue
    }
    return null
  }
  while (ops.length) {
    const op = ops.pop()!
    if (op === '(' || op === ')') return null
    out.push(op)
  }

  const st: number[] = []
  for (const t of out) {
    if (t in prec) {
      const b = st.pop()
      const a = st.pop()
      if (a === undefined || b === undefined) return null
      if (t === '+') st.push(a + b)
      else if (t === '-') st.push(a - b)
      else if (t === '*') st.push(a * b)
      else if (t === '/') st.push(a / b)
    } else {
      const n = Number(t)
      if (!Number.isFinite(n)) return null
      st.push(n)
    }
  }
  if (st.length !== 1) return null
  const v = st[0]
  if (!Number.isFinite(v)) return null
  return v
}

function isHexColor(s: string) {
  const v = s.trim()
  return /^#?[0-9a-fA-F]{6}$/.test(v)
}

export default function App() {
  const btnIconWiggle =
    'transition-transform will-change-transform group-hover:animate-[icon-wiggle_0.52s_cubic-bezier(0.16,1,0.3,1)_1]'

  const [inputMode, setInputMode] = useState<InputMode>('file')
  const [inputPath, setInputPath] = useState<string>('')
  const [inputPaths, setInputPaths] = useState<string[]>([])
  const [outputDir, setOutputDir] = useState<string>('')

  const [sizeMode, setSizeMode] = useState<SizeMode>('scale')
  const [scale, setScale] = useState<string>('1')
  const [width, setWidth] = useState<string>('')
  const [height, setHeight] = useState<string>('')
  const [lockAspect, setLockAspect] = useState<boolean>(true)
  const [aspectRatio, setAspectRatio] = useState<number | null>(null) // width / height when locked
  const lastExactEditedRef = useRef<'w' | 'h' | null>(null)
  const [bgColor, setBgColor] = useState<string>('')

  const [selectedCount, setSelectedCount] = useState<number>(0)
  const [sourceSize, setSourceSize] = useState<SvgSize | null>(null)
  const [sourceSizes, setSourceSizes] = useState<Array<{ path: string; size: SvgSize }>>([])
  const [folderSizeInfo, setFolderSizeInfo] = useState<FolderSizeInfo | null>(null)

  const [isConverting, setIsConverting] = useState(false)
  const [progress, setProgress] = useState<ConvertProgressEvent | null>(null)
  const [items, setItems] = useState<Array<ConvertItemEvent & { receivedAt: number; runId: number }>>([])
  const [runs, setRuns] = useState<Array<{ id: number; startedAt: number }>>([])
  const currentRunIdRef = useRef<number>(0)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const lastLoadedBaseKeyRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const initialViewportRef = useRef<{ w: number; h: number } | null>(null)
  const [hasResized, setHasResized] = useState(false)

  const outputSizePreview = useMemo(() => {
    const sizes =
      inputMode === 'file'
        ? sourceSizes.length
          ? sourceSizes.map((x) => x.size)
          : sourceSize
            ? [sourceSize]
            : []
        : folderSizeInfo?.uniqueSizes?.length
          ? folderSizeInfo.uniqueSizes
          : folderSizeInfo?.baseSize
            ? [folderSizeInfo.baseSize]
            : []
    if (!sizes.length) return null
    if (sizeMode === 'scale') {
      const s = Number(scale || '1')
      if (!Number.isFinite(s) || s <= 0) return null
      const list = sizes.map((sz) => ({
        w: Math.max(1, Math.round(sz.width * s)),
        h: Math.max(1, Math.round(sz.height * s)),
      }))
      return list
    }
    const w0 = tryEvalMathExpr(width)
    const h0 = tryEvalMathExpr(height)
    if (w0 == null || h0 == null) return null
    if (!Number.isFinite(w0) || !Number.isFinite(h0) || w0 <= 0 || h0 <= 0) return null
    return [{ w: Math.floor(w0), h: Math.floor(h0) }]
  }, [folderSizeInfo, height, inputMode, scale, sizeMode, sourceSize, sourceSizes, width])

  const outputSizePreviewUnique = useMemo(() => {
    if (!outputSizePreview) return null
    const seen = new Set<string>()
    const out: Array<{ w: number; h: number }> = []
    for (const sz of outputSizePreview) {
      const k = `${sz.w}x${sz.h}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(sz)
    }
    return out
  }, [outputSizePreview])

  const allSelectedSameSize = useMemo(() => {
    if (inputMode === 'folder') {
      return folderSizeInfo?.allSame ?? true
    }
    const sizes = sourceSizes.map((x) => x.size)
    if (sizes.length <= 1) return true
    const first = sizes[0]
    return sizes.every((s) => s.width === first.width && s.height === first.height)
  }, [folderSizeInfo?.allSame, inputMode, sourceSizes])

  const sizeValidationError = useMemo(() => {
    if (inputMode !== 'file') return null
    const sizes = sourceSizes.length ? sourceSizes.map((x) => x.size) : sourceSize ? [sourceSize] : []
    if (!sizes.length) return null
    const over = (w: number, h: number) => w * h > MAX_PIXELS
    if (sizeMode === 'scale') {
      const s = Number(scale || '1')
      if (!Number.isFinite(s) || s <= 0) return 'Scale must be a positive number'
      for (const sz of sizes) {
        const w = Math.max(1, Math.round(sz.width * s))
        const h = Math.max(1, Math.round(sz.height * s))
        if (over(w, h)) return `Too large. Max is ~${MAX_SQUARE_SIDE}×${MAX_SQUARE_SIDE} (${MAX_MP}MP).`
      }
      return null
    }
    const w0 = tryEvalMathExpr(width)
    const h0 = tryEvalMathExpr(height)
    if (w0 == null || h0 == null) return 'Width/Height must be positive numbers'
    if (!Number.isFinite(w0) || !Number.isFinite(h0) || w0 <= 0 || h0 <= 0) return 'Width/Height must be positive numbers'
    if (over(w0, h0)) return `Too large. Max is ~${MAX_SQUARE_SIDE}×${MAX_SQUARE_SIDE} (${MAX_MP}MP).`
    return null
  }, [height, inputMode, scale, sizeMode, sourceSize, sourceSizes, width])

  const canConvert = useMemo(() => {
    if (isConverting) return false
    if (inputMode === 'folder') {
      if (!inputPath.trim()) return false
    } else {
      if (!(inputPaths.length || inputPath.trim())) return false
    }
    if (inputMode === 'file') {
      if (!sourceSize) return false
      if (sizeValidationError) return false
      if (sizeMode === 'scale') {
        const s = Number(scale || '1')
        if (!Number.isFinite(s) || s <= 0) return false
      } else {
        const w0 = tryEvalMathExpr(width)
        const h0 = tryEvalMathExpr(height)
        if (w0 == null || h0 == null) return false
        if (!Number.isFinite(w0) || !Number.isFinite(h0) || w0 <= 0 || h0 <= 0) return false
      }
    }
    if (bgColor.trim() && !isHexColor(bgColor)) return false
    return true
  }, [bgColor, inputMode, inputPath, inputPaths, isConverting, scale, sizeMode, sizeValidationError, sourceSize, height, width])

  const exactDisabled = useMemo(() => {
    if (inputMode === 'folder') {
      // Folder: Exact allowed only when all svgs have the same original size
      return !(folderSizeInfo?.allSame ?? false)
    }
    // File: Exact allowed only when a single file OR multiple files with the same original size.
    return inputPaths.length > 1 && !allSelectedSameSize
  }, [allSelectedSameSize, folderSizeInfo?.allSame, inputMode, inputPaths.length])

  useEffect(() => {
    if (exactDisabled && sizeMode === 'exact') {
      setSizeMode('scale')
    }
  }, [exactDisabled, sizeMode])

  const prevSizeModeRef = useRef<SizeMode>(sizeMode)
  useEffect(() => {
    const prev = prevSizeModeRef.current
    prevSizeModeRef.current = sizeMode
    if (inputMode !== 'file' && inputMode !== 'folder') return
    if (sizeMode !== 'exact') return
    if (exactDisabled) return
    if (prev === 'exact') return
    const base =
      inputMode === 'folder'
        ? (folderSizeInfo?.baseSize ?? sourceSize)
        : (sourceSizes[0]?.size ?? sourceSize)
    if (!base) return
    setWidth(String(base.width))
    setHeight(String(base.height))
    setLockAspect(true)
    setAspectRatio(base.height ? base.width / base.height : null)
  }, [exactDisabled, folderSizeInfo, inputMode, sizeMode, sourceSize, sourceSizes])

  useEffect(() => {
    // If multiple files are selected and they have different original sizes, force Scale mode.
    if (inputMode === 'file' && inputPaths.length > 1 && !allSelectedSameSize && sizeMode === 'exact') {
      setSizeMode('scale')
    }
  }, [allSelectedSameSize, inputMode, inputPaths.length, sizeMode])

  async function refreshSelectionMeta(nextInputPath: string, nextMode: InputMode, nextInputPaths?: string[]) {
    setSelectedCount(0)
    setSourceSize(null)
    setSourceSizes([])
    setFolderSizeInfo(null)
    if (!nextInputPath) return
    try {
      if (nextMode === 'folder') {
        const info = await invoke<FolderSizeInfo>('scan_svg_folder_sizes', { dirPath: nextInputPath })
        setFolderSizeInfo(info)
        setSelectedCount(info.total)
        setSourceSize(info.baseSize ?? null)
      } else {
        const files = (nextInputPaths && nextInputPaths.length ? nextInputPaths : [nextInputPath]).filter(Boolean)
        if (!files.length) return
        setSelectedCount(files.length)
        const sizes = await Promise.all(
          files.map(async (p) => ({ path: p, size: await invoke<SvgSize>('get_svg_size', { svgPath: p }) }))
        )
        setSourceSizes(sizes)
        setSourceSize(sizes[0]?.size ?? null)
      }
    } catch {
      // ignore
    }
  }

  function resetRunUi() {
    setProgress(null)
  }

  function resetAll() {
    setInputPath('')
    setInputPaths([])
    setOutputDir('')
    setSizeMode('scale')
    setScale('1')
    setWidth('')
    setHeight('')
    setBgColor('')
    setSelectedCount(0)
    setSourceSize(null)
    setSourceSizes([])
    setFolderSizeInfo(null)
    setIsConverting(false)
    setProgress(null)
    setItems([])
    setRuns([])
    currentRunIdRef.current = 0
  }

  async function pickInput() {
    const picked = await open({
      directory: inputMode === 'folder',
      multiple: inputMode === 'file',
      filters: inputMode === 'file' ? [{ name: 'SVG', extensions: ['svg'] }] : undefined,
    })
    if (inputMode === 'folder') {
      const p = typeof picked === 'string' ? picked : ''
      setInputPath(p)
      setInputPaths([])
      resetRunUi()
      await refreshSelectionMeta(p, inputMode)
      return
    }

    const filesRaw = Array.isArray(picked)
      ? picked.filter((x): x is string => typeof x === 'string')
      : typeof picked === 'string'
        ? [picked]
        : []
    // de-dupe (prevents accidental duplicates)
    const files = Array.from(new Set(filesRaw))
    setInputPaths(files)
    setInputPath(files[0] ?? '')
    resetRunUi()
    await refreshSelectionMeta(files[0] ?? '', inputMode, files)
  }

  async function pickOutputDir() {
    const picked = await open({ directory: true, multiple: false })
    const p = typeof picked === 'string' ? picked : ''
    setOutputDir(p)
  }

  async function startConvert() {
    if (!canConvert) return
    setIsConverting(true)
    setProgress(null)
    const rid = currentRunIdRef.current + 1
    currentRunIdRef.current = rid
    setRuns((prev) => [{ id: rid, startedAt: Date.now() }, ...prev].slice(0, 30))
    try {
      await invoke('convert_svg_to_png', {
        inputMode,
        inputPath,
        inputPaths: inputMode === 'file' ? inputPaths : null,
        outputDir: outputDir.trim() ? outputDir.trim() : null,
        sizeMode,
        crop: sizeMode === 'exact' ? !lockAspect : false,
        scale: sizeMode === 'scale' ? Number(scale || '1') : null,
        width: sizeMode === 'exact' ? (tryEvalMathExpr(width) ?? null) : null,
        height: sizeMode === 'exact' ? (tryEvalMathExpr(height) ?? null) : null,
        background: bgColor.trim() ? bgColor.trim() : null,
      })
    } finally {
      setIsConverting(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const unsubs: Array<() => void> = []
    ;(async () => {
      const u1 = await listen<ConvertProgressEvent>('convert-progress', (e) => setProgress(e.payload))
      const u2 = await listen<ConvertItemEvent>('convert-item', (e) =>
        setItems((prev) => [{ ...e.payload, receivedAt: Date.now(), runId: currentRunIdRef.current }, ...prev].slice(0, 400))
      )
      if (cancelled) {
        u1()
        u2()
        return
      }
      unsubs.push(u1, u2)
    })()
    return () => {
      cancelled = true
      for (const u of unsubs) u()
    }
  }, [])

  // When selection changes while staying in Exact, refresh Width/Height to match new selected base size.
  useEffect(() => {
    if (sizeMode !== 'exact') return
    if (exactDisabled) return
    const base =
      inputMode === 'folder'
        ? (folderSizeInfo?.baseSize ?? sourceSize)
        : (sourceSizes[0]?.size ?? sourceSize)
    if (!base) return
    const key = `${base.width}x${base.height}`
    if (lastLoadedBaseKeyRef.current === key) return
    lastLoadedBaseKeyRef.current = key
    setWidth(String(base.width))
    setHeight(String(base.height))
    setAspectRatio(base.height ? base.width / base.height : null)
    lastExactEditedRef.current = null
  }, [exactDisabled, folderSizeInfo, inputMode, sizeMode, sourceSize, sourceSizes])

  // Draggable window on blank areas (avoid selecting text)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMouseDown = async (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('button, input, textarea, a, [data-tauri-drag-region=\"false\"]')) return
      try {
        await getCurrentWindow().startDragging()
      } catch {
        // ignore
      }
    }
    el.addEventListener('mousedown', onMouseDown)
    return () => el.removeEventListener('mousedown', onMouseDown)
  }, [])

  // Layout rule:
  // - On initial open: align to bottom so Run's bottom padding matches side padding (pb-10 == px-10 system).
  // - After ANY window resize: keep all content vertically centered.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (!initialViewportRef.current) {
        initialViewportRef.current = { w, h }
        return
      }
      const init = initialViewportRef.current
      // Treat any meaningful change as "user resized".
      if (!hasResized && (Math.abs(w - init.w) > 2 || Math.abs(h - init.h) > 2)) {
        setHasResized(true)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasResized])


  const highlightColor = '#FF5000'
  const progressColor = '#22c55e'
  const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1]

  const fadeUp = {
    initial: { opacity: 0, y: 36 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.9, ease: EASE_OUT } },
  }
  const fadeUpDelayed = (delay: number) => ({
    initial: { opacity: 0, y: 36 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.9, ease: EASE_OUT, delay } },
  })

  return (
    <div ref={containerRef} className="h-full w-full">
      <div ref={scrollRef} className="mx-auto h-full w-full max-w-[1280px] overflow-y-auto px-10 pt-[32px] pb-10 no-scrollbar">
        <div className={['flex min-h-full flex-col gap-6', hasResized ? 'justify-center' : 'justify-end'].join(' ')}>
        <motion.div {...fadeUp} className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="rounded-2xl bg-white/5 p-3">
              <img src={AppIcon} alt="App icon" className="h-10 w-10" draggable={false} />
            </div>
          <div>
              <div className="text-4xl font-black tracking-tight">SVG → PNG</div>
              <div className="mt-1 text-sm text-white/50">Local conversion, Zero data leakage, Guaranteed security</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={inputMode === 'file' ? 'default' : 'outline'}
              className="h-14 px-6 text-lg font-semibold"
              onClick={async () => {
                if (inputMode === 'file') return
                setInputMode('file')
                setInputPath('')
                setInputPaths([])
                // keep current sizeMode as-is; File supports both Scale/Exact
                await refreshSelectionMeta('', 'file')
              }}
            >
              <HoverImageMoonIcon className="h-6 w-6" open={inputMode === 'file'} />
              File
            </Button>
            <Button
              variant={inputMode === 'folder' ? 'default' : 'outline'}
              className="h-14 px-6 text-lg font-semibold"
              onClick={async () => {
                if (inputMode === 'folder') return
                setInputMode('folder')
                setInputPath('')
                setInputPaths([])
                // Folder mode does not allow Exact sizing
                setSizeMode('scale')
                await refreshSelectionMeta('', 'folder')
              }}
            >
              <HoverFolderIcon className="h-6 w-6" open={inputMode === 'folder'} />
              Folder
            </Button>
          </div>
        </motion.div>

        <motion.div {...fadeUpDelayed(0.14)} className="mt-[20px] grid w-full grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
          <div className="h-full">
            <Card className="h-full flex flex-col bg-white/[0.03]">
              <CardHeader className="pb-12">
              <CardTitle className="flex items-center gap-2">
                <HoverFolderIcon className="h-5 w-5 opacity-70" />
                Paths
              </CardTitle>
                <CardDescription>Pick input and optional output folder</CardDescription>
              </CardHeader>
            <CardContent className="flex-1 space-y-5">
                <div className="space-y-2">
                <div className="text-sm font-semibold">Input</div>
                <div className="flex items-center gap-3">
                    <Input
                      value={inputPath}
                    onChange={async (e) => {
                      const v = e.target.value
                      setInputPath(v)
                      if (inputMode === 'file') setInputPaths(v.trim() ? [v] : [])
                      resetRunUi()
                      if (!v.trim()) {
                        await refreshSelectionMeta('', inputMode)
                      }
                    }}
                      placeholder={inputMode === 'file' ? '/path/to/file.svg' : '/path/to/folder'}
                    />
                  <Button variant="outline" className="h-10" onClick={pickInput}>
                      Browse
                    </Button>
                  </div>
                <div className="text-xs text-white/45">
                  Selected:{' '}
                  <span style={{ color: highlightColor }} className="font-semibold">
                    {selectedCount}
                  </span>
                  {inputMode === 'file' && sourceSize ? (
                    <span className="ml-2 text-white/35">
                      (original: {sourceSize.width}×{sourceSize.height})
                    </span>
                  ) : null}
                  </div>
                </div>

                <div className="space-y-2">
                <div className="text-sm font-semibold">Output folder (optional)</div>
                <div className="flex items-center gap-3">
                  <Input
                    value={outputDir}
                    onChange={(e) => setOutputDir(e.target.value)}
                    placeholder="Default: next to SVG"
                  />
                  <Button variant="outline" className="h-10" onClick={pickOutputDir}>
                      Browse
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="h-full">
            <Card className="h-full flex flex-col bg-white/[0.03]">
              <CardHeader className="pb-12">
                <CardTitle className="flex items-center gap-2">
                <Settings2 className={`h-5 w-5 opacity-70 ${btnIconWiggle}`} />
                  Options
                </CardTitle>
                <CardDescription>Resize and background options for PNG output</CardDescription>
              </CardHeader>
            <CardContent className="flex-1 space-y-5">
              <div className="flex items-center justify-between">
                  <div>
                  <div className="text-sm font-semibold">Size</div>
                  <div className="text-xs text-white/45">Choose scale or set exact W×H</div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant={sizeMode === 'scale' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSizeMode('scale')}
                  >
                    Scale
                  </Button>
                  <Button
                    variant={sizeMode === 'exact' ? 'default' : 'outline'}
                    size="sm"
                    disabled={exactDisabled}
                    onClick={() => setSizeMode('exact')}
                  >
                    Exact
                  </Button>
                </div>
              </div>

              {sizeMode === 'scale' ? (
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Scale (× original)</div>
                  <div className="flex items-center gap-3">
                    <Input
                      value={scale}
                      inputMode="decimal"
                      onChange={(e) => setScale(sanitizeDecimalInput(e.target.value))}
                      placeholder="1"
                    />
                    {['1', '2', '3', '4'].map((v) => (
                      <Button
                        key={v}
                        variant={scale === v ? 'default' : 'outline'}
                        className="h-10 px-4"
                        onClick={() => setScale(v)}
                      >
                        {v}x
                      </Button>
                    ))}
                  </div>
                  <div className="text-xs text-white/45">
                    {outputSizePreviewUnique ? (
                      outputSizePreviewUnique.length <= 1 ? (
                        <>
                          Output:{' '}
                          <span style={{ color: highlightColor }} className="font-semibold">
                            {outputSizePreviewUnique[0].w}×{outputSizePreviewUnique[0].h}
                          </span>
                        </>
                      ) : (
                        <div className="space-y-1">
                          <div>Output sizes ({outputSizePreviewUnique.length}):</div>
                          {outputSizePreviewUnique.slice(0, 4).map((sz, idx) => (
                            <div key={idx} className="text-white/55">
                              -{' '}
                              <span style={{ color: highlightColor }} className="font-semibold">
                                {sz.w}×{sz.h}
                              </span>
                            </div>
                          ))}
                          {outputSizePreviewUnique.length > 4 ? (
                            <div className="text-white/40">… and {outputSizePreviewUnique.length - 4} more</div>
                          ) : null}
                        </div>
                      )
                    ) : inputMode === 'file' ? (
                      'Select an SVG file to show the original size'
                    ) : inputMode === 'folder' ? (
                      'Select a folder to show output sizes'
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
                  <div className="space-y-2">
                    <div className="text-sm font-semibold">Width</div>
                    <Input
                      value={width}
                      inputMode="text"
                      onChange={(e) => {
                        const v = sanitizeMathInput(e.target.value)
                        lastExactEditedRef.current = 'w'
                        setWidth(v)
                        const w = tryEvalMathExpr(v)
                        if (lockAspect && w && w > 0 && aspectRatio) {
                          const h = Math.max(1, Math.round(w / aspectRatio))
                          setHeight(String(h))
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        const w = tryEvalMathExpr(width)
                        if (w && w > 0) setWidth(String(Math.round(w)))
                      }}
                      onBlur={() => {
                        const w = tryEvalMathExpr(width)
                        if (w && w > 0) setWidth(String(Math.round(w)))
                      }}
                    />
                  </div>

                  <div className="flex justify-center pb-[2px]">
                    <Button
                      type="button"
                      variant={lockAspect ? 'default' : 'outline'}
                      size="icon"
                      className="h-9 w-9"
                      onClick={() => {
                        setLockAspect((v) => {
                          const next = !v
                          if (next) {
                            const w = tryEvalMathExpr(width)
                            const h = tryEvalMathExpr(height)
                            const ratio = w && h && w > 0 && h > 0 ? w / h : aspectRatio
                            setAspectRatio(ratio ?? null)
                          }
                          return next
                        })
                      }}
                      disabled={!sourceSize}
                      title={lockAspect ? 'Aspect locked (auto link W/H)' : 'Aspect unlocked (center crop)'}
                    >
                      {lockAspect ? (
                        <Link2 className={`h-4 w-4 ${btnIconWiggle}`} />
                      ) : (
                        <Link2Off className={`h-4 w-4 ${btnIconWiggle}`} />
                      )}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <div className="text-sm font-semibold">Height</div>
                    <Input
                      value={height}
                      inputMode="text"
                      onChange={(e) => {
                        const v = sanitizeMathInput(e.target.value)
                        lastExactEditedRef.current = 'h'
                        setHeight(v)
                        const h = tryEvalMathExpr(v)
                        if (lockAspect && h && h > 0 && aspectRatio) {
                          const w = Math.max(1, Math.round(h * aspectRatio))
                          setWidth(String(w))
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        const h = tryEvalMathExpr(height)
                        if (h && h > 0) setHeight(String(Math.round(h)))
                      }}
                      onBlur={() => {
                        const h = tryEvalMathExpr(height)
                        if (h && h > 0) setHeight(String(Math.round(h)))
                      }}
                    />
                  </div>
                </div>
              )}

              {sizeValidationError ? (
                <div className="flex items-start gap-2 rounded-md border bg-white/5 p-3 text-sm">
                  <XCircle className={`mt-0.5 h-4 w-4 ${btnIconWiggle}`} style={{ color: highlightColor }} />
                  <div style={{ color: highlightColor }} className="font-semibold">
                    {sizeValidationError}
                  </div>
                </div>
              ) : null}

                <div className="space-y-2">
                <div className="text-sm font-semibold">Background (optional)</div>
                <Input value={bgColor} onChange={(e) => setBgColor(e.target.value)} placeholder='e.g. "#ffffff"' />
                <div className="text-xs text-white/45">Leave empty for transparent background</div>
                </div>
              </CardContent>
            </Card>
          </div>
          </motion.div>

        <motion.div {...fadeUpDelayed(0.22)} className="w-full">
          <Card className="bg-white/[0.03]">
          <CardHeader className="flex-row items-start justify-between gap-6 space-y-0">
            <div className="min-w-0 flex flex-col space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <Play className={`h-5 w-5 opacity-70 ${btnIconWiggle}`} />
                Run
              </CardTitle>
              <CardDescription>Convert locally, progress and results appear below</CardDescription>
        </div>
            <Button variant="ghost" className="text-white/60" onClick={resetAll} disabled={isConverting}>
              Reset
            </Button>
            </CardHeader>
            <CardContent className="space-y-4">
            <Button
              className={[
                'h-16 w-full text-lg font-semibold',
                canConvert
                  ? 'bg-[#FF5000] text-white hover:bg-[#FF5000]/90'
                  : 'bg-white/10 text-white/45 hover:bg-white/10',
              ].join(' ')}
              disabled={!canConvert}
              onClick={startConvert}
            >
              <Wand2 className={`h-5 w-5 ${btnIconWiggle}`} />
              {isConverting ? 'Converting…' : 'Convert'}
                </Button>

            {progress ? (
              <div className="rounded-md border bg-white/5 p-4 text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">
                    Phase: <span style={{ color: highlightColor }}>{progress.phase}</span>
                    {progress.last_svg ? <span className="ml-2 text-white/45">({progress.last_svg})</span> : null}
                  </div>
                  <div className="text-white/60">
                    {progress.ok}/{progress.total} ok · {progress.failed} failed
                  </div>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
                  <motion.div
                    className="h-full rounded-full"
                    animate={isConverting ? { opacity: [0.75, 1, 0.75] } : { opacity: 1 }}
                    transition={isConverting ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' } : undefined}
                    style={{
                      width: `${progress.total ? Math.round(((progress.ok + progress.failed) / progress.total) * 100) : 0}%`,
                      background: progressColor,
                    }}
                  />
                </div>
              </div>
            ) : null}

            {items.length ? (
              <div className="max-h-44 overflow-auto rounded-md border bg-black/20 p-3 text-xs no-scrollbar">
                <div className="space-y-3">
                  {runs.map((run) => {
                    const runItems = items.filter((it) => it.runId === run.id).slice().reverse()
                    if (!runItems.length) return null
                    return (
                      <div key={run.id} className="space-y-2">
                        <div className="text-white/45">
                          {new Date(run.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </div>
                        <div className="space-y-1">
                          {runItems.map((it, idx) => (
                            <div key={`${it.svg}-${run.id}-${idx}`} className="flex items-center justify-between gap-3">
                              <div className="min-w-0 truncate text-white/75">
                                [{it.ok ? 'OK' : 'FAIL'}] {it.svg}
                              </div>
                              <div className="shrink-0 text-white/40">
                                {it.out_width && it.out_height ? `${it.out_width}×${it.out_height}` : ''}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
            </CardContent>
          </Card>
        </motion.div>
        </div>
      </div>
    </div>
  )
}


