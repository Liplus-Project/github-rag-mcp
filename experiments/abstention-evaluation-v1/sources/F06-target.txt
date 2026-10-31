//! The topics of one room: a directory of topic files, and the index that
//! annotates it.
//!
//! ```text
//! {dir}/index.json      one entry per topic: name, when it was made,
//!                       and the session each account was in
//! {dir}/{topic}.jsonl   one topic's posts, append-only
//! {dir}/attachments/{topic}/{name}
//!                       the files attached to its posts (#223)
//! ```
//!
//! **The directory is what exists; the index annotates it.** A topic's posts
//! are the file, and [`read`] adopts any `.jsonl` it finds without an entry.
//! That is what makes lazy creation safe — a launch mints a topic and writes
//! nothing, so a run where nothing was said leaves no row in the list, and a
//! crash between the post reaching the file and the entry reaching the index
//! closes because the file alone is enough to rebuild the entry (#115).
//!
//! It is also what fixes the shape of a delete. The entry is an annotation, so
//! removing it removes an annotation: the file is still there, and the next
//! read adopts it back under a rebuilt entry. A topic is deleted by deleting
//! the file, and the entry goes with it (#119, decision 1). [`delete`] does
//! both in that order, and the test that matters here is the one that runs the
//! other order and watches the topic come back.
//!
//! Everything in this crate takes the room's directory as an argument. The path
//! to it is resolved by the app (`src-tauri/src/room_log.rs`), which is also
//! where the lock over read-modify-write of the index lives, and where the
//! screen is told the list has changed. What is here is the part that had to be
//! reachable by `cargo test`: `src-tauri` is compiled but not tested, for the
//! reason docs/5-development.md gives under テストの配置.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The index, as it is named inside the room's directory.
pub const INDEX_FILE: &str = "index.json";

/// The extension a topic's posts are kept under.
pub const TOPIC_EXTENSION: &str = "jsonl";

/// The directory, inside the room's, that the topics' attachments are kept
/// under: one directory per topic below it (#223).
///
/// Not a topic file's sibling of the same stem: the scan in [`read`] adopts
/// what it finds next to the index, and keeping every attachment one level
/// further down keeps that scan reading `.jsonl` files and nothing else.
pub const ATTACHMENTS_DIR: &str = "attachments";

/// The directory, inside the room's, that the stopped Codex seats' marks
/// are kept under: one file per topic below it (#312, #403). One level down for the
/// reason the attachments are.
pub const MAILBOXES_DIR: &str = "mailboxes";

/// How long an attachment's name may be, in characters.
///
/// The path the name ends is typed into a session as text and read back by a
/// CLI that may still be bound by the 260-character path of Windows. The app
/// data directory, `logs/main/attachments/` and a topic's UUID take about 170
/// of those already.
const ATTACHMENT_NAME_CHARS: usize = 80;

/// The extension kept whole when a name is cut to [`ATTACHMENT_NAME_CHARS`].
/// Longer than this and it is not an extension anyone reads a file type from.
const ATTACHMENT_EXTENSION_CHARS: usize = 16;

/// How many numbered names are tried before an attachment is refused.
const ATTACHMENT_TRIES: u32 = 10_000;

/// How long an auto-generated title is allowed to be, in characters.
///
/// Characters rather than bytes: the titles are Japanese more often than not,
/// and a byte cut would land inside one.
const TITLE_CHARS: usize = 40;

/// One post, as the log holds it.
///
/// The same seven fields going in and coming out. `hue` and `own` are not among
/// them, and why each is absent — and why `account` is not — is written down
/// where the mapping from a post is made (`src-tauri/src/room_log.rs`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggedPost {
    pub message_id: String,
    pub speaker: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    /// The account the speaker declared, or absent when they declared none.
    /// Omitted rather than written as null, as `to` is; a line written before
    /// this field existed reads as declaring none (#193).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// True when the app itself said it (#340). Written only when true, as
    /// `account` is written only when present; a line without it, and every
    /// line written before it existed, reads as not the app's.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub from_app: bool,
    pub content: String,
    /// The names this was addressed to, or empty when it was said to the room.
    /// Written as a list, and omitted rather than written empty or as null, so
    /// the two states are the field's presence (#204).
    ///
    /// A line written while a post could have only one addressee carries it as
    /// a bare string, and reads back as a list of that one name. The file is
    /// not rewritten to the new shape: a log is what was written, and the read
    /// is what widens.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "one_or_many"
    )]
    pub to: Vec<String>,
    pub ts: String,
}

/// `to` as a line holds it: a list, or the single name a line written before
/// #204 carries, or null.
fn one_or_many<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Written {
        One(String),
        Many(Vec<String>),
    }
    Ok(match Option::<Written>::deserialize(deserializer)? {
        None => Vec::new(),
        Some(Written::One(name)) => vec![name],
        Some(Written::Many(names)) => names,
    })
}

/// One topic, as the index holds it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Topic {
    /// Opaque, minted once, and the file name of this topic's posts. Never a
    /// title: a title is edited, and a file whose name moved with it would
    /// leave the posts behind.
    pub topic_id: String,
    /// What the list shows. Generated from the opening of the first post said
    /// in it and editable afterwards (#115, decision 9). Empty until that first
    /// post lands, which is a state the screen draws rather than a value
    /// missing.
    pub title: String,
    /// When it was made, RFC 3339. The room's clock, or the first post's own
    /// stamp for a topic adopted from a file.
    pub created_at: String,
    /// The session each account was in while this topic was open, keyed by
    /// account id.
    ///
    /// This is what makes a topic a vessel rather than a transcript: reopening
    /// it hands these back to the launch, and the participant returns carrying
    /// its own context instead of being read a summary of it (#115, decisions 3
    /// and 4). Deleting a topic throws them away with it — the conversation and
    /// the way back to whoever was in it are one thing, and #119 decision 1 is
    /// the decision to treat them as one.
    #[serde(default)]
    pub sessions: BTreeMap<String, String>,
}

/// The topics, as the file holds them.
///
/// Oldest first, by `created_at`. The screen reverses it — a list is read
/// newest first — and the file keeps the order the conversation happened in.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TopicIndex {
    #[serde(default)]
    pub topics: Vec<Topic>,
}

