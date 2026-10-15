# mermaid-render

A Claude Code plugin that draws ```` ```mermaid ```` blocks in Claude's replies as
images, right in the terminal.

- **Ghostty or kitty** (outside tmux): tells Claude to prefer Mermaid for diagrams,
  laid out left to right, and renders each block as an image with `mmdc`.
- **Any other terminal:** does nothing. Claude keeps drawing diagrams in ASCII.

Diagrams are drawn as large as the terminal allows: up to its full width and 80% of
its height, keeping their proportions.

Press **Copy** under a diagram to put its Mermaid code on the clipboard, or **Copy PNG**
for the image (needs `wl-copy`, `xclip` or macOS).

## Requirements

[mermaid-cli](https://github.com/mermaid-js/mermaid-cli) on your `PATH`:

```sh
npm i -g @mermaid-js/mermaid-cli
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install mermaid-render --marketplace pablofrr/mermaid-render
```

Answer `y` to add the marketplace, then pick a scope.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

Rendered diagrams are cached in `~/.cache/claude-mermaid-render`.
