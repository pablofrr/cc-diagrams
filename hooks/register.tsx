import type { EngineInterface, Register } from 'claude-code'

// Only closed fences: a block still streaming is left as code until it ends.
const FENCE = /```mermaid[^\n]*\n([\s\S]*?)\n```/g

// Terminal cells are roughly twice as tall as they are wide.
const CELL_PX = 9
const CELL_ASPECT = 0.45
// mmdc renders at 4x so the terminal never has to stretch the picture on a HiDPI screen.
const MMDC_SCALE = 4
const DISPLAY_ZOOM = 1.2

// Mermaid fits each diagram to the page's width by default: a sparse one is blown up and a
// wide one shrunk. Off, every diagram renders at its natural size. Its dark theme also gives
// every box a light drop shadow, which reads as a blurred outline in the terminal.
const DIAGRAM_TYPES = ['flowchart', 'sequence', 'state', 'class', 'er', 'gantt', 'journey', 'pie', 'mindmap', 'timeline', 'gitGraph']
const MERMAID_CONFIG = JSON.stringify({
  ...Object.fromEntries(DIAGRAM_TYPES.map(type => [type, { useMaxWidth: false }])),
  themeCSS: '* { filter: none !important; }',
})

const SHARE_OF_SCREEN = 0.8

const PROMPT_SECTION = {
  id: 'cc-diagrams:mermaid',
  text: 'This terminal renders ```mermaid code blocks as images. When a diagram helps, prefer a Mermaid block over an ASCII drawing. The terminal is much wider than it is tall, so prefer left-to-right layouts (graph LR) over top-down ones.',
  scope: 'session',
} as const

type Env = { home: string; hasGraphics: boolean }

type Diagram = { hash: string; source: string }

type Rendered = { kind: 'png'; file: string; width: number; height: number } | { kind: 'failed' }

type Segment = { kind: 'text'; text: string } | ({ kind: 'mermaid' } & Diagram)

const hashOf = (text: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

const split = (text: string): Segment[] => {
  const segments: Segment[] = []
  let last = 0
  for (const match of text.matchAll(FENCE)) {
    const start = match.index ?? 0
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) })
    const source = match[1] ?? ''
    segments.push({ kind: 'mermaid', source, hash: hashOf(source) })
    last = start + match[0].length
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments
}

// Width and height live in the IHDR chunk, bytes 16..23 of every PNG.
const pngSize = (base64: string) => {
  const header = atob(base64.slice(0, 32))
  const u32 = (at: number) =>
    ((header.charCodeAt(at) << 24) | (header.charCodeAt(at + 1) << 16) | (header.charCodeAt(at + 2) << 8) | header.charCodeAt(at + 3)) >>> 0
  return { width: u32(16), height: u32(20) }
}

const fit = (png: { width: number; height: number }, maxColumns: number, maxRows: number) => {
  const rowsPerColumn = (png.height / png.width) * CELL_ASPECT
  let columns = Math.min(maxColumns, Math.ceil(((png.width / MMDC_SCALE) * DISPLAY_ZOOM) / CELL_PX))
  if (columns * rowsPerColumn > maxRows) columns = Math.floor(maxRows / rowsPerColumn)
  columns = Math.max(1, Math.min(255, columns))
  const rows = Math.max(1, Math.min(255, Math.round(columns * rowsPerColumn)))
  return { columns, rows }
}

let env: Promise<Env> | undefined
const cache = new Map<string, Rendered>()
const pending = new Set<string>()

// Images need the kitty graphics protocol, which tmux does not pass through.
function readEnv($: EngineInterface): Promise<Env> {
  return (env ??= $.process
    .run(['sh', '-c', 'printf "%s\\n%s\\n%s\\n%s" "$HOME" "$TERM" "$TERM_PROGRAM" "$TMUX"'])
    .then(({ stdout }) => {
      const [home = '', term = '', program = '', tmux = ''] = stdout.split('\n')
      const isGraphicsTerminal = /kitty|ghostty/i.test(`${term} ${program}`)
      return { home, hasGraphics: isGraphicsTerminal && tmux === '' }
    }))
}