impl TopicIndex {
    pub fn find(&self, topic_id: &str) -> Option<&Topic> {
        self.topics.iter().find(|one| one.topic_id == topic_id)
    }

    pub fn find_mut(&mut self, topic_id: &str) -> Option<&mut Topic> {
        self.topics.iter_mut().find(|one| one.topic_id == topic_id)
    }

    /// Make sure `topic_id` has an entry, and hand back a mutable hold on it.
    ///
    /// The one place a topic reaches the index. Every caller is a deliberate act
    /// that has to survive the app closing — the first post, a session id, a
    /// rename — and none of them is "the app was opened".
    pub fn realize(&mut self, topic_id: &str, created_at: &str) -> &mut Topic {
        if self.find(topic_id).is_none() {
            self.topics.push(Topic {
                topic_id: topic_id.to_string(),
                title: String::new(),
                created_at: created_at.to_string(),
                sessions: BTreeMap::new(),
            });
        }
        self.find_mut(topic_id).expect("just inserted when absent")
    }

    /// Take one account's session id off a topic, when the topic still holds
    /// exactly that id. Answers whether anything was taken.
    ///
    /// The id is named rather than assumed, so this removes the record it was
    /// told about and never a later one. A resume that could not go back and a
    /// fresh launch that recorded a new id are the same account in the same
    /// topic; matching on the id is what keeps the first from reaching into the
    /// second (#127).
    ///
    /// A topic this index does not name, an account with nothing on record, and
    /// a record holding some other id all answer false. None of the three is an
    /// error: the caller is undoing a record it may already have lost the race
    /// for, and there being nothing to undo is a legitimate outcome of that.
    ///
    /// The entry itself stays. What is dropped is the way back into one
    /// session; the topic is the conversation, and the conversation did happen.
    pub fn forget_session(&mut self, topic_id: &str, account_id: &str, session_id: &str) -> bool {
        let Some(topic) = self.find_mut(topic_id) else {
            return false;
        };
        if topic.sessions.get(account_id).map(String::as_str) != Some(session_id) {
            return false;
        }
        topic.sessions.remove(account_id).is_some()
    }

    /// Take one topic's entry out. Answers whether there was one.
    ///
    /// Private, and a delete path cannot be built out of it by accident: the
    /// entry is an annotation of a file that is still there, so a read after
    /// this adopts the file back (see [`delete`]).
    fn forget(&mut self, topic_id: &str) -> bool {
        let before = self.topics.len();
        self.topics.retain(|one| one.topic_id != topic_id);
        self.topics.len() != before
    }
}

/// Where the index lives inside the room's directory.
pub fn index_path(dir: &Path) -> PathBuf {
    dir.join(INDEX_FILE)
}

/// Where one topic's posts live.
///
/// The id is a UUID minted by the app, so nothing a person types reaches a
/// path. A title with a slash in it would otherwise be a directory.
pub fn topic_path(dir: &Path, topic_id: &str) -> PathBuf {
    dir.join(format!("{topic_id}.{TOPIC_EXTENSION}"))
}

/// Whether `topic_id` names one file in the room's directory and nothing else.
///
/// The ids this app mints are UUIDs, and the ids it adopts are file stems from
/// one non-recursive scan of that directory, so nothing reachable through the
/// app fails this. It is checked anyway on the one operation that removes a
/// file: an id carrying a separator makes [`topic_path`] a path out of the
/// directory, and being wrong there costs somebody else's file rather than a
/// failed read.
fn names_one_file(topic_id: &str) -> bool {
    !topic_id.is_empty()
        && !topic_id.contains(['/', '\\', ':'])
        && topic_id != "."
        && topic_id != ".."
}

/// Where one topic's attachments live (#223).
pub fn attachments_path(dir: &Path, topic_id: &str) -> PathBuf {
    dir.join(ATTACHMENTS_DIR).join(topic_id)
}

/// Where one topic's stopped-seat marks live (#312, #403). What is in the file is
/// `mcp_config::codex::limit::Mailboxes`; here is only where it is, so that
/// [`delete`] takes it with the topic.
pub fn mailboxes_path(dir: &Path, topic_id: &str) -> PathBuf {
    dir.join(MAILBOXES_DIR).join(format!("{topic_id}.json"))
}

/// The name an attachment is saved under, from the name it arrived with.
///
/// The name is the last part of the path the post carries, and the path is
/// typed into a session as part of the text. So what is taken out is whatever
/// would stop that text reaching the session as the same path:
///
/// - What Windows refuses in a name (`<>:"/\|?*`), and every control character
///   — the terminal reads those as keys, and the input path drops them
///   (`terminal_input`), which would leave the text naming another file.
/// - `@` and `＠`. The room moves an `@名前` naming someone in it out of the
///   text (#206), and a file called `memo @Lin.txt` would arrive as a path
///   with a piece missing.
/// - Trailing dots and spaces, which Windows drops when it makes the file, so
///   the path written would not be the path that exists. And the device names
///   (`CON`, `NUL`, `COM1` …), which are not files at all.
///
/// Each of the first two becomes `_` rather than going, so the name still
/// reads as the one that was attached. Cut at [`ATTACHMENT_NAME_CHARS`],
/// keeping the extension: the extension is what a reader takes the file's
/// type from. A name with nothing left is `file`.
pub fn attachment_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let replaced: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '@' | '＠')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut name = replaced.trim().trim_end_matches(['.', ' ']).to_string();
    if name.chars().count() > ATTACHMENT_NAME_CHARS {
        name = cut_name(&name);
    }
    if name.is_empty() {
        return "file".to_string();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        name.insert(0, '_');
    }
    name
}

/// A name over [`ATTACHMENT_NAME_CHARS`], cut to it with its extension kept.
fn cut_name(name: &str) -> String {
    let (stem, ext) = split_extension(name);
    let ext_chars = ext.chars().count();
    if ext_chars == 0 || ext_chars > ATTACHMENT_EXTENSION_CHARS {
        return name.chars().take(ATTACHMENT_NAME_CHARS).collect();
    }
    let keep = ATTACHMENT_NAME_CHARS - ext_chars - 1;
    let stem: String = stem.chars().take(keep).collect();
    // A cut that ends on a space or a dot would end the stem the way Windows
    // trims, and the extension after it would then sit after nothing.
    format!("{}.{ext}", stem.trim_end_matches(['.', ' ']))
}

