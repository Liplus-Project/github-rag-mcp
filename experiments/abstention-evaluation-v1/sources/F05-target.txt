//! What a link in a room post may open, and how (#349).
//!
//! The screen draws the URLs and the Windows paths a post's words carry as
//! links, and a press on one comes here before anything is opened. The screen's
//! reading is a reading of the text and not the guard: a post is written by
//! anyone in the room, so what is opened is decided again on this side.
//!
//! - A URL opens in the default browser only when it is `http://` or
//!   `https://`. Any other scheme (`file:`, `javascript:` and the rest) opens
//!   nothing.
//! - A path is a drive path (`C:\…`, `D:/…`) or a UNC path (`\\server\share\…`)
//!   and nothing else: no relative path, no device or verbatim path (`\\.\…`,
//!   `\\?\…`).
//! - A folder opens in Explorer. A file opens in the app its type opens with,
//!   unless opening it would run it — a program, a script, an installer, a
//!   shortcut: that file is shown selected in its folder instead.
//! - A path that is not there opens nothing and says 見つかりません.

use std::io::ErrorKind;
use std::path::Path;

/// What pressing a path does, decided from what is at it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathAction {
    /// A folder, opened in Explorer.
    OpenFolder,
    /// A file, opened in the app its type opens with.
    OpenFile,
    /// A file that opening would run, shown selected in its folder instead.
    Reveal,
}

/// The extensions whose file runs, installs, mounts or changes the system when
/// it is opened the default way. Such a file is shown in its folder, not
/// opened: a post can name any path, and a press is not a decision to run it.
///
/// Windows' own list of high-risk types (the Attachment Manager's) and the
/// ones that came after it, plus the scripts an installed interpreter runs on
/// a double-click (`.py`, `.sh`).
const RUNS_WHEN_OPENED: &[&str] = &[
    // Programs and the shell's own.
    "exe", "com", "scr", "pif", "cpl", "msc", "gadget", "jar",
    // Scripts.
    "bat", "cmd", "ps1", "psm1", "psd1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2",
    "msh", "msh1", "msh2", "mshxml", "msh1xml", "msh2xml",
    "vb", "vbs", "vbe", "js", "jse", "ws", "wsf", "wsh", "wsc", "sct", "hta",
    "py", "pyw", "pyz", "pyzw", "sh", "bash",
    // Installers and packages.
    "msi", "msp", "mst", "appx", "appxbundle", "msix", "msixbundle",
    "application", "appref-ms", "xbap", "ppkg", "diagcab",
    // Shortcuts and what points elsewhere.
    "lnk", "url", "scf", "xnk", "shb", "shs", "settingcontent-ms",
    "library-ms", "search-ms", "searchconnector-ms", "rdp", "wsb",
    // What changes the system, or carries macros or help that runs script.
    "reg", "inf", "ins", "isp", "its", "chm", "hlp",
    "ade", "adp", "mda", "mdb", "mde", "accde",
    // What mounts.
    "iso", "img", "vhd", "vhdx",
];

/// The URL itself, when it is one the browser may be given.
pub fn checked_url(url: &str) -> Result<&str, String> {
    let refused = || Err(format!("このリンクは開けません: {url}"));
    let lower = url.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("https://") {
        rest
    } else if let Some(rest) = lower.strip_prefix("http://") {
        rest
    } else {
        return refused();
    };
    // A host has to follow the scheme: `https:///x` and `https://` name none.
    if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') {
        return refused();
    }
    // What the screen never draws inside a link, so it never arrives here from
    // one: a URL is one run of text.
    if url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '<' | '>'))
    {
        return refused();
    }
    Ok(url)
}

/// The path itself, when it is one of the two shapes a link may be.
pub fn checked_path(path: &str) -> Result<&str, String> {
    let refused = || Err(format!("このパスは開けません: {path}"));
    let bytes = path.as_bytes();
    let separator = |b: u8| b == b'\\' || b == b'/';
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && separator(bytes[2]);
    let tail = if drive {
        &path[3..]
    } else if let Some(rest) = path.strip_prefix("\\\\") {
        // `\\server\share`: a server and a share, both named. `\\.\` and
        // `\\?\` are the device and verbatim forms, not a server.
        let mut parts = rest.splitn(2, |c| c == '\\' || c == '/');
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        let share_name = share.split(|c| c == '\\' || c == '/').next().unwrap_or("");
        if server.is_empty() || server == "." || server == "?" || share_name.is_empty() {
            return refused();
        }
        rest
    } else {
        return refused();
    };
    // A colon past the drive is an alternate data stream or no path at all,
    // and the rest are what Windows does not allow in a name.
    if tail
        .chars()
        .any(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return refused();
    }
    Ok(path)
}

/// Whether opening this file the default way would run it (`RUNS_WHEN_OPENED`).
///
/// Read from the last name as Windows reads it: trailing dots and spaces are
/// not part of a name there, so `setup.exe.` is `setup.exe`.
pub fn runs_when_opened(path: &str) -> bool {
    let name = path
        .rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or("")
        .trim_end_matches(['.', ' ']);
    match name.rfind('.') {
        Some(at) if at > 0 => {
            let extension = name[at + 1..].to_ascii_lowercase();
            RUNS_WHEN_OPENED.contains(&extension.as_str())
        }
        _ => false,
    }
}