async function toPng($: EngineInterface, { source, hash }: Diagram): Promise<Rendered> {
  const { home } = await readEnv($)
  const input = `${home}/.cache/cc-diagrams/${hash}.mmd`
  const config = `${home}/.cache/cc-diagrams/config.${hashOf(MERMAID_CONFIG)}.json`
  const output = `${home}/.cache/cc-diagrams/${hash}.${hashOf(MERMAID_CONFIG)}@${MMDC_SCALE}x.png`
  await $.fs.write(input, source)
  await $.fs.write(config, MERMAID_CONFIG)
  const args = ['-i', input, '-o', output, '-c', config, '-t', 'dark', '-b', 'transparent', '-s', String(MMDC_SCALE), '-q']
  const result = await $.process.run(['mmdc', ...args], { timeoutMs: 20_000 })
  if (result.exitCode !== 0) return { kind: 'failed' }
  const { base64 } = await $.fs.read(output, { as: 'bytes' })
  return { kind: 'png', file: output, ...pngSize(base64) }
}

// The clipboard tools stay in the background serving the image; with their output
// redirected, process.run does not wait for them.
const COPY_IMAGE_SCRIPT = `
f="$1"
if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy; then wl-copy --type image/png < "$f"
elif command -v xclip; then xclip -selection clipboard -t image/png -i "$f"
elif command -v osascript; then osascript -e "set the clipboard to (read (POSIX file \\"$f\\") as «class PNGf»)"
else exit 127
fi >/dev/null 2>&1
`

async function copyImage($: EngineInterface, file: string) {
  const { exitCode } = await $.process.run(['sh', '-c', COPY_IMAGE_SCRIPT, 'sh', file], { timeoutMs: 10_000 })
  $.ui.toast(exitCode === 0 ? 'Diagram PNG copied' : 'No clipboard tool for images (wl-copy, xclip or osascript)')
}

function ensure($: EngineInterface, diagram: Diagram): Rendered | undefined {
  if (!cache.has(diagram.hash) && !pending.has(diagram.hash)) {
    pending.add(diagram.hash)
    void toPng($, diagram)
      .catch((): Rendered => ({ kind: 'failed' }))
      .then(rendered => {
        cache.set(diagram.hash, rendered)
        pending.delete(diagram.hash)
        $.ui.invalidate('ui.render')
      })
  }
  return cache.get(diagram.hash)
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { hasGraphics } = await readEnv($)
    return hasGraphics ? { sections: [...composed.sections, PROMPT_SECTION] } : composed
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !e.props.text.includes('```mermaid')) return next(e)

    const { hasGraphics } = await readEnv($)
    if (!hasGraphics) return next(e)

    const segments = split(e.props.text)
    const blocks = segments.filter(s => s.kind === 'mermaid')
    if (blocks.length === 0) return next(e)

    blocks.forEach(b => ensure($, b))

    if (blocks.every(b => cache.get(b.hash)?.kind !== 'png')) return next(e)

    const maxColumns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    const maxRows = Math.floor((e.viewport?.rows ?? 40) * SHARE_OF_SCREEN)
    const { Box, Markdown, Image, Code, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {segments.map((s, i) => {
          if (s.kind === 'text') return s.text.trim() === '' ? null : <Markdown key={`t${i}`} text={s.text} />
          const r = cache.get(s.hash)
          if (r?.kind !== 'png') return <Code key={`m${i}`} source={s.source} language="mermaid" />
          return (
            <Box key={`m${i}`} flexDirection="column">
              <Image source={{ file: r.file, format: 'png' }} {...fit(r, maxColumns, maxRows)} alt="mermaid diagram" />
              <Box>
                <Button
                  key={`copy-${s.hash}`}
                  label="Copy"
                  dimColor
                  onPress={async press => {
                    const { isCopied } = await $.ui.copy({ text: s.source, surface: press.surface })
                    if (isCopied) $.ui.toast('Mermaid code copied')
                  }}
                />
                <Button key={`copy-png-${s.hash}`} label="Copy PNG" dimColor onPress={() => copyImage($, r.file)} />
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
