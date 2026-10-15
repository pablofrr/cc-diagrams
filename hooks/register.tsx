import type { Register } from 'claude-code'

// Only closed fences: a block still streaming is left as code until it ends.
const FENCE = /```mermaid[^\n]*\n([\s\S]*?)\n```/g

// Terminal cells are roughly twice as tall as they are wide.
const CELL_PX = 9
const CELL_ASPECT = 0.45
const MMDC_SCALE = 2

const PROMPT_SECTION = {
  id: 'mermaid-render:diagrams',
  text: 'This terminal renders ```mermaid code blocks as images. When a diagram helps, prefer a Mermaid block over an ASCII drawing.',
  scope: 'session',
} as const

type Env = { home: string; hasGraphics: boolean }

type Rendered = { kind: 'png'; base64: string; width: number; height: number } | { kind: 'failed' }

type Segment = { kind: 'text'; text: string } | { kind: 'mermaid'; source: string; hash: string }

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

export const register: Register = on => {
  let env: Promise<Env> | undefined
  const cache = new Map<string, Rendered>()
  const pending = new Set<string>()

  // Images need the kitty graphics protocol, which tmux does not pass through.
  const readEnv = (run: (argv: string[]) => Promise<{ stdout: string }>): Promise<Env> =>
    (env ??= run(['sh', '-c', 'printf "%s\\n%s\\n%s\\n%s" "$HOME" "$TERM" "$TERM_PROGRAM" "$TMUX"']).then(
      ({ stdout }) => {
        const [home = '', term = '', program = '', tmux = ''] = stdout.split('\n')
        const isGraphicsTerminal = /kitty|ghostty/i.test(`${term} ${program}`)
        return { home, hasGraphics: isGraphicsTerminal && tmux === '' }
      },
    ))

  // Without images the model keeps drawing ASCII; only ask for Mermaid where it renders.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { hasGraphics } = await readEnv(argv => $.process.run(argv))
    return hasGraphics ? { sections: [...composed.sections, PROMPT_SECTION] } : composed
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !e.props.text.includes('```mermaid')) return next(e)

    const { home, hasGraphics } = await readEnv(argv => $.process.run(argv))
    if (!hasGraphics) return next(e)

    const segments = split(e.props.text)
    const blocks = segments.filter(s => s.kind === 'mermaid')
    if (blocks.length === 0) return next(e)

    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    const dir = `${home}/.cache/claude-mermaid-render`

    const toPng = async (source: string, hash: string): Promise<Rendered> => {
      const input = `${dir}/${hash}.mmd`
      const output = `${dir}/${hash}.png`
      await $.fs.write(input, source)
      const args = ['-i', input, '-o', output, '-t', 'dark', '-b', 'transparent', '-s', String(MMDC_SCALE), '-q']
      const result = await $.process.run(['mmdc', ...args], { timeoutMs: 20_000 })
      if (result.exitCode !== 0) return { kind: 'failed' }
      const { base64 } = await $.fs.read(output, { as: 'bytes' })
      return { kind: 'png', base64, ...pngSize(base64) }
    }

    for (const block of blocks) {
      if (cache.has(block.hash) || pending.has(block.hash)) continue
      pending.add(block.hash)
      void toPng(block.source, block.hash)
        .catch((): Rendered => ({ kind: 'failed' }))
        .then(rendered => {
          cache.set(block.hash, rendered)
          pending.delete(block.hash)
          $.ui.invalidate('ui.render')
        })
    }

    // Until a diagram is ready, or if mmdc failed, the engine draws the block as code.
    if (blocks.every(b => cache.get(b.hash)?.kind !== 'png')) return next(e)

    const { Box, Markdown, Image, Code } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {segments.map((s, i) => {
          if (s.kind === 'text') return s.text.trim() === '' ? null : <Markdown key={`t${i}`} text={s.text} />
          const r = cache.get(s.hash)
          if (r?.kind !== 'png') return <Code key={`m${i}`} source={s.source} language="mermaid" />
          const cols = Math.min(columns, Math.ceil(r.width / MMDC_SCALE / CELL_PX))
          const rows = Math.max(1, Math.min(255, Math.round((cols * r.height * CELL_ASPECT) / r.width)))
          return <Image key={`m${i}`} source={{ png: r.base64 }} columns={Math.min(255, cols)} rows={rows} alt="mermaid diagram" />
        })}
      </Box>
    )
  })
}