/// A name's stem and its extension, the extension without its dot. A name that
/// starts with its only dot (`.env`) has no extension.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(at) if at > 0 => (&name[..at], &name[at + 1..]),
        _ => (name, ""),
    }
}

/// The `n`th name tried for an attachment: the name itself first, then
/// `stem (2).ext`, `stem (3).ext` … — what Explorer does with a second copy.
fn numbered(name: &str, n: u32) -> String {
    if n == 1 {
        return name.to_string();
    }
    match split_extension(name) {
        (stem, "") => format!("{stem} ({n})"),
        (stem, ext) => format!("{stem} ({n}).{ext}"),
    }
}

/// Save one attachment under a topic, and answer the path it was saved at.
///
/// Named after what it arrived as ([`attachment_name`]), so the path read in
/// the post says what the file is. Two attachments with one name in a topic —
/// every pasted screenshot is `image.png` — are told apart the way Explorer
/// tells two copies apart, by a number after the stem. The file is created
/// only when nothing has that name yet (`create_new`), so two saves at once
/// cannot both take it and one write over the other.
///
/// What is saved is a copy, read out of `content`. A file dropped onto the
/// composer is copied rather than pointed at: the path is written into the log
/// for good, and the file it was dropped from can be moved or deleted the
/// next minute.
///
/// A write that fails takes its half-written file with it. Left there, it
/// would be a file under the name the post was about to carry, holding part
/// of what was attached.
pub fn save_attachment(
    dir: &Path,
    topic_id: &str,
    raw_name: &str,
    content: &mut impl std::io::Read,
) -> Result<PathBuf, String> {
    if !names_one_file(topic_id) {
        return Err(format!(
            "Refusing to attach to a topic whose id is not one file name: {topic_id}"
        ));
    }
    let folder = attachments_path(dir, topic_id);
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Failed to create the attachments dir: {e}"))?;
    let name = attachment_name(raw_name);
    for n in 1..=ATTACHMENT_TRIES {
        let path = folder.join(numbered(&name, n));
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create the attachment: {e}")),
        };
        if let Err(e) = std::io::copy(content, &mut file) {
            drop(file);
            std::fs::remove_file(&path).ok();
            return Err(format!("Failed to write the attachment: {e}"));
        }
        return Ok(path);
    }
    Err(format!("Too many attachments named {name} in this topic"))
}

/// How large an attachment the screen is handed to draw, in bytes (#318).
/// Larger than this and the post shows the file's chip instead of the
/// picture: a thumbnail is not worth carrying that much across.
pub const ATTACHMENT_VIEW_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// The file a post's path names, if it is an attachment of this room: a file
/// at `{dir}/attachments/{topic}/{name}` once every link on the way is followed
/// (#318).
///
/// The screen draws what a post's `添付:` block names, and a post can be
/// written by anyone in the room. So the path is not trusted for what it says:
/// both it and the attachments folder are resolved to what they really are
/// (`canonicalize`, which follows symlinks and junctions and folds `..`), and
/// the path is taken only when what it resolves to lies inside the folder,
/// exactly one topic folder down, and is a file. A link inside the folder that
/// leads out of it resolves outside and is refused.
///
/// The resolved path is what is answered, so whoever opens it next opens what
/// was checked and not the spelling that was handed in.
pub fn resolve_attachment(dir: &Path, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Not an attachment: the path is not absolute".to_string());
    }
    let root = std::fs::canonicalize(dir.join(ATTACHMENTS_DIR))
        .map_err(|e| format!("Failed to resolve the attachments dir: {e}"))?;
    let target =
        std::fs::canonicalize(path).map_err(|e| format!("Failed to resolve the attachment: {e}"))?;
    let inside = target
        .strip_prefix(&root)
        .map_err(|_| "Not an attachment: the path is outside the attachments dir".to_string())?;
    let depth = inside
        .components()
        .filter(|part| matches!(part, std::path::Component::Normal(_)))
        .count();
    if depth != 2 || inside.components().count() != 2 {
        return Err("Not an attachment: the path is not one topic's file".to_string());
    }
    let meta = std::fs::metadata(&target)
        .map_err(|e| format!("Failed to read the attachment: {e}"))?;
    if !meta.is_file() {
        return Err("Not an attachment: the path is not a file".to_string());
    }
    Ok(target)
}

/// The bytes of the attachment a post's path names (#318), for the screen to
/// draw. Only what [`resolve_attachment`] takes is read, and nothing over
/// [`ATTACHMENT_VIEW_MAX_BYTES`].
pub fn read_attachment(dir: &Path, path: &Path) -> Result<Vec<u8>, String> {
    let target = resolve_attachment(dir, path)?;
    let mut file =
        std::fs::File::open(&target).map_err(|e| format!("Failed to open the attachment: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Failed to read the attachment: {e}"))?
        .len();
    if len > ATTACHMENT_VIEW_MAX_BYTES {
        return Err("The attachment is too large to draw".to_string());
    }
    let mut bytes = Vec::with_capacity(len as usize);
    std::io::Read::read_to_end(
        &mut std::io::Read::take(&mut file, ATTACHMENT_VIEW_MAX_BYTES + 1),
        &mut bytes,
    )
    .map_err(|e| format!("Failed to read the attachment: {e}"))?;
    if bytes.len() as u64 > ATTACHMENT_VIEW_MAX_BYTES {
        return Err("The attachment is too large to draw".to_string());
    }
    Ok(bytes)
}

