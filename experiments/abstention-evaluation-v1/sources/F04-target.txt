
import type { SessionStats, SessionView, RowWord } from "./contracts";


/**
 * Whether the account behind this report has a rate-limit window that is full
 * (#161).
 *
 * Either window is enough, and neither is weighted against the other: a session
 * that cannot spend against its five-hour window is stopped whether or not its
 * week has room, and the other way round (決定1).
 *
 * `>=` rather than `===`, because a spend limit may report past 100% (決定7;
 * the docs line is the issue's citation, not one read here). A window the CLI
 * did not report is not a window at 0: null is absent, and an absent window
 * says nothing either way — the same line the panel's `—` stands on.
 *
 * Read off the last report and nothing else, which is what makes the word clear
 * itself: the next report carrying a lower percentage is the word going away,
 * with no edge to catch and no burst to wait for (決定2). What it costs is what
 * 決定4 accepted — a report arrives only while the session is moving, so an
 * account that stopped and then hit its limit says nothing until it moves
 * again, and one whose limit has lifted keeps the word until then.
 */
export function limitedByUsage(stats: SessionStats | null): boolean {
  if (!stats) return false;
  // A Codex seat: the app's word, not the percentages, which were seen stuck
  // at 99 for a seat that had stopped (#294).
  if (stats.limited !== null && stats.limited !== undefined) return stats.limited;
  return (stats.five_hour ?? 0) >= 100 || (stats.seven_day ?? 0) >= 100;
}


/**
 * What a running account is doing, in the one word the row has room for.
 *
 * 考え中… when the room is waiting on this name, 出力中 otherwise, and 待機 once
 * the terminal has been silent for a whole quiet window (#148).
 *
 * 待機 says that the terminal is silent and nothing more. A CLI waiting for input
 * and one stopped at a confirmation prompt both read as 待機 — telling them apart
 * means reading what the CLI printed, which #82 refused and #148 keeps refused.
 * It is left uncoloured: the coloured words are the ones that say an utterance is
 * still under way, and 待機 is where that ends.
 *
 * 制限中 is the one silence that is told apart, and it is told apart without
 * reading anything: the CLI's own status line reports its rate-limit
 * percentages, and 100% of either window is the limit (`limitedByUsage`, #161).
 * The word says that the account's window is full, which is narrower than
 * "cannot run" and wider than the turn-level signal it replaced. It stays
 * uncoloured beside 待機 for the same reason.
 *
 * The order is not a preference between two equal signals. Both words stand on
 * the same observation — this terminal is printing — and the address is what says
 * why: the account owes the room an answer and has not given it. That is strictly
 * more than the other word says, so a row that could say both says that one.
 *
 * 出力中 rather than 動作中 for what is left. What was observed is that bytes
 * arrived, and a CLI repainting the prompt it is waiting at is producing output
 * without doing any work — 動作中 would be a claim about the CLI that this screen
 * has no way to check, and it would be wrong in exactly the case the issue
 * measured on the device (an `Enter to confirm` prompt). Both words are three
 * characters or so, inside the width 起動失敗 already costs the name beside it,
 * so neither buys anything back at the panel's 16.5rem (#71).
 *
 * A Codex seat launched through its own app-server reports more, and that
 * report comes first (#326): 許可待ち and 答え待ち, and the kind of work under
 * way (実行中, 編集中, ツール…). It does not reopen #82 — nothing is read off
 * the terminal; the server sends the state as data, the way 制限中 arrives. Its
 * badge words stay within 起動失敗's four characters; the longer form, with a
 * tool's name, is the badge's title and what the line under the room says.
 *
 * A Claude Code seat reports through its hooks the same way (#331): 許可待ち,
 * ツール with the tool's name, and 委任中 for a running subagent, in that order.
 * It has no thread status, so with no word the terminal's words stand.
 *
 * The same seat's thread status settles 待機 (#329). A connected seat whose
 * thread its server says is idle is 待機 (制限中 when limited) whatever the
 * terminal does: a TUI that keeps repainting kept the row at 出力中 with
 * nothing running. An active thread with no word — reasoning, writing the
 * answer — keeps the terminal's words, as before. A confirmed Claude parent rejection comes first (#342).
 * Otherwise the order, top first: the report's word (許可待ち / 答え待ち,
 * then the kind of work), idle → 制限中 / 待機, 考え中… / 出力中, 制限中,
 * 様子不明, 待機 from the terminal's silence.
 */
export function activityNote(view: SessionView | undefined, awaitingReply = false): RowWord {
  if (!view || view.ended !== null) return NO_WORD;
  // A seat's own report — a Codex app-server seat's (#326), a Claude Code
  // seat's hooks (#331) — outranks the screen's. It is
  // structured, not read off the terminal, and it says more: 許可待ち where the
  // terminal repainting its prompt would say 出力中 and its silence 待機, and
  // which work is under way where the bytes would say only that they arrived.
  // Confirmed parent rejection outranks leftover delegation and PTY repaint (#342).
  // So does a Codex seat the app found stopped at its usage limit (#372): the
  // server says systemError there, not idle, so the idle rule below does not
  // hold the TUI's repaint back.
  const limitedSource = view.stats?.limited_source;
  if ((limitedSource === "claude-parent" || limitedSource === "codex") && view.stats?.limited === true) return { word: "制限中", line: "制限中", kind: "" };
  const reported = view.activity;
  if (reported?.word) {
    return {
      word: reported.word,
      line: reported.line ?? reported.word,
      kind: reported.waiting ? "waiting" : "active",
    };
  }
  // The server says the thread is idle (#329): the terminal's bytes are a
  // repaint, not work, so they are not read. 制限中 still says which idle.
  if (reported?.connected && reported.thread_status === "idle") {
    if (limitedByUsage(view.stats)) return { word: "制限中", line: "制限中", kind: "" };
    return { word: "待機", line: "待機", kind: "" };
  }
  if (view.outputting) {
    const word = awaitingReply ? "考え中…" : "出力中";
    return { word, line: word, kind: "active" };
  }
  // 制限中 over 待機, because it says what 待機 cannot: which of the silences
  // this is (#161, 決定6, carried over from #149). It loses to the two words
  // above for the same reason 待機 does — output arriving is this screen's own
  // observation of a session that is going again.
  if (limitedByUsage(view.stats)) return { word: "制限中", line: "制限中", kind: "" };
  // The seat's server can no longer be heard (#326). Not 待機: the silence
  // of the terminal says nothing about whether the seat is waiting on a
  // prompt or running a command, and the report that would have said so is
  // gone. Below the words above, which are observed by other means.
  if (reported && !reported.connected) {
    return { word: "様子不明", line: "様子不明（app-server との接続が切れた）", kind: "" };
  }
  return view.silent ? { word: "待機", line: "待機", kind: "" } : NO_WORD;
}


export function statsForView(stats: SessionStats, view: SessionView): boolean {
  return stats.pty_id == null || (stats.pty_id === view.ptyId && view.ended === null);
}


export const NO_WORD: RowWord = { word: "", line: "", kind: "" };
