export function sections(text) {
  const lines = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    lines.push({ text: line.replace(/\r?\n$/, ""), offset });
    offset += line.length;
  }
  const headings = [];
  let fence = null,
    priorEligible = false;
  for (let i = 0; i < lines.length; i++) {
    const { text: t, offset } = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(t);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.len &&
        marker[2].trim() === ""
      )
        fence = null;
      priorEligible = false;
      continue;
    }
    if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = { char: marker[1][0], len: marker[1].length };
      priorEligible = false;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:\s+|$)(.*)$/.exec(t);
    if (atx) {
      headings.push({
        offset,
        level: atx[1].length,
        title: atx[2].replace(/\s+#+\s*$/, ""),
      });
      priorEligible = false;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)\s*$/.exec(t);
    if (setext && priorEligible) {
      const prev = lines[i - 1];
      headings.push({
        offset: prev.offset,
        level: setext[1][0] === "=" ? 1 : 2,
        title: prev.text.trim(),
      });
      priorEligible = false;
      continue;
    }
    priorEligible =
      t.trim() !== "" &&
      !/^ {4}|^\t|^ {0,3}>|^ {0,3}(?:[-+*]|\d+[.)])\s/.test(t);
  }
  const starts = [{ offset: 0, level: 0, title: "preamble" }, ...headings];
  return starts.map((s, i) => ({
    ...s,
    end: i + 1 < starts.length ? starts[i + 1].offset : text.length,
    length_utf16:
      (i + 1 < starts.length ? starts[i + 1].offset : text.length) - s.offset,
  }));
}