/// A title from the opening of the first thing said in the topic.
///
/// The first line, whitespace collapsed, cut at `TITLE_CHARS`. A list of
/// timestamps is a list nobody can read (#115, decision 9), and the opening of
/// the first post is what a person would have written there anyway.
pub fn title_from(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return String::new();
    }
    let mut chars = flat.chars();
    let head: String = chars.by_ref().take(TITLE_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// Whether anything has been said in `topic_id` yet, without reading it.
///
/// The file's size and nothing else, which is the same question [`read_posts`]
/// answers and a different cost: a launch asks this to decide one sentence of
/// the manners it hands the session, and paying the length of the topic for
/// that sentence would put the cost #115 kept off every launch back on it. A
/// count would need the read; that is why no count is handed to the session
/// (#133).
///
/// A missing file and an empty one are the same state here, as they are for the
/// first-post check the append makes. So is a file of nothing but torn lines:
/// it answers true, and the pull that follows says the topic is empty. Over-
/// answering costs one call nobody had to make; under-answering costs the
/// session the fact that it is missing something.
pub fn has_posts(dir: &Path, topic_id: &str) -> bool {
    std::fs::metadata(topic_path(dir, topic_id))
        .map(|meta| meta.len() > 0)
        .unwrap_or(false)
}

/// One topic's posts, oldest first.
///
/// The tuple's second half is how many lines did not parse. A line that does
/// not parse is skipped rather than failing the read: the case it covers is a
/// torn tail from a run that ended mid-write, and refusing the whole topic over
/// the last line of it would lose everything to protect nothing. It is not
/// skipped quietly — the caller says how many, on the same surface a failed
/// append is said on.
pub fn read_posts(path: &Path) -> (Vec<LoggedPost>, usize) {
    // No file is no history, not a failure. It is what a topic nobody has
    // spoken in yet looks like.
    let Ok(content) = std::fs::read_to_string(path) else {
        return (Vec::new(), 0);
    };

    let mut posts = Vec::new();
    let mut skipped = 0usize;
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<LoggedPost>(line) {
            Ok(post) => posts.push(post),
            Err(_) => skipped += 1,
        }
    }
    (posts, skipped)
}

/// Read the index off disk and reconcile it with the directory.
///
/// The reconciliation is not a repair path bolted on: it is what lets a topic
/// exist before any entry is written for it. An entry with no file stays — a
/// topic whose session was launched but which nobody has spoken in yet is that
/// case, and its session id is the whole reason to keep it.
///
/// `fallback_created_at` dates an adopted file with nothing readable in it. A
/// topic made through the app carries its own stamp and never reaches that
/// branch.
///
/// The second half of the answer is whether the caller should write the index
/// back: something was adopted, or there was no index file to begin with.
pub fn read(dir: &Path, fallback_created_at: &str) -> Result<(TopicIndex, bool), String> {
    let path = index_path(dir);
    let existed = path.exists();
    let mut index = if existed {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read the topic index: {e}"))?;
        serde_json::from_str::<TopicIndex>(&content)
            .map_err(|e| format!("Failed to parse the topic index: {e}"))?
    } else {
        TopicIndex::default()
    };

    let adopted = adopt_orphans(dir, &mut index, fallback_created_at);
    index
        .topics
        .sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.topic_id.cmp(&b.topic_id)));
    Ok((index, adopted || !existed))
}

/// Give an entry to every topic file the index does not name.
///
/// Answers true when it changed anything.
fn adopt_orphans(dir: &Path, index: &mut TopicIndex, fallback_created_at: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        // No directory is no topics, not a failure. It is the first run.
        return false;
    };
    let mut adopted = false;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some(TOPIC_EXTENSION) {
            continue;
        }
        let Some(topic_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if index.find(topic_id).is_some() {
            continue;
        }
        let (posts, _) = read_posts(&path);
        let first = posts.first();
        index.topics.push(Topic {
            topic_id: topic_id.to_string(),
            title: first.map(|post| title_from(&post.content)).unwrap_or_default(),
            // The first thing said in it, which is the closest thing a file
            // carries to when it began.
            created_at: first
                .map(|post| post.ts.clone())
                .unwrap_or_else(|| fallback_created_at.to_string()),
            sessions: BTreeMap::new(),
        });
        adopted = true;
    }
    adopted
}

/// Put the index back on disk.
pub fn write(dir: &Path, index: &TopicIndex) -> Result<(), String> {
    let path = index_path(dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create the room log dir: {e}"))?;
    }
    let content = serde_json::to_string_pretty(index)
        .map_err(|e| format!("Failed to serialize the topic index: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write the topic index: {e}"))
}

