

export interface Dependencies {
  roomEl: HTMLElement;
  inputEl: HTMLElement;
  participantsEl: HTMLElement;
  syncScrollLatest: () => void;
  setTerminalFontSize: (size: number) => void;
  fitTerminal: () => void;
}

export function createDisplaySettings(deps: Dependencies) {

  /**
   * How large the conversation is drawn, in `rem`.
   *
   * In `localStorage` beside the key above, and for the same reason: this is a
   * property of the screen being read from, not of anybody in the room. Two
   * people reading one conversation do not have to want the same size, and a
   * size carried on a participant would make the answer travel with whoever
   * declared it. It is the shape #40 settled for a screen's own settings.
   *
   * Not a participant attribute in the other sense either: nothing here is
   * written per speaker. Every line in the room is drawn at one size, whoever
   * said it (#39).
   */
  const ROOM_FONT_SIZE_KEY = "pullcept.room-font-size";

  /**
   * The sizes the conversation can be set to, in `rem`.
   *
   * A list rather than a continuous range, like the hues below: what this has to
   * buy is a readable size that fits, and a ladder buys it without asking anyone
   * to judge fractions of a millimetre. The ends of the list are the bounds —
   * there is no size off the ladder to clamp, so nothing separate enforces them.
   *
   * The rungs are dense below the default and sparse above it. The observation
   * this comes from is that the room reads large (#60), so the direction that
   * gets used is downward and the steps there are the ones worth being fine.
   */
  const ROOM_FONT_SIZES = [0.7, 0.75, 0.8, 0.85, 0.9, 1, 1.1, 1.25, 1.4, 1.6];

  /**
   * Where a screen that has never chosen sits.
   *
   * `1rem`, which is what the room already rendered at: `.message .body` is
   * given no size and inherits none, so the surface has been showing the user
   * agent's default. Keeping it is a completion condition of #60 — this change
   * adds the means to move, and moves nobody.
   */
  const DEFAULT_ROOM_FONT_SIZE = 1;

  /**
   * The keys that move along the ladder, and by how far.
   *
   * `Ctrl` with `=` / `-` / `0`, the combination browsers and editors have
   * trained. Both faces of the shifted keys are listed because a keyboard that
   * needs `Shift` for `+` reports `+`, and one that does not reports `=`; the
   * person pressing them is doing the same thing either way. `0` is the reset
   * and carries a step of zero, so the lookup below tests for `undefined` rather
   * than for falsity.
   */
  const ROOM_FONT_SIZE_KEYS: Record<string, number> = {
    "=": 1,
    "+": 1,
    "-": -1,
    "_": -1,
    "0": 0,
  };

  /** The size the conversation is currently drawn at, in `rem`. */
  let roomFontSize = DEFAULT_ROOM_FONT_SIZE;

  /**
   * How large a terminal is drawn, in `px`.
   *
   * The third size axis and an independent one: the conversation (#60), this, and
   * the whole UI (#66) are three separate answers, and none of them is expressed
   * relative to another. What makes this one different in kind from #60 is that it
   * is not only a display size — xterm.js computes the session's columns and rows
   * from it, so moving it changes the window the CLI is drawing for.
   *
   * `localStorage` and not the config, for #60's reason: it is a property of the
   * screen being read from rather than of anybody in the room.
   */
  const TERMINAL_FONT_SIZE_KEY = "pullcept.terminal-font-size";

  /**
   * The sizes a terminal can be set to, in `px`.
   *
   * A ladder with its ends as the bounds, the shape #60 settled for the
   * conversation: there is no size off the ladder to clamp, so nothing separate
   * enforces the limits.
   *
   * In `px` and labelled in `px`, where #60 labels a proportion. The two are
   * asked different questions. A conversation is read against nothing in
   * particular, so "larger or smaller than what I have" is the whole of it; a
   * terminal is read against the CLI's own layout, and the number that decides how
   * many columns fit is this one. It is also the unit xterm takes.
   *
   * Spread evenly rather than dense at one end. #60's rungs lean downward because
   * the observation behind it was that the room reads large; nothing says which
   * direction this one gets used in, and inventing a lean would be answering a
   * question nobody has asked yet.
   */
  const TERMINAL_FONT_SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20, 24];

  /**
   * Where a screen that has never chosen sits.
   *
   * `13px`, which is what every terminal has been opened at. Keeping it is the
   * same completion condition #60 had: this adds the means to move, and moves
   * nobody.
   */
  const DEFAULT_TERMINAL_FONT_SIZE = 13;

  /**
   * How large everything but the conversation and the terminal is drawn, as a
   * multiple of what it has always been (#66, #194).
   *
   * The third of the three size axes. It is carried as the root's `font-size`,
   * because the UI around the two other surfaces is written in `rem` — the title
   * bar, the panels, the windows — so one value on `:root` moves all of it without
   * naming any of it. The two other axes are kept out by construction rather than
   * by exception: the conversation's size divides this one back out
   * (`--room-font-size` in src/styles.css), and the terminal is sized in `px`,
   * which a root size does not reach. Not the webview's own zoom: that takes the
   * whole screen, the two excluded surfaces with it, and those are what this may
   * not move.
   *
   * `localStorage`, for #60's reason: a property of the screen being read from.
   */
  const UI_SCALE_KEY = "pullcept.ui-scale";

  /**
   * The multiples the UI can be set to.
   *
   * A ladder with its ends as the bounds, the shape #60 settled. More rungs above
   * the default than below: what #66 asks for is a screen that reads from further
   * away, so the direction that gets used is upward.
   *
   * The top is `1.5` because the panels grow with it. They are written in `rem`,
   * and the conversation between them takes what is left: at `1.5` two open panels
   * already leave almost nothing of a 900px window. Past that the ladder would
   * mostly offer ways to lose the room.
   */
  const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];

  /** `1`, which is what every screen has been drawn at. It moves nobody. */
  const DEFAULT_UI_SCALE = 1;

  /**
   * Fill the text size picker.
   *
   * Labelled as a proportion of the default rather than in `rem`, because the
   * choice being made is "larger or smaller than what I have", and the unit the
   * size happens to be held in answers a question nobody is asking.
   */
  function fillRoomFontSizes(select: HTMLSelectElement): void {
    for (const size of ROOM_FONT_SIZES) {
      const option = document.createElement("option");
      option.value = String(size);
      option.textContent = `${Math.round((size / DEFAULT_ROOM_FONT_SIZE) * 100)}%`;
      select.appendChild(option);
    }
  }

  /**
   * The stored size, or the default.
   *
   * Only a size that is on the ladder is honoured. What is in `localStorage` was
   * written by some version of this app and can be anything — a rung that a
   * later version dropped, a value left by hand, or nothing at all — and the
   * failure it would cause is silent: a size off the ladder cannot be stepped
   * from, so the keys and the picker would both stop working with nothing on
   * screen saying why.
   */
  function storedRoomFontSize(): number {
    const stored = Number(localStorage.getItem(ROOM_FONT_SIZE_KEY));
    return ROOM_FONT_SIZES.includes(stored) ? stored : DEFAULT_ROOM_FONT_SIZE;
  }

  /**
   * Draw the conversation at `size`, and remember it if it was chosen.
   *
   * The property goes on the two elements that render the conversation's words —
   * `#room` and the composer's text (`#input`) — and on one element besides, the
   * participant panel, for its circle alone (below). What is typed is
   * the same sentence that is then read, so the two move together (#81). Their
   * nearest shared ancestor is `#conversation`, which also holds the diagnostics
   * pane and the status line; setting it there, or on the root, would reach
   * surfaces that are not on this axis, and the terminal computes its columns and
   * rows from its own size. Two `setProperty` calls make the scope the placement
   * itself, so nothing has to be cancelled anywhere.
   *
   * The row under the text — 宛先, the keys, 送信 (#222) — and the list `@` opens
   * sit in the composer but do not follow. They are controls, not the sentence,
   * and they stay on the whole-UI axis (#66, #204).
   *
   * The participant panel takes the property too (#260), and only its circle
   * reads it there: that circle is sized against the room's circle (#258), so it
   * has to move with the same size. The panel's text and controls stay on the
   * whole-UI axis.
   *
   * `save` is false for the restore at startup. Writing the value back there
   * would put a size in storage for a screen that never chose one, which is the
   * one state this is supposed to leave alone.
   */
  function applyRoomFontSize(size: number, save: boolean): void {
    roomFontSize = size;
    // Divided by the UI's multiple, so the size is this axis's alone: the root a
    // `rem` is counted from is what the UI scale moves (#194), and dividing it back
    // out is what keeps the two axes from riding on each other.
    const value = `calc(${size}rem / var(--ui-scale))`;
    deps.roomEl.style.setProperty("--room-font-size", value);
    deps.inputEl.style.setProperty("--room-font-size", value);
    deps.participantsEl.style.setProperty("--room-font-size", value);
    // The lines change height with the size, and so does the distance to the foot.
    deps.syncScrollLatest();
    // Kept in step with the keys, which move the size without the picker.
    settingsRoomFontSizeEl.value = String(size);
    if (save) localStorage.setItem(ROOM_FONT_SIZE_KEY, String(size));
  }

  /**
   * Move one rung, or back to the default when `step` is zero.
   *
   * The ends hold: stepping past either one lands on it again, so there is no
   * size to reach that cannot be read or does not fit.
   */
  function stepRoomFontSize(step: number): void {
    if (step === 0) {
      applyRoomFontSize(DEFAULT_ROOM_FONT_SIZE, true);
      return;
    }
    const at = ROOM_FONT_SIZES.indexOf(roomFontSize);
    const next = Math.min(Math.max(at + step, 0), ROOM_FONT_SIZES.length - 1);
    applyRoomFontSize(ROOM_FONT_SIZES[next], true);
  }

  /** Fill a terminal size picker. Labelled in `px`; see the ladder above. */
  function fillTerminalFontSizes(select: HTMLSelectElement): void {
    for (const size of TERMINAL_FONT_SIZES) {
      const option = document.createElement("option");
      option.value = String(size);
      option.textContent = `${size}px`;
      select.appendChild(option);
    }
  }

  /**
   * The stored terminal size, or the default.
   *
   * Only a size on the ladder is honoured, for the reason `storedRoomFontSize`
   * gives: a value off it cannot be stepped from, so the picker would stop working
   * with nothing on screen saying why.
   */
  function storedTerminalFontSize(): number {
    const stored = Number(localStorage.getItem(TERMINAL_FONT_SIZE_KEY));
    return TERMINAL_FONT_SIZES.includes(stored) ? stored : DEFAULT_TERMINAL_FONT_SIZE;
  }

  /**
   * Draw every terminal at `size`, and remember it if it was chosen.
   *
   * Every one, not only the one on the glass. The size is the screen's, so a pane
   * switched to later must not be the odd one out; and a terminal opened after
   * this reads the same value (`openView`).
   *
   * The re-fit that follows only reaches the shown pane, which is the same limit
   * `fitShown` has always had — a hidden container has no size to measure against.
   * The others are laid out when they are next shown, because `showView` fits what
   * it puts on the glass. Their sessions are told the new column count at that
   * moment rather than this one.
   *
   * `save` is false for the restore at startup, so a screen that never chose is
   * not given a stored size by being opened.
   */
  function applyTerminalFontSize(size: number, save: boolean): void {
    deps.setTerminalFontSize(size);
    settingsTerminalFontSizeEl.value = String(size);
    if (save) localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(size));
    deps.fitTerminal();

  }

  /** Fill the UI scale picker. Labelled as a percentage, as #60's is. */
  function fillUiScales(): void {
    for (const scale of UI_SCALES) {
      const option = document.createElement("option");
      option.value = String(scale);
      option.textContent = `${Math.round((scale / DEFAULT_UI_SCALE) * 100)}%`;
      settingsUiScaleEl.appendChild(option);
    }
  }

  /**
   * The stored UI scale, or the default. Only a rung on the ladder is honoured,
   * for the reason `storedRoomFontSize` gives.
   */
  function storedUiScale(): number {
    const stored = Number(localStorage.getItem(UI_SCALE_KEY));
    return UI_SCALES.includes(stored) ? stored : DEFAULT_UI_SCALE;
  }

  /**
   * Draw the UI at `scale`, and remember it if it was chosen.
   *
   * One property on `:root`, which src/styles.css turns into the root's
   * `font-size`. The conversation divides it back out and the terminal is in `px`,
   * so neither moves (see `UI_SCALE_KEY`). The terminal's pane does change size
   * when the chrome around it grows, and the `ResizeObserver` on it re-fits and
   * tells the session, as it does for any other change to the pane's size.
   *
   * `save` is false for the restore at startup, as for the two other axes.
   */
  function applyUiScale(scale: number, save: boolean): void {
    document.documentElement.style.setProperty("--ui-scale", String(scale));
    settingsUiScaleEl.value = String(scale);
    if (save) localStorage.setItem(UI_SCALE_KEY, String(scale));
  }

  const openSettingsEl = document.getElementById("open-settings") as HTMLButtonElement;

  const settingsDialogEl = document.getElementById("settings-dialog") as HTMLDialogElement;

  const settingsCloseEl = document.getElementById("settings-close") as HTMLButtonElement;

  // The display section's three pickers (#194), the only on-screen controls for
  // the three sizes since the title bar's and the terminal header's were taken
  // out (#209).
  const settingsRoomFontSizeEl = document.getElementById(
    "settings-room-font-size",
  ) as HTMLSelectElement;

  const settingsTerminalFontSizeEl = document.getElementById(
    "settings-terminal-font-size",
  ) as HTMLSelectElement;

  const settingsUiScaleEl = document.getElementById("settings-ui-scale") as HTMLSelectElement;
  function initialize(): void {
    fillUiScales();
    applyUiScale(storedUiScale(), false);
    settingsUiScaleEl.addEventListener("change", () => {
      applyUiScale(Number(settingsUiScaleEl.value), true);
    });
    fillRoomFontSizes(settingsRoomFontSizeEl);
    applyRoomFontSize(storedRoomFontSize(), false);
    settingsRoomFontSizeEl.addEventListener("change", () => {
      applyRoomFontSize(Number(settingsRoomFontSizeEl.value), true);
    });
    // On the window rather than on the room: the keys are meant to work while
    // something is being typed, and the room is not what holds focus then.
    window.addEventListener("keydown", (event) => {
      if (!event.ctrlKey || event.altKey || event.isComposing) return;
      const step = ROOM_FONT_SIZE_KEYS[event.key];
      if (step === undefined) return;
      // Load-bearing, not tidiness: the webview answers these same keys with its
      // own zoom, which takes the whole screen — the terminal, the panel, and the
      // composer's own controls along with its text. Scaling those is the one
      // thing this control may not do, so the default has to be stopped for the
      // scoped version to be what happens.
      event.preventDefault();
      stepRoomFontSize(step);
    });

    // Restored before any terminal is opened, so the first session is laid out at
    // the size this screen reads at rather than being re-fitted once it lands.
    fillTerminalFontSizes(settingsTerminalFontSizeEl);
    applyTerminalFontSize(storedTerminalFontSize(), false);
    settingsTerminalFontSizeEl.addEventListener("change", () => {
      applyTerminalFontSize(Number(settingsTerminalFontSizeEl.value), true);
    });

  }
  function wireDialog(): void {
    openSettingsEl.addEventListener("click", () => {
      if (!settingsDialogEl.open) settingsDialogEl.showModal();
    });
    settingsCloseEl.addEventListener("click", () => settingsDialogEl.close());

  }
  return { initialize, wireDialog };
}
