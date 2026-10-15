import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// A real 800x200 PNG, so the IHDR size is what mmdc would write.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAyAAAADICAYAAAAQj4UaAAACg0lEQVR42u3BMQEAAADCoPVPbQsvoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeBjFTwABgzmSyAAAAABJRU5ErkJggg=='

const REPLY = 'Así lo entiendo:\n\n```mermaid\ngraph LR\nA --> B\n```\n\n¿Es eso?'

const GHOSTTY = '/home/u\nxterm-ghostty\nghostty\n'
const GNOME = '/home/u\nxterm-256color\ngnome\n'
const GHOSTTY_IN_TMUX = '/home/u\ntmux-256color\nghostty\n/tmp/tmux-1000/default,1,0'

const done = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Stands for the engine beneath the plugin: the terminal it runs in, mmdc, the files.
const host = (on: On, terminal: string) => {
  const ran: string[] = []
  on('process.run', (_, e) => {
    ran.push(e.argv[0] ?? '')
    if (e.argv[0] === 'sh') return done(terminal)
    if (e.argv[0] === 'mmdc') return done('')
    return done('', 1)
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'You are Claude.', scope: 'session' }] }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.props.text} />
  })
  return ran
}

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

// The diagram renders in the background; let its job and the redraw land.
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

const reply = (requestId: string) =>
  ({
    plugin: 'mermaid-render',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: REPLY, isFirstOfReply: true },
    requestId,
    viewport: { columns: 120, rows: 40 },
  }) as const

test('in Ghostty it asks the model for Mermaid', async ($, on) => {
  host(on, GHOSTTY)
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['engine', 'mermaid-render:diagrams'])
})

test('without images it leaves the prompt alone, so the model keeps drawing ASCII', async ($, on) => {
  host(on, GNOME)
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['engine'])
})

test('in Ghostty it draws the PNG from mmdc as an Image beside the markdown', async ($, on) => {
  host(on, GHOSTTY)
  const mounted = await $.ui.mount(reply('m1'))
  await settle()

  const image = await mounted.find({ type: 'Image' })
  expect(image?.props.columns).toBe(45)
  expect(image?.props.rows).toBe(5)
  expect(await mounted.find({ type: 'Markdown', text: /Así lo entiendo/ })).toBeDefined()
})

test('inside tmux it never runs mmdc and the engine draws the block as code', async ($, on) => {
  const ran = host(on, GHOSTTY_IN_TMUX)
  const mounted = await $.ui.mount(reply('m2'))
  await settle()

  expect(await mounted.find({ type: 'Image' })).toBeUndefined()
  expect(JSON.stringify(await mounted.drawn())).toContain('graph LR')
  expect(ran).not.toContain('mmdc')
})
