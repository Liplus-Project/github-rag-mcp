// The input box as an editor (#354), and the ``` code it shares with the room's
// posts (#348). The box is a Tiptap editor (ProseMirror underneath) whose
// document is lines of prose and code blocks; what it hands to the room is the
// Markdown string a textarea used to hold — prose lines as written, each block
// as a ``` fence — so the room, its log and every seat's terminal read the same
// text they always did.
//
// Licences of what this file pulls in: THIRD-PARTY-NOTICES.txt.

import { Editor, Extension, getSchema, textblockTypeInputRule } from "@tiptap/core";
import type { AnyExtension, NodeViewRendererProps } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { UndoRedo } from "@tiptap/extensions";
import { splitBlock } from "@tiptap/pm/commands";
import { Slice } from "@tiptap/pm/model";
import type { Fragment, Node as PMNode, Schema } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import hljs from "highlight.js/lib/core";
import { common, createLowlight } from "lowlight";

// ── ``` fences in a text (#348, #352) ────────────────────────────────────────

/**
 * A run of lines fenced by ``` (#348), by line index. `close` is null for a
 * fence nobody closed, which runs to the last line.
 */
export interface CodeFence {
  open: number;
  close: number | null;
  /** How many backticks open it: a close needs at least as many. */
  ticks: number;
  /** The language after the opening ```, or "" when none is named (#352). */
  lang: string;
  /**
   * What follows the opening ``` when it names no language (#352): the first
   * line of the code, or "" when nothing follows.
   */
  lead: string;
}

/**
 * What may follow an opening ``` as a language name (#352): one word of ASCII
 * letters, digits and - _ + . # — `ts`, `c++`, `c#`, `objective-c`. Anything
 * else written there is the code's first line.
 */
export const FENCE_LANG = /^[A-Za-z0-9_+.#-]+$/;

/**
 * Where the ``` fences are in a text's lines (#348), as CommonMark draws them:
 * a fence opens on a line that starts with three or more backticks (up to three
 * spaces in) and holds no backtick after them — so a ``` in the middle of a
 * sentence, or ```x``` on one line, fences nothing. What follows them on that
 * line is the language when it is one word of `FENCE_LANG`, and otherwise the
 * code's first line (#352): "```あ。。。" is a block whose code starts with
 * "あ。。。". It closes on a line of at least as many backticks and nothing
 * after them but spaces. A fence left open runs to the end.
 *
 * Shared by the room's lines and the input box (`docFromText`), so the two
 * cannot read the same text differently.
 */
export function findCodeFences(lines: string[]): CodeFence[] {
  const fences: CodeFence[] = [];
  let open: Omit<CodeFence, "close"> | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (open === null) {
      const start = /^ {0,3}(`{3,})([^`]*)$/.exec(line);
      if (start) {
        const info = start[2].trim();
        const named = info === "" || FENCE_LANG.test(info);
        open = { open: i, ticks: start[1].length, lang: named ? info : "", lead: named ? "" : info };
      }
    } else {
      const end = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
      if (end && end[1].length >= open.ticks) {
        fences.push({ ...open, close: i });
        open = null;
      }
    }
  }
  if (open) fences.push({ ...open, close: null });
  return fences;
}

/** A text cut at its fences (#348): prose, and the code between them. */
export type PostPiece = { kind: "text"; text: string } | { kind: "code"; code: string; lang: string };

/**
 * A text as prose and code blocks (#348). The ``` lines themselves are not in
 * any piece: they are what the frame is drawn from. The line break on either
 * side of a block is the block's own edge, so a piece of prose does not carry
 * it. A text without a fence is one piece, itself.
 */