/// What pressing `path` does: checked, then looked up on the disk.
pub fn path_action(path: &str) -> Result<PathAction, String> {
    let path = checked_path(path)?;
    let meta = match std::fs::metadata(Path::new(path)) {
        Ok(meta) => meta,
        Err(e) if e.kind() == ErrorKind::NotFound => return Err(format!("見つかりません: {path}")),
        Err(e) => return Err(format!("{path} を開けませんでした: {e}")),
    };
    Ok(if meta.is_dir() {
        PathAction::OpenFolder
    } else if runs_when_opened(path) {
        PathAction::Reveal
    } else {
        PathAction::OpenFile
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn http_and_https_open_in_either_case() {
        assert!(checked_url("https://github.com/Liplus-Project/pullcept/issues/349").is_ok());
        assert!(checked_url("http://127.0.0.1:8080/x?y=1#z").is_ok());
        assert!(checked_url("HTTPS://example.com").is_ok());
        assert!(checked_url("https://ja.wikipedia.org/wiki/日本").is_ok());
    }

    #[test]
    fn other_schemes_open_nothing() {
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "ftp://example.com/",
            "mailto:a@example.com",
            "C:\\Windows",
            "httpx://example.com",
            "https:example.com",
            "",
        ] {
            assert!(checked_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn a_url_names_a_host_and_is_one_run_of_text() {
        for url in [
            "https://",
            "http://",
            "https:///etc/passwd",
            "https://\\\\server\\share",
            "https://example.com/a b",
            "https://example.com/\n",
            "https://example.com/\"x\"",
            "https://example.com/<x>",
        ] {
            assert!(checked_url(url).is_err(), "{url:?}");
        }
    }

    #[test]
    fn drive_and_unc_paths_are_links() {
        for path in [
            "C:\\",
            "C:\\Users\\hal\\資料（最終）.xlsx",
            "d:/Users/hal/Code",
            "\\\\server\\share",
            "\\\\server\\share\\dir\\file.txt",
            "\\\\nas.local/share/x",
        ] {
            assert_eq!(checked_path(path), Ok(path), "{path}");
        }
    }

    #[test]
    fn other_paths_are_not() {
        for path in [
            "relative\\file.txt",
            ".\\file.txt",
            "..\\up",
            "\\rooted\\without\\drive",
            "C:",
            "C:relative",
            "1:\\x",
            "\\\\",
            "\\\\server",
            "\\\\server\\",
            "\\\\?\\C:\\Windows",
            "\\\\.\\PhysicalDrive0",
            "\\\\.\\pipe\\x",
            "C:\\a.txt:hidden",
            "C:\\a|b",
            "C:\\a\u{0}b",
            "C:\\a*",
            "https://example.com",
            "",
        ] {
            assert!(checked_path(path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn programs_scripts_and_shortcuts_are_shown_not_run() {
        for path in [
            "C:\\x\\setup.exe",
            "C:\\x\\SETUP.EXE",
            "C:\\x\\run.bat",
            "C:\\x\\run.cmd",
            "C:\\x\\a.com",
            "C:\\x\\a.ps1",
            "C:\\x\\a.vbs",
            "C:\\x\\a.js",
            "C:\\x\\a.msi",
            "C:\\x\\a.lnk",
            "C:\\x\\a.scr",
            "C:\\x\\a.hta",
            "C:\\x\\a.reg",
            "C:\\x\\a.py",
            "C:\\x\\a.url",
            "C:/x/a.iso",
            "\\\\server\\share\\a.exe",
            // Windows drops trailing dots and spaces from a name.
            "C:\\x\\setup.exe.",
            "C:\\x\\setup.exe. .",
        ] {
            assert!(runs_when_opened(path), "{path}");
        }
    }

    #[test]
    fn documents_and_extensionless_names_open() {
        for path in [
            "C:\\x\\notes.md",
            "C:\\x\\report.pdf",
            "C:\\x\\image.png",
            "C:\\x\\book.xlsx",
            "C:\\x\\exe",
            "C:\\x\\.exe",
            "C:\\x.exe\\readme",
            "C:\\x\\setup.exe.txt",
            "C:\\x\\Makefile",
        ] {
            assert!(!runs_when_opened(path), "{path}");
        }
    }

    /// A folder of this test's own under the temp folder, emptied first.
    #[cfg(windows)]
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("post-link-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(windows)]
    #[test]
    fn what_is_at_the_path_decides_the_action() {
        let dir = scratch("action");
        let doc = dir.join("メモ 1.md");
        let program = dir.join("setup.exe");
        let folder = dir.join("dist.exe");
        fs::write(&doc, "x").unwrap();
        fs::write(&program, "x").unwrap();
        fs::create_dir(&folder).unwrap();
        let at = |p: &Path| path_action(&p.to_string_lossy());
        assert_eq!(at(&dir), Ok(PathAction::OpenFolder));
        assert_eq!(at(&doc), Ok(PathAction::OpenFile));
        assert_eq!(at(&program), Ok(PathAction::Reveal));
        // A folder named like a program is still a folder.
        assert_eq!(at(&folder), Ok(PathAction::OpenFolder));
        let forward = doc.to_string_lossy().replace('\\', "/");
        assert_eq!(path_action(&forward), Ok(PathAction::OpenFile));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_path_that_is_not_there_says_so() {
        let dir = scratch("missing");
        let gone = dir.join("無い.txt");
        let said = path_action(&gone.to_string_lossy()).unwrap_err();
        assert!(said.starts_with("見つかりません"), "{said}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_path_of_another_shape_is_refused_before_the_disk() {
        let said = path_action("relative\\file.txt").unwrap_err();
        assert!(said.starts_with("このパスは開けません"), "{said}");
    }
}
