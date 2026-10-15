# mermaid-render

A Claude Code plugin that draws ```` ```mermaid ```` blocks in Claude's replies as
images, right in the terminal.

- **Ghostty or kitty** (outside tmux): tells Claude to prefer Mermaid for diagrams
  and renders each block as an image with `mmdc`.
- **Any other terminal:** does nothing. Claude keeps drawing diagrams in ASCII.

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