export function splitCodeFences(text: string): PostPiece[] {
  const lines = text.split("\n");
  const pieces: PostPiece[] = [];
  let from = 0;
  const prose = (to: number): void => {
    if (to > from) pieces.push({ kind: "text", text: lines.slice(from, to).join("\n") });
  };
  for (const fence of findCodeFences(lines)) {
    prose(fence.open);
    const end = fence.close ?? lines.length;
    const code = lines.slice(fence.open + 1, end).map((one) => one.replace(/\r$/, ""));
    // Words after the ``` that name no language are the code's first line (#352).
    if (fence.lead) code.unshift(fence.lead);
    pieces.push({ kind: "code", code: code.join("\n"), lang: fence.lang });
    from = fence.close === null ? lines.length : fence.close + 1;
  }
  prose(lines.length);
  return pieces;
}

/**
 * Whether a line is inside a fence (#348): from its opening line up to, not
 * including, its closing line; to the end when it is never closed.
 */
export function lineInFence(fences: CodeFence[], line: number): boolean {
  return fences.some((fence) => fence.open <= line && (fence.close === null || line < fence.close));
}

// ── colouring code (#354) ────────────────────────────────────────────────────

/** highlight.js's common set, through lowlight: what can be picked and detected. */
const lowlightCommon = createLowlight(common);

/**
 * Past this many characters, code with no language named is not guessed at:
 * a guess runs every language in the set over the whole text, and in the input
 * box it runs again on every key. Such code is drawn uncoloured. A named
 * language is still coloured at any length (AI 判断).
 */
const AUTO_DETECT_LIMIT = 5000;

/** What a too-long guess gives back: the code as one uncoloured run. */
function plainTree(value: string): ReturnType<typeof lowlightCommon.highlightAuto> {
  return { type: "root", children: [{ type: "text", value }], data: { language: undefined, relevance: 0 } };
}

/**
 * lowlight with the guess held to `AUTO_DETECT_LIMIT`. The input box's
 * colouring (the code-block-lowlight plugin) and the posts' (`highlightedCode`)
 * both go through this one, so the same code is coloured the same in both.
 * A guess that finds no language gives back no nodes at all, so that code is
 * drawn uncoloured too, not dropped (#362).
 */
const lowlight: typeof lowlightCommon = {
  ...lowlightCommon,
  highlightAuto: (value, options) => {
    if (value.length > AUTO_DETECT_LIMIT || !value.trim()) return plainTree(value);
    const tree = lowlightCommon.highlightAuto(value, options);
    return tree.data?.language ? tree : plainTree(value);
  },
};

/** One language that can be picked: its id, the name it is shown by, and what else it answers to. */
interface CodeLanguage {
  id: string;
  name: string;
  aliases: string[];
}

let languageList: CodeLanguage[] | null = null;

/**
 * Every language of the set, by name. Read once, from the grammars themselves:
 * a grammar is a function that, given highlight.js, answers its name and
 * aliases — calling it registers nothing.
 */