/// Delete one topic: its posts, the files attached to them, and the entry that
/// annotated them.
///
/// **Both, and the file first.** The entry is an annotation of the file, so an
/// index with the entry taken out and the file left behind is not a deleted
/// topic — it is a topic with no annotation, and [`read`] adopts it back under
/// a rebuilt entry the next time anything reads the list (#119, decision 1).
/// The order follows from that: the file is the half that has to go, so it goes
/// first, and a failure between the two leaves an entry whose file is gone.
/// That state is visible in the list and is the one #117 already describes; the
/// other order fails by putting the topic back, and reports nothing while it
/// does.
///
/// A missing file is not a failure. It is #117's own state — an entry the index
/// carries for a file that never existed — and taking the entry out is exactly
/// what is wanted for it.
///
/// The attachments go with the posts that carried their paths (#223). Kept,
/// they would be files nothing names any more, in a topic that is gone.
///
/// The caller writes the index back. It is holding the lock over the whole
/// read-modify-write, and this is one modify inside it.
pub fn delete(dir: &Path, index: &mut TopicIndex, topic_id: &str) -> Result<(), String> {
    if !names_one_file(topic_id) {
        return Err(format!(
            "Refusing to delete a topic whose id is not one file name: {topic_id}"
        ));
    }
    match std::fs::remove_file(topic_path(dir, topic_id)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to delete the topic's log: {e}")),
    }
    // The attachments after the posts: the posts are the topic, and a failure
    // between the two leaves the entry #117 describes with the files still
    // under it, which the next press of delete takes. A topic nothing was ever
    // attached to has no directory, and that is not a failure.
    match std::fs::remove_dir_all(attachments_path(dir, topic_id)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to delete the topic's attachments: {e}")),
    }
    // The marks of its stopped seats (#312): of a topic that is gone.
    match std::fs::remove_file(mailboxes_path(dir, topic_id)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to delete the topic's mailboxes: {e}")),
    }
    index.forget(topic_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("pullcept-topic-test-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Scratch(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    const NOW: &str = "2026-08-28T00:00:00+09:00";

    /// One topic file with one post in it.
    fn put_topic(dir: &Path, topic_id: &str, content: &str, ts: &str) {
        let post = LoggedPost {
            message_id: Uuid::new_v4().to_string(),
            speaker: "Lin".to_string(),
            full_name: None,
            account: None,
            from_app: false,
            content: content.to_string(),
            to: Vec::new(),
            ts: ts.to_string(),
        };
        let mut line = serde_json::to_string(&post).expect("serialize");
        line.push('\n');
        std::fs::write(topic_path(dir, topic_id), line).expect("write topic");
    }

    fn read_now(dir: &Path) -> TopicIndex {
        let (index, _) = read(dir, NOW).expect("read");
        index
    }

    #[test]
    fn adopts_a_topic_file_the_index_does_not_name() {
        let scratch = Scratch::new();
        put_topic(scratch.path(), "alpha", "最初の一言", "2026-08-27T10:00:00+09:00");

        let (index, needs_write) = read(scratch.path(), NOW).expect("read");

        assert!(needs_write, "an adoption is a change the caller has to write");
        let topic = index.find("alpha").expect("adopted");
        assert_eq!(topic.title, "最初の一言");
        assert_eq!(topic.created_at, "2026-08-27T10:00:00+09:00");
    }

    #[test]
    fn a_topic_with_posts_is_told_from_one_without_them() {
        let scratch = Scratch::new();
        put_topic(scratch.path(), "spoken", "先に言われたこと", "2026-08-27T10:00:00+09:00");
        std::fs::write(topic_path(scratch.path(), "opened"), "").expect("write empty topic");

        assert!(
            has_posts(scratch.path(), "spoken"),
            "a topic that was spoken in has posts"
        );
        assert!(
            !has_posts(scratch.path(), "opened"),
            "a topic realised by a launch and never spoken in has none"
        );
        assert!(
            !has_posts(scratch.path(), "never-made"),
            "a topic with no file at all has none"
        );
    }

    #[test]
    fn deleting_takes_the_file_and_the_entry_together() {
        let scratch = Scratch::new();
        put_topic(scratch.path(), "alpha", "消す方", "2026-08-27T10:00:00+09:00");
        let mut index = read_now(scratch.path());
        assert!(index.find("alpha").is_some());

        delete(scratch.path(), &mut index, "alpha").expect("delete");
        write(scratch.path(), &index).expect("write");

        assert!(!topic_path(scratch.path(), "alpha").exists());
        assert!(
            read_now(scratch.path()).find("alpha").is_none(),
            "a deleted topic does not come back on the next read"
        );
    }

    /// The reason [`delete`] removes the file.
    ///
    /// This is the index-only delete decision 1 refused, run as itself: the
    /// entry goes, the file stays, and the very next read adopts the file back
    /// under a rebuilt entry. Nothing reports a failure along the way, which is
    /// why the shape had to be settled in the code rather than left to whoever
    /// writes the next delete path.
    #[test]
    fn removing_only_the_entry_lets_the_next_read_resurrect_the_topic() {
        let scratch = Scratch::new();
        put_topic(scratch.path(), "alpha", "消えない方", "2026-08-27T10:00:00+09:00");
        let mut index = read_now(scratch.path());

        index.forget("alpha");
        write(scratch.path(), &index).expect("write");
        assert!(
            read_now(scratch.path()).find("alpha").is_some(),
            "the file is still there, so the read adopts it back"
        );

        // The same topic, deleted the way `delete` does it, stays deleted.
        let mut index = read_now(scratch.path());
        delete(scratch.path(), &mut index, "alpha").expect("delete");
        write(scratch.path(), &index).expect("write");
        assert!(read_now(scratch.path()).find("alpha").is_none());
    }

    #[test]
    fn deleting_one_topic_leaves_the_others_where_they_were() {
        let scratch = Scratch::new();
        put_topic(scratch.path(), "alpha", "残る方", "2026-08-27T10:00:00+09:00");
        put_topic(scratch.path(), "beta", "消す方", "2026-08-27T11:00:00+09:00");
        put_topic(scratch.path(), "gamma", "残る方も", "2026-08-27T12:00:00+09:00");
        let mut index = read_now(scratch.path());

        delete(scratch.path(), &mut index, "beta").expect("delete");
        write(scratch.path(), &index).expect("write");

        let index = read_now(scratch.path());
        let ids: Vec<&str> = index.topics.iter().map(|one| one.topic_id.as_str()).collect();
        assert_eq!(ids, vec!["alpha", "gamma"]);
        assert!(topic_path(scratch.path(), "alpha").exists());
        assert!(topic_path(scratch.path(), "gamma").exists());
    }

    /// #117's own state: an entry the index carries for a file that is not
    /// there. Nothing else reaches it, and this is the way out.
    #[test]
    fn deleting_an_entry_whose_file_is_missing_is_not_a_failure() {
        let scratch = Scratch::new();
        let mut index = TopicIndex::default();
        index.realize("orphaned", NOW);
        write(scratch.path(), &index).expect("write");

        let mut index = read_now(scratch.path());
        assert!(index.find("orphaned").is_some(), "an entry with no file stays");

        delete(scratch.path(), &mut index, "orphaned").expect("delete");
        write(scratch.path(), &index).expect("write");

        assert!(read_now(scratch.path()).find("orphaned").is_none());
    }

    /// The way back out of a session id that no conversation stands behind.
    ///
    /// The record is written at spawn, which is earlier than the moment a
    /// conversation exists, so a launch that ended before the CLI made one
    /// leaves an id that every later resume fails on (#127). Taking it off is
    /// what puts the next launch back on the normal line.
    #[test]
    fn forgetting_a_session_leaves_the_topic_and_the_other_accounts() {
        let mut index = TopicIndex::default();
        let topic = index.realize("alpha", NOW);
        topic.sessions.insert("lay".to_string(), "dead".to_string());
        topic.sessions.insert("lin".to_string(), "alive".to_string());

        assert!(index.forget_session("alpha", "lay", "dead"));

        let topic = index.find("alpha").expect("the topic itself stays");
        assert_eq!(topic.sessions.get("lay"), None);
        assert_eq!(
            topic.sessions.get("lin").map(String::as_str),
            Some("alive"),
            "one account's dead id is not another account's"
        );
    }

    /// The guard that keeps a late undo from reaching a live record.
    ///
    /// The account is seatless the moment its session ends, so it can be
    /// launched again before the exit is acted on. That launch records a new
    /// id under the same topic and the same account, and it is the id — not the
    /// pair — that says which of the two this is.
    #[test]
    fn forgetting_takes_only_the_id_it_was_told_about() {
        let mut index = TopicIndex::default();
        index
            .realize("alpha", NOW)
            .sessions
            .insert("lay".to_string(), "fresh".to_string());

        assert!(!index.forget_session("alpha", "lay", "dead"));
        assert_eq!(
            index.find("alpha").expect("topic").sessions.get("lay").map(String::as_str),
            Some("fresh"),
            "a record that has moved on is not this caller's to undo"
        );

        assert!(!index.forget_session("alpha", "nobody", "dead"));
        assert!(!index.forget_session("missing", "lay", "fresh"));
    }

    #[test]
    fn refuses_an_id_that_is_not_one_file_name() {
        let scratch = Scratch::new();
        let outsider = scratch.path().join("outsider.jsonl");
        std::fs::write(&outsider, "").expect("write outsider");
        let inner = scratch.path().join("room");
        std::fs::create_dir_all(&inner).expect("inner dir");
        let mut index = TopicIndex::default();

        for id in ["../outsider", "..\\outsider", "..", ".", ""] {
            let refused = delete(&inner, &mut index, id);
            assert!(refused.is_err(), "id {id:?} names more than one file");
        }
        assert!(
            outsider.exists(),
            "nothing outside the room's directory was touched"
        );
    }

    #[test]
    fn a_title_is_the_first_line_collapsed_and_cut() {
        assert_eq!(title_from("  こんにちは   部屋  "), "こんにちは 部屋");
        assert_eq!(title_from("一行目\n二行目"), "一行目 二行目");
        assert_eq!(title_from("   "), "");

        let long = "あ".repeat(TITLE_CHARS + 5);
        let cut = title_from(&long);
        assert_eq!(cut.chars().count(), TITLE_CHARS + 1, "the cut plus its mark");
        assert!(cut.ends_with('…'));

        let exact = "い".repeat(TITLE_CHARS);
        assert_eq!(title_from(&exact), exact, "no mark when nothing was cut");
    }

    #[test]
    fn a_torn_line_is_skipped_and_counted_rather_than_failing_the_read() {
        let scratch = Scratch::new();
        put_topic(scratch.path(), "alpha", "読める行", "2026-08-27T10:00:00+09:00");
        let path = topic_path(scratch.path(), "alpha");
        let mut content = std::fs::read_to_string(&path).expect("read");
        content.push_str("{\"message_id\":\"torn\",\"spea\n");
        std::fs::write(&path, content).expect("write");

        let (posts, skipped) = read_posts(&path);
        assert_eq!(posts.len(), 1);
        assert_eq!(skipped, 1);
    }

    /// A line written before `account` existed carries none, and reads as
    /// declaring none; a line carrying one hands it back. A line with none is
    /// written without the key, the way `to` is (#193).
    #[test]
    fn the_account_is_read_back_when_written_and_absent_when_not() {
        let scratch = Scratch::new();
        let path = scratch.path().join("t.jsonl");
        let before = r#"{"message_id":"a","speaker":"webhook","content":"x","ts":"2026-09-27T00:00:00Z"}"#;
        let after = r#"{"message_id":"b","speaker":"github-webhook-mcp","full_name":"Original Webhook", "account":"mcp-github-webhook-mcp","content":"y","ts":"2026-09-28T00:00:00Z"}"#;
        std::fs::write(&path, format!("{before}
{after}
")).expect("write");

        let (posts, skipped) = read_posts(&path);
        assert_eq!(skipped, 0);
        assert_eq!(posts[0].account, None);
        assert_eq!(posts[0].full_name, None);
        assert_eq!(posts[1].full_name.as_deref(), Some("Original Webhook"));
        assert!(serde_json::to_string(&posts[1]).unwrap().contains("Original Webhook"));
        assert_eq!(posts[1].account.as_deref(), Some("mcp-github-webhook-mcp"));

        let line = serde_json::to_string(&posts[0]).expect("serialize");
        assert!(!line.contains("account"), "{line}");
    }

    /// The app's own post is read back as the app's, so the screen draws the
    /// app's icon on it as it did live; every other line, and every line
    /// written before the field existed, reads as not. False is written
    /// without the key (#340).
    #[test]
    fn the_app_s_own_post_is_read_back_as_the_app_s() {
        let scratch = Scratch::new();
        let path = scratch.path().join("t.jsonl");
        let before = r#"{"message_id":"a","speaker":"Pullcept","content":"x","ts":"2026-10-07T00:00:00Z"}"#;
        let after = r#"{"message_id":"b","speaker":"Pullcept","from_app":true,"content":"y","ts":"2026-10-08T00:00:00Z"}"#;
        std::fs::write(&path, format!("{before}\n{after}\n")).expect("write");

        let (posts, skipped) = read_posts(&path);
        assert_eq!(skipped, 0);
        assert!(!posts[0].from_app, "a line without the key is not the app's");
        assert!(posts[1].from_app);

        let line = serde_json::to_string(&posts[0]).expect("serialize");
        assert!(!line.contains("from_app"), "{line}");
        let line = serde_json::to_string(&posts[1]).expect("serialize");
        assert!(line.contains(r#""from_app":true"#), "{line}");
    }

    /// A line written while a post had one addressee carries it as a string,
    /// and reads back as a list of that one name; nothing rewrites the file.
    /// A line written since carries a list, and a post to the room carries no
    /// key at all (#204).
    #[test]
    fn a_single_addressee_written_before_the_list_reads_as_a_list_of_one() {
        let scratch = Scratch::new();
        let path = scratch.path().join("t.jsonl");
        let one = r#"{"message_id":"a","speaker":"Master","content":"x","to":"Claude Lay","ts":"2026-09-27T00:00:00Z"}"#;
        let many = r#"{"message_id":"b","speaker":"Master","content":"y","to":["Claude Lay","Claude Lin"],"ts":"2026-09-28T00:00:00Z"}"#;
        let room = r#"{"message_id":"c","speaker":"Master","content":"z","ts":"2026-09-28T00:00:01Z"}"#;
        let null = r#"{"message_id":"d","speaker":"Master","content":"w","to":null,"ts":"2026-09-28T00:00:02Z"}"#;
        std::fs::write(&path, [one, many, room, null].join("
")).expect("write");

        let (posts, skipped) = read_posts(&path);
        assert_eq!(skipped, 0);
        assert_eq!(posts[0].to, ["Claude Lay"]);
        assert_eq!(posts[1].to, ["Claude Lay", "Claude Lin"]);
        assert!(posts[2].to.is_empty());
        assert!(posts[3].to.is_empty());

        let written: Vec<String> = posts
            .iter()
            .map(|post| serde_json::to_string(post).expect("serialize"))
            .collect();
        assert!(written[0].contains(r#""to":["Claude Lay"]"#), "{}", written[0]);
        assert!(written[1].contains(r#""to":["Claude Lay","Claude Lin"]"#), "{}", written[1]);
        assert!(!written[2].contains("\"to\""), "{}", written[2]);
    }

    /// What reaches the session as a path is the name the file was saved under,
    /// so a name is made into one the text carries unchanged (#223).
    #[test]
    fn an_attachment_name_keeps_what_reads_and_drops_what_would_break_the_path() {
        assert_eq!(attachment_name("image.png"), "image.png");
        assert_eq!(attachment_name("設計メモ 2026.pdf"), "設計メモ 2026.pdf");
        // A path is cut to its last part, either separator.
        assert_eq!(attachment_name(r"C:\Users\x\a.txt"), "a.txt");
        assert_eq!(attachment_name("dir/b.txt"), "b.txt");
        // What Windows refuses, control characters, and the room's `@`.
        assert_eq!(attachment_name("a<b>c:d\"e|f?g*.txt"), "a_b_c_d_e_f_g_.txt");
        assert_eq!(attachment_name("line\nbreak\r.txt"), "line_break_.txt");
        assert_eq!(attachment_name("memo @Lin.txt"), "memo _Lin.txt");
        assert_eq!(attachment_name("memo ＠Lin.txt"), "memo _Lin.txt");
        // Trailing dots and spaces are what Windows trims; nothing is "file".
        assert_eq!(attachment_name("note. . "), "note");
        assert_eq!(attachment_name(""), "file");
        assert_eq!(attachment_name(" .. "), "file");
        // Device names, with or without an extension, and only whole ones.
        assert_eq!(attachment_name("con"), "_con");
        assert_eq!(attachment_name("NUL.txt"), "_NUL.txt");
        assert_eq!(attachment_name("com1.log"), "_com1.log");
        assert_eq!(attachment_name("console.txt"), "console.txt");
        assert_eq!(attachment_name("com10.txt"), "com10.txt");
    }

    /// A long name is cut, and the extension survives the cut.
    #[test]
    fn a_long_attachment_name_is_cut_with_its_extension_kept() {
        let long = format!("{}.png", "あ".repeat(200));
        let cut = attachment_name(&long);
        assert_eq!(cut.chars().count(), ATTACHMENT_NAME_CHARS);
        assert!(cut.ends_with(".png"), "{cut}");

        // No extension worth the name: the whole is cut.
        let plain = "x".repeat(200);
        assert_eq!(attachment_name(&plain).chars().count(), ATTACHMENT_NAME_CHARS);
    }

    /// Saved under its own name, and a second file of that name in the topic
    /// is numbered rather than written over the first.
    #[test]
    fn a_second_attachment_of_one_name_is_numbered_and_the_first_is_kept() {
        let scratch = Scratch::new();
        let topic = Uuid::new_v4().to_string();

        let first = save_attachment(scratch.path(), &topic, "image.png", &mut &b"one"[..])
            .expect("first");
        let second = save_attachment(scratch.path(), &topic, "image.png", &mut &b"two"[..])
            .expect("second");
        let bare = save_attachment(scratch.path(), &topic, "README", &mut &b"r"[..]).expect("bare");
        let bare2 = save_attachment(scratch.path(), &topic, "README", &mut &b"r"[..]).expect("bare2");

        let folder = attachments_path(scratch.path(), &topic);
        assert_eq!(first, folder.join("image.png"));
        assert_eq!(second, folder.join("image (2).png"));
        assert_eq!(bare2, folder.join("README (2)"));
        assert_eq!(bare, folder.join("README"));
        assert_eq!(std::fs::read(&first).expect("read"), b"one");
        assert_eq!(std::fs::read(&second).expect("read"), b"two");
    }

    /// An id that is not one file name would put the attachment outside the
    /// topic's folder; nothing is written for it.
    #[test]
    fn an_attachment_to_a_topic_id_with_a_separator_is_refused() {
        let scratch = Scratch::new();
        let result = save_attachment(scratch.path(), "../elsewhere", "a.txt", &mut &b"x"[..]);
        assert!(result.is_err());
        assert!(!scratch.path().join(ATTACHMENTS_DIR).exists());
    }

    /// The attachments live one level down from the topic files, so the scan
    /// that adopts a topic from its file adopts nothing from them.
    #[test]
    fn attachments_are_not_adopted_as_topics() {
        let scratch = Scratch::new();
        let topic = Uuid::new_v4().to_string();
        put_topic(scratch.path(), &topic, "hello", NOW);
        save_attachment(scratch.path(), &topic, "a.jsonl", &mut &b"{}"[..]).expect("save");

        let (index, _) = read(scratch.path(), NOW).expect("read");
        assert_eq!(index.topics.len(), 1);
        assert_eq!(index.topics[0].topic_id, topic);
    }

    /// Deleting a topic takes its attachments, and leaves another topic's.
    #[test]
    fn deleting_a_topic_takes_its_attachments_and_only_its_own() {
        let scratch = Scratch::new();
        let gone = Uuid::new_v4().to_string();
        let kept = Uuid::new_v4().to_string();
        put_topic(scratch.path(), &gone, "hello", NOW);
        put_topic(scratch.path(), &kept, "hello", NOW);
        save_attachment(scratch.path(), &gone, "a.png", &mut &b"x"[..]).expect("save");
        let other = save_attachment(scratch.path(), &kept, "a.png", &mut &b"y"[..]).expect("save");

        let (mut index, _) = read(scratch.path(), NOW).expect("read");
        delete(scratch.path(), &mut index, &gone).expect("delete");

        assert!(!attachments_path(scratch.path(), &gone).exists());
        assert!(other.exists());
        assert!(index.find(&gone).is_none());
    }

    /// Deleting a topic takes its mailboxes, and leaves another topic's.
    #[test]
    fn deleting_a_topic_takes_its_mailboxes_and_only_its_own() {
        let scratch = Scratch::new();
        let gone = Uuid::new_v4().to_string();
        let kept = Uuid::new_v4().to_string();
        put_topic(scratch.path(), &gone, "hello", NOW);
        put_topic(scratch.path(), &kept, "hello", NOW);
        std::fs::create_dir_all(scratch.path().join(MAILBOXES_DIR)).expect("dir");
        std::fs::write(mailboxes_path(scratch.path(), &gone), r#"{"luna":["a"]}"#).expect("write");
        std::fs::write(mailboxes_path(scratch.path(), &kept), r#"{"luna":["b"]}"#).expect("write");

        let (mut index, _) = read(scratch.path(), NOW).expect("read");
        assert_eq!(index.topics.len(), 2, "a mailbox is not adopted as a topic");
        delete(scratch.path(), &mut index, &gone).expect("delete");

        assert!(!mailboxes_path(scratch.path(), &gone).exists());
        assert!(mailboxes_path(scratch.path(), &kept).exists());
    }

    /// What was saved under a topic is read back for the screen, and through
    /// the path the post carries (#318).
    #[test]
    fn a_saved_attachment_reads_back() {
        let scratch = Scratch::new();
        let topic = Uuid::new_v4().to_string();
        let saved = save_attachment(scratch.path(), &topic, "image.png", &mut &b"png"[..])
            .expect("save");
        assert_eq!(read_attachment(scratch.path(), &saved).expect("read"), b"png");
    }

    /// A path a post names that is not under the attachments folder is not
    /// read, however it is spelled: outright elsewhere, climbing out with `..`,
    /// the folder itself, a topic's folder, or relative.
    #[test]
    fn a_path_outside_the_attachments_is_refused() {
        let scratch = Scratch::new();
        let topic = Uuid::new_v4().to_string();
        let saved = save_attachment(scratch.path(), &topic, "a.txt", &mut &b"a"[..]).expect("save");
        let secret = scratch.path().join("secret.txt");
        std::fs::write(&secret, b"secret").expect("write");
        let climbing = attachments_path(scratch.path(), &topic).join("..").join("..").join("secret.txt");
        let folder = attachments_path(scratch.path(), &topic);

        for path in [
            secret.clone(),
            climbing,
            scratch.path().join(ATTACHMENTS_DIR),
            folder,
            PathBuf::from("a.txt"),
        ] {
            assert!(read_attachment(scratch.path(), &path).is_err(), "{path:?} was read");
        }
        assert!(read_attachment(scratch.path(), &saved).is_ok());
    }

    /// A file one folder further down than a topic's is not one of its
    /// attachments; nothing the app saves sits there.
    #[test]
    fn a_file_deeper_than_a_topic_folder_is_refused() {
        let scratch = Scratch::new();
        let deeper = attachments_path(scratch.path(), "t").join("inner");
        std::fs::create_dir_all(&deeper).expect("dir");
        std::fs::write(deeper.join("a.txt"), b"a").expect("write");
        assert!(read_attachment(scratch.path(), &deeper.join("a.txt")).is_err());
    }

    /// A junction inside the attachments folder that leads out of it is not a
    /// way out: the path resolves to where the junction goes, and that is
    /// outside. Made with `mklink /J`, which needs no privilege; skipped where
    /// it cannot be made.
    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_attachments_is_refused() {
        let scratch = Scratch::new();
        let outside = scratch.path().join("outside");
        std::fs::create_dir_all(&outside).expect("dir");
        std::fs::write(outside.join("secret.png"), b"secret").expect("write");
        std::fs::create_dir_all(scratch.path().join(ATTACHMENTS_DIR)).expect("dir");
        let junction = attachments_path(scratch.path(), "t");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if !made {
            eprintln!("skipped: mklink /J was not available");
            return;
        }
        let result = read_attachment(scratch.path(), &junction.join("secret.png"));
        std::fs::remove_dir(&junction).ok();
        assert!(result.is_err());
    }

    /// A symlink inside a topic's folder that names a file outside resolves
    /// to that file, and is refused. Skipped where a symlink cannot be made
    /// (Windows without the privilege).
    #[test]
    fn a_symlink_out_of_the_attachments_is_refused() {
        let scratch = Scratch::new();
        let secret = scratch.path().join("secret.png");
        std::fs::write(&secret, b"secret").expect("write");
        let folder = attachments_path(scratch.path(), "t");
        std::fs::create_dir_all(&folder).expect("dir");
        let link = folder.join("link.png");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&secret, &link).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&secret, &link).is_ok();
        if !made {
            eprintln!("skipped: a symlink could not be made");
            return;
        }
        assert!(read_attachment(scratch.path(), &link).is_err());
    }

    /// A topic nothing was attached to has no folder, and deleting it is not a
    /// failure for that.
    #[test]
    fn deleting_a_topic_with_no_attachments_succeeds() {
        let scratch = Scratch::new();
        let topic = Uuid::new_v4().to_string();
        put_topic(scratch.path(), &topic, "hello", NOW);
        let (mut index, _) = read(scratch.path(), NOW).expect("read");
        delete(scratch.path(), &mut index, &topic).expect("delete");
        assert!(index.find(&topic).is_none());
    }
}
