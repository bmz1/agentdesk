import { useEffect, useState } from "react"
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs"
import { bundledThemes } from "shiki/themes"

/**
 * Syntax highlighting with Shiki. The JavaScript regex engine avoids WebAssembly
 * (so the CSP stays strict), and grammars load lazily, one chunk per language.
 * Tokens carry both theme colors as CSS variables; styles.css picks one per theme.
 */

const LIGHT = "github-light-default"
const DARK = "github-dark-default"
/** Above this, highlighting costs more than it helps; the viewer stays plain. */
const MAX_CHARS = 200_000

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "json5",
  md: "markdown", mdx: "mdx", css: "css", scss: "scss", sass: "sass", less: "less",
  html: "html", htm: "html", vue: "vue", svelte: "svelte", astro: "astro",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish", ps1: "powershell",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", xml: "xml", svg: "xml",
  sql: "sql", graphql: "graphql", gql: "graphql", prisma: "prisma", proto: "proto",
  lua: "lua", dart: "dart", ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell",
  scala: "scala", clj: "clojure", r: "r", tf: "hcl", hcl: "hcl", zig: "zig", nix: "nix"
}
const BY_FILENAME: Record<string, string> = {
  dockerfile: "docker", makefile: "makefile", ".env": "dotenv", ".gitignore": "shellscript"
}

const KNOWN = new Map<string, string>()
for (const info of bundledLanguagesInfo) {
  KNOWN.set(info.id, info.id)
  for (const alias of info.aliases ?? []) KNOWN.set(alias, info.id)
}

/** Shiki language id for a file path or a markdown fence label, if bundled. */
export const languageFor = (pathOrLang: string): string | undefined => {
  const name = pathOrLang.split("/").at(-1)!.toLowerCase()
  const byName = BY_FILENAME[name] ?? (name.startsWith("dockerfile") ? "docker" : undefined)
  const ext = name.includes(".") ? name.split(".").at(-1)! : name
  const id = byName ?? BY_EXTENSION[ext] ?? KNOWN.get(ext)
  return id && id in bundledLanguages ? id : undefined
}

const DIFF = /^(diff --git |@@ -\d+(,\d+)? \+\d+(,\d+)? @@)/m
const looksLikeJson = (text: string) => {
  const t = text.trim()
  if (!/^[[{]/.test(t)) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

/**
 * Language for a tool's input or output: JSON when it parses, a diff when it contains hunks,
 * otherwise the language of the file the tool touched (Read/Write/Edit results).
 */
export const guessLanguage = (text: string, filePath?: string): string | undefined => {
  if (DIFF.test(text)) return "diff"
  if (looksLikeJson(text)) return "json"
  return filePath ? languageFor(filePath) : undefined
}

let highlighter: Promise<HighlighterCore> | undefined
const getHighlighter = () =>
  (highlighter ??= createHighlighterCore({
    themes: [bundledThemes[LIGHT](), bundledThemes[DARK]()],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true })
  }))

const loading = new Map<string, Promise<void>>()
const ensureLanguage = async (h: HighlighterCore, lang: string) => {
  if (h.getLoadedLanguages().includes(lang)) return
  let p = loading.get(lang)
  if (!p) {
    p = h.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages]()).then(() => undefined)
    loading.set(lang, p)
  }
  await p
}

export type HighlightedLines = ReadonlyArray<ReadonlyArray<ThemedToken>>

/**
 * Tokenized lines for `code`, or undefined while loading / when not highlightable.
 * `live` is for text being edited: re-highlighting is debounced and the previous tokens
 * stay until the new ones are ready, so the text doesn't flash plain on every keystroke.
 * Callers must check each token line still matches its text line (see `tokensFor`).
 */
export const useHighlightedLines = (code: string | undefined, lang: string | undefined, { live = false } = {}) => {
  const [lines, setLines] = useState<HighlightedLines>()
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- TODO: move highlighting to useQuery (useEffect cleanup, group B)
    if (!live) setLines(undefined)
    if (code === undefined || !lang || code.length > MAX_CHARS) {
      if (live) setLines(undefined)
      return
    }
    let cancelled = false
    const run = async () => {
      try {
        const h = await getHighlighter()
        await ensureLanguage(h, lang)
        if (cancelled) return
        const { tokens } = h.codeToTokens(code, { lang, themes: { light: LIGHT, dark: DARK }, defaultColor: false })
        if (!cancelled) setLines(tokens)
      } catch {
        // Unknown grammar or tokenizer failure: stay plain.
      }
    }
    const timer = live ? setTimeout(() => void run(), 120) : undefined
    if (!live) void run()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, lang, live])
  return lines
}

/** Tokens for line `i` when they still describe `line` (live highlighting can lag behind edits). */
export const tokensFor = (lines: HighlightedLines | undefined, i: number, line: string) => {
  const tokens = lines?.[i]
  if (!tokens) return undefined
  let joined = ""
  for (const t of tokens) joined += t.content
  return joined === line ? tokens : undefined
}

/** One highlighted line as spans; colors come from --shiki-light / --shiki-dark. */
export const tokenStyle = (t: ThemedToken) => t.htmlStyle as React.CSSProperties | undefined