function codeLanguages(): CodeLanguage[] {
  if (!languageList) {
    languageList = Object.entries(common)
      .map(([id, grammar]) => {
        const info = grammar(hljs);
        return { id, name: info.name ?? id, aliases: (info.aliases ?? []).map((one) => one.toLowerCase()) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return languageList;
}

/** The name a language is shown by: `ts` and `typescript` are both TypeScript. Unknown, as written. */
export function codeLanguageName(lang: string): string {
  const key = lang.toLowerCase();
  const found = codeLanguages().find((one) => one.id === key || one.aliases.includes(key));
  return found?.name ?? lang;
}

/** The language a guess finds in `code`, by name, or "" when it finds none. */
function guessedLanguage(code: string): string {
  const id = lowlight.highlightAuto(code).data?.language;
  return id ? codeLanguageName(id) : "";
}

type HighlightNode = ReturnType<typeof lowlight.highlight>["children"][number];

/** One node of lowlight's tree as DOM: elements as classed spans, text as text. Never HTML. */
function highlightNode(node: HighlightNode): Node {
  if (node.type === "text") return document.createTextNode(node.value);
  if (node.type === "element") {
    const span = document.createElement("span");
    const classes = node.properties?.className;
    if (Array.isArray(classes)) span.className = classes.join(" ");
    for (const child of node.children) span.appendChild(highlightNode(child));
    return span;
  }
  return document.createTextNode("");
}

/**
 * A post's code block, coloured (#354): by the language its fence names when
 * the set knows it, and otherwise by a guess. Built from text nodes and spans,
 * so nothing in the code is read as HTML.
 */
export function highlightedCode(code: string, lang: string): Node[] {
  return highlightTree(code, lang).children.map(highlightNode);
}

/** The tree `highlightedCode` draws: the fence's language when known, else a guess. */
export function highlightTree(code: string, lang: string): ReturnType<typeof lowlight.highlight> {
  return lang && lowlight.registered(lang) ? lowlight.highlight(lang, code) : lowlight.highlightAuto(code);
}

// ── the document and its text ────────────────────────────────────────────────

const CODE = "codeBlock";
const PARAGRAPH = "paragraph";

/**
 * A text as the editor's document: each prose line a paragraph, each fence a
 * code block (its language when the fence names one). The reverse of
 * `textFromBlocks`. A fence nobody closed runs to the end, as it is drawn.
 */
export function docFromText(schema: Schema, text: string): PMNode {
  const blocks: PMNode[] = [];
  const line = (words: string): PMNode => schema.node(PARAGRAPH, null, words ? [schema.text(words)] : []);
  for (const piece of splitCodeFences(text.replace(/\r\n?/g, "\n"))) {
    if (piece.kind === "text") blocks.push(...piece.text.split("\n").map(line));
    else blocks.push(schema.node(CODE, { language: piece.lang || null }, piece.code ? [schema.text(piece.code)] : []));
  }
  if (!blocks.length) blocks.push(line(""));
  return schema.node("doc", null, blocks);
}

/**
 * A code block as a fence. The fence is longer than any line of the code that
 * would otherwise close it, so code holding a ``` line comes back out whole.
 */
function fenceText(code: string, language: string | null): string {
  let ticks = 3;
  for (const one of code.split("\n")) {
    const run = /^ {0,3}(`{3,})[ \t]*$/.exec(one);
    if (run && run[1].length >= ticks) ticks = run[1].length + 1;
  }
  const fence = "`".repeat(ticks);
  return `${fence}${language ?? ""}\n${code}\n${fence}`;
}

/** Blocks as the text the room is sent: a line per paragraph, a fence per code block. */
export function textFromBlocks(content: Fragment): string {
  const lines: string[] = [];
  content.forEach((block) => {
    lines.push(block.type.name === CODE ? fenceText(block.textContent, block.attrs.language) : block.textContent);
  });
  return lines.join("\n");
}

/**
 * What a copy out of the box puts on the clipboard as text. A piece of one
 * line or one block is its words, with no fence; across blocks, the text the
 * room would be sent.
 */
export function textFromSlice(slice: Slice): string {
  if (slice.content.childCount === 1 && slice.openStart > 0 && slice.openEnd > 0) {
    return slice.content.firstChild!.textContent;
  }
  return textFromBlocks(slice.content);
}

/**
 * Pasted text as the editor takes it: in a code block, the text itself; in
 * prose, read as `docFromText` reads it, so pasted fences arrive as code
 * blocks and blank lines are kept. Only the plain text is read, never the
 * clipboard's HTML.
 */
export function pasteText(state: EditorState, text: string): Transaction {
  const clean = text.replace(/\r\n?/g, "\n");
  if (state.selection.$from.parent.type.name === CODE) return state.tr.insertText(clean).scrollIntoView();
  const content = docFromText(state.schema, clean).content;
  // A prose line at either end joins the line the caret is on; a code block
  // there stands as a block of its own.
  const open = (block: PMNode | null): number => (block?.type.name === PARAGRAPH ? 1 : 0);
  const slice = new Slice(content, open(content.firstChild), open(content.lastChild));
  return state.tr.replaceSelection(slice).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste");
}

/** Whether the document is one empty line: the placeholder shows then. */
function isEmptyDoc(doc: PMNode): boolean {
  return doc.childCount === 1 && doc.firstChild!.type.name === PARAGRAPH && doc.firstChild!.content.size === 0;
}

// ── the keys (#354, after the Codex desktop app's input box) ─────────────────

type Dispatch = ((tr: Transaction) => void) | undefined;

/**
 * Shift+Enter: a new line. Inside a code block, a line of the code; in prose,
 * a new paragraph. It never leaves a block.
 */
export function lineBreak(state: EditorState, dispatch: Dispatch): boolean {
  if (state.selection.$from.parent.type.name === CODE) {
    dispatch?.(state.tr.insertText("\n").scrollIntoView());
    return true;
  }
  return splitBlock(state, dispatch);
}

/**
 * Down on a code block's last line: out of the block, onto the line below it,
 * made when there is none. `atBottom` answers whether the caret is on the
 * block's last line as drawn, wrapped lines counted.
 */
export function leaveCodeDown(state: EditorState, dispatch: Dispatch, atBottom: () => boolean): boolean {
  const { $head, empty } = state.selection;
  if (!empty || $head.parent.type.name !== CODE || !atBottom()) return false;
  const after = $head.after();
  if (dispatch) {
    const tr = state.tr;
    if (after < state.doc.content.size) {
      tr.setSelection(Selection.near(tr.doc.resolve(after)));
    } else {
      tr.insert(after, state.schema.nodes[PARAGRAPH].create());
      tr.setSelection(TextSelection.create(tr.doc, after + 1));
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * Up on the first line of the line right under a code block: back into the
 * block, at the end of its last line. Up on the first line of a code block
 * that opens the text makes the line above it, so there is always a way to
 * write before the code (AI 判断). `atTop` answers whether the caret is on
 * its block's first line as drawn.
 */
export function enterCodeUp(state: EditorState, dispatch: Dispatch, atTop: () => boolean): boolean {
  const { $head, empty } = state.selection;
  if (!empty) return false;
  const index = $head.index(0);
  if ($head.parent.type.name === CODE) {
    if (index !== 0 || !atTop()) return false;
    if (dispatch) {
      const tr = state.tr.insert(0, state.schema.nodes[PARAGRAPH].create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, 1)).scrollIntoView());
    }
    return true;
  }
  if (index === 0 || state.doc.child(index - 1).type.name !== CODE || !atTop()) return false;
  // The block above ends one position before this line opens.
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, $head.before() - 1)).scrollIntoView());
  return true;
}

/**
 * Backspace inside a code block.
 *
 * - The whole block empty: the block goes, and a plain empty line stands where
 *   it was.
 * - The caret on an empty last line: that line leaves the block and becomes
 *   the line under it, with the caret.
 * - The caret at the start of a block with code in it: the frame stays. An
 *   empty line just above is taken away, which pulls the code up; anything
 *   else above is left alone.
 *
 * Anything else is Backspace as usual. An empty line in the middle of the code
 * is deleted like any line break: leaving from there would cut the block in
 * two (AI 判断).
 */
export function backspaceInCode(state: EditorState, dispatch: Dispatch): boolean {
  const { $head, empty } = state.selection;
  if (!empty || $head.parent.type.name !== CODE) return false;
  const code = $head.parent.textContent;
  if (code === "") {
    dispatch?.(state.tr.setBlockType($head.pos, $head.pos, state.schema.nodes[PARAGRAPH]).scrollIntoView());
    return true;
  }
  const offset = $head.parentOffset;
  if (offset === code.length && code.endsWith("\n")) {
    if (dispatch) {
      // The block shrinks by the line break, so what was after it is one back.
      const at = $head.after() - 1;
      const tr = state.tr.delete($head.pos - 1, $head.pos);
      tr.insert(at, state.schema.nodes[PARAGRAPH].create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
    }
    return true;
  }
  if (offset === 0) {
    const index = $head.index(0);
    const above = index > 0 ? state.doc.child(index - 1) : null;
    if (above && above.type.name === PARAGRAPH && above.content.size === 0 && dispatch) {
      dispatch(state.tr.delete($head.before() - above.nodeSize, $head.before()).scrollIntoView());
    }
    return true;
  }
  return false;
}

// ── the language button and its list (#354) ──────────────────────────────────

interface LanguageMenu {
  root: HTMLElement;
  search: HTMLInputElement;
  list: HTMLUListElement;
}

let menu: LanguageMenu | null = null;
/** The open list's picks, in the order drawn, the highlighted one, and what a pick does. */
let menuItems: { id: string | null; name: string }[] = [];
let menuActive = 0;
let menuPick: ((id: string | null) => void) | null = null;
let menuCancel: (() => void) | null = null;
/** The language of the block the list was opened for, marked in the list. */
let menuCurrent: string | null = null;

const AUTO_NAME = "自動";

function closeLanguageMenu(): void {
  if (!menu || menu.root.hidden) return;
  menu.root.hidden = true;
  menuPick = null;
  menuCancel = null;
}

function renderLanguageMenu(): void {
  if (!menu) return;
  const query = menu.search.value.trim().toLowerCase();
  const matches = (one: CodeLanguage): boolean =>
    one.name.toLowerCase().includes(query) || one.id.includes(query) || one.aliases.some((alias) => alias.includes(query));
  menuItems = [
    ...(query === "" ? [{ id: null, name: AUTO_NAME }] : []),
    ...codeLanguages().filter(matches),
  ];
  menuActive = Math.min(menuActive, Math.max(0, menuItems.length - 1));
  menu.list.replaceChildren(
    ...menuItems.map((one, at) => {
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(at === menuActive));
      if (one.id === menuCurrent) item.dataset.current = "";
      item.textContent = one.name;
      // mousedown rather than click, so the search keeps its focus until the pick.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        pickLanguage(at);
      });
      return item;
    }),
  );
  if (!menuItems.length) {
    const none = document.createElement("li");
    none.className = "none";
    none.textContent = "見つかりません";
    menu.list.appendChild(none);
  }
  menu.list.children[menuActive]?.scrollIntoView({ block: "nearest" });
}

function pickLanguage(at: number): void {
  const one = menuItems[at];
  const pick = menuPick;
  if (!one || !pick) return;
  closeLanguageMenu();
  pick(one.id);
}

/** The list, made once and kept in the page; hidden while closed. */
function languageMenu(): LanguageMenu {
  if (menu) return menu;
  const root = document.createElement("div");
  root.className = "lang-menu";
  root.hidden = true;
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "言語を検索";
  search.setAttribute("aria-label", "言語を検索");
  search.spellcheck = false;
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "言語");
  root.append(search, list);
  document.body.appendChild(root);
  search.addEventListener("input", () => {
    menuActive = 0;
    renderLanguageMenu();
  });
  search.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const count = menuItems.length;
    switch (event.key) {
      case "ArrowDown":
        if (count) menuActive = (menuActive + 1) % count;
        renderLanguageMenu();
        break;
      case "ArrowUp":
        if (count) menuActive = (menuActive - 1 + count) % count;
        renderLanguageMenu();
        break;
      case "Enter":
        pickLanguage(menuActive);
        break;
      case "Escape": {
        const cancel = menuCancel;
        closeLanguageMenu();
        cancel?.();
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    // Esc here is the list's, not a dialog's or the window's.
    event.stopPropagation();
  });
  // A press anywhere else closes it, as leaving the search does.
  document.addEventListener("mousedown", (event) => {
    if (!root.contains(event.target as Node)) closeLanguageMenu();
  });
  search.addEventListener("blur", () => closeLanguageMenu());
  menu = { root, search, list };
  return menu;
}

/**
 * Open the list against a code block's button: a search over the set's
 * languages, 自動 first. Opens above the button, where the room is, unless
 * there is too little room above.
 */
function openLanguageMenu(
  anchor: HTMLElement,
  current: string | null,
  pick: (id: string | null) => void,
  cancel: () => void,
): void {
  const { root, search } = languageMenu();
  menuCurrent = current;
  menuPick = pick;
  menuCancel = cancel;
  search.value = "";
  menuActive = 0;
  renderLanguageMenu();
  root.hidden = false;
  const box = anchor.getBoundingClientRect();
  root.style.left = `${Math.max(4, box.left)}px`;
  if (box.top > root.offsetHeight + 8) {
    root.style.top = "";
    root.style.bottom = `${window.innerHeight - box.top + 4}px`;
  } else {
    root.style.bottom = "";
    root.style.top = `${box.bottom + 4}px`;
  }
  search.focus();
}

/**
 * A code block in the box: its language button over the code, and the code.
 * The button says 自動 with what the guess found, or the language picked; the
 * code is ProseMirror's to edit and the colouring plugin's to colour.
 */
function codeBlockView({ node, getPos, editor }: NodeViewRendererProps): NodeView {
  const dom = document.createElement("div");
  dom.className = "code-block";
  const head = document.createElement("div");
  head.className = "code-head";
  head.contentEditable = "false";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "code-lang-button";
  button.title = "言語を選ぶ";
  head.appendChild(button);
  const pre = document.createElement("pre");
  pre.spellcheck = false;
  const code = document.createElement("code");
  pre.appendChild(code);
  dom.append(head, pre);

  let current = node;
  let guessed = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const label = (): void => {
    const language: string | null = current.attrs.language;
    button.textContent = language ? codeLanguageName(language) : guessed ? `${AUTO_NAME}（${guessed}）` : AUTO_NAME;
  };
  // The guess is redone a moment after the typing stops, not on every key.
  const guess = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      guessed = current.attrs.language ? "" : guessedLanguage(current.textContent);
      label();
    }, 300);
  };
  // Pressed without taking the focus, so the caret stays in the code.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    openLanguageMenu(
      button,
      current.attrs.language ?? null,
      (id) => {
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor
          .chain()
          .command(({ tr }) => {
            // A markup change over the whole block, so the colouring plugin
            // reads it as the block changing and colours it again.
            tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: id });
            return true;
          })
          .focus()
          .run();
      },
      () => editor.commands.focus(),
    );
  });
  label();
  guess();

  return {
    dom,
    contentDOM: code,
    update(next) {
      if (next.type !== current.type) return false;
      const changed = next.attrs.language !== current.attrs.language || next.textContent !== current.textContent;
      current = next;
      if (changed) {
        label();
        guess();
      }
      return true;
    },
    // The button is the view's own; ProseMirror neither reads its changes nor takes its presses.
    ignoreMutation: (mutation) => mutation.type !== "selection" && head.contains(mutation.target),
    stopEvent: (event) => head.contains(event.target as Node),
    destroy: () => clearTimeout(timer),
  };
}

// ── the editor ───────────────────────────────────────────────────────────────

/** What the screen does when the box asks. */
export interface ComposerHooks {
  /** Enter: send. */
  onSubmit(): void;
  /** Every key first, before the box's own; true when the key was taken (the `@` list's). */
  onKeyDown(event: KeyboardEvent): boolean;
  /** The text or the caret moved. */
  onChange(): void;
  onBlur(): void;
  /** Ctrl+V of files with no text beside them. */
  onPasteFiles(files: FileList): void;
}

/**
 * The code block (#354): coloured by lowlight, entered by typing ``` at the
 * start of a line — the backticks go and the line becomes the block — and
 * drawn with its language button. Its keys are `composerKeys`'s, so the
 * extension's own (Tab, triple Enter, the arrows' exits) are not taken on.
 */
const CodeBlock = CodeBlockLowlight.extend({
  addInputRules() {
    return [textblockTypeInputRule({ find: /^```$/, type: this.type })];
  },
  addKeyboardShortcuts() {
    return {};
  },
  addNodeView() {
    return codeBlockView;
  },
}).configure({ lowlight, exitOnTripleEnter: false, exitOnArrowDown: false, exitOnArrowUp: false });

/** The box's keys, ahead of every other extension's (`priority`). Enter is `handleKeyDown`'s. */
const composerKeys = Extension.create({
  name: "composerKeys",
  priority: 1000,
  addKeyboardShortcuts() {
    const view = () => this.editor.view;
    const run = (command: (state: EditorState, dispatch: Dispatch) => boolean): boolean =>
      command(view().state, view().dispatch);
    return {
      "Shift-Enter": () => run(lineBreak),
      ArrowDown: () => run((state, dispatch) => leaveCodeDown(state, dispatch, () => view().endOfTextblock("down"))),
      ArrowUp: () => run((state, dispatch) => enterCodeUp(state, dispatch, () => view().endOfTextblock("up"))),
      Backspace: () => run(backspaceInCode),
    };
  },
});

/** Every extension the box is made of. Its schema is readable without a page (`composerSchema`). */
function composerExtensions(): AnyExtension[] {
  return [Document, Paragraph, Text, CodeBlock, UndoRedo, composerKeys];
}

/** The box's schema, for reading text into its document away from the page. */
export function composerSchema(): Schema {
  return getSchema(composerExtensions());
}

/** The input box as the screen uses it. Positions are the document's. */
export interface Composer {
  /** The text as the room is sent it. */
  text(): string;
  /** Replace everything with `text`, read as `docFromText` reads it; the caret at the end. Not an undo step. */
  setText(text: string): void;
  focus(): void;
  /** The selection, and the caret's line up to its start: where an `@` is looked for. */
  selection(): { from: number; to: number; lineStart: number; before: string };
  /** Put `text` over `from`..`to`, the caret after it. */
  replace(from: number, to: number, text: string): void;
}

/**
 * Make the input box inside `element`. The element carries the room's font
 * size and the placeholder (`data-placeholder`, shown while `data-empty`).
 */
export function createComposer(element: HTMLElement, hooks: ComposerHooks): Composer {
  const editor = new Editor({
    element,
    extensions: composerExtensions(),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": element.dataset.placeholder ?? "",
      },
      handleKeyDown: (_view, event) => {
        if (hooks.onKeyDown(event)) return true;
        // Enter sends wherever the caret is, in code too. Not while an IME is
        // composing: that Enter is the conversion's.
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          hooks.onSubmit();
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!data) return false;
        // Only when the clipboard holds no plain text: what Excel or a browser
        // copies carries a picture of the selection beside its text, and a
        // paste of those is a paste of the text (#223).
        if (data.files.length && !data.types.includes("text/plain")) {
          hooks.onPasteFiles(data.files);
          return true;
        }
        const text = data.getData("text/plain");
        if (!text) return false;
        // From VS Code into prose: the extension's own paste makes it a code
        // block in VS Code's language.
        if (data.types.includes("vscode-editor-data") && view.state.selection.$from.parent.type.name !== CODE) {
          return false;
        }
        view.dispatch(pasteText(view.state, text));
        return true;
      },
      clipboardTextSerializer: (slice) => textFromSlice(slice),
    },
  });
  const markEmpty = (): void => {
    element.toggleAttribute("data-empty", isEmptyDoc(editor.state.doc));
  };
  markEmpty();
  editor.on("update", () => {
    markEmpty();
    hooks.onChange();
  });
  editor.on("selectionUpdate", () => hooks.onChange());
  editor.on("blur", () => hooks.onBlur());

  return {
    text: () => textFromBlocks(editor.state.doc.content),
    setText(text) {
      const { state } = editor;
      const doc = docFromText(state.schema, text);
      const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
      tr.setSelection(Selection.atEnd(tr.doc)).setMeta("addToHistory", false);
      editor.view.dispatch(tr);
    },
    focus: () => {
      editor.commands.focus();
    },
    selection() {
      const { from, to, $from } = editor.state.selection;
      return { from, to, lineStart: $from.start(), before: $from.parent.textBetween(0, $from.parentOffset) };
    },
    replace(from, to, text) {
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.insertText(text, from, to);
          tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          return true;
        })
        .run();
    },
  };
}
