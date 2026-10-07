use serde::Serialize;

use super::paths::{check_rel, is_image, script_argv};
use super::{MAX_IMAGE_BYTES, MAX_TEXT_BYTES};
use crate::error::{AppError, AppResult};
use crate::transport::{exec, exec_bytes, Transport};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ContentKind {
    Text,
    Binary,
    Image,
}

#[derive(Serialize, Debug)]
pub struct FileContent {
    pub kind: ContentKind,
    pub text: Option<String>,
    pub truncated: bool,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
}

/// `$1` root, `$2` file below it, `$3` is `img` when the content is not wanted.
/// Prints `size mtime` (GNU stat first, BSD/macOS stat as the fallback), a `1`/`0`
/// binary flag, then up to 2 MB of text. `od -c` writes a NUL byte as the two
/// characters backslash-zero, which `grep -F` matches portably.
const READ_SCRIPT: &str = r#"cd "$1" || exit 3
f="./$2"
[ -f "$f" ] || exit 3
stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f" || exit 3
[ "$3" = img ] && exit 0
if head -c 8192 -- "$f" | od -An -c | grep -qF '\0'; then echo 1; exit 0; fi
echo 0
head -c 2097152 -- "$f""#;

/// `$1` root, `$2` file, `$3` size limit. Prints the stat line, exit 4 when over the limit,
/// else the raw bytes.
const IMAGE_SCRIPT: &str = r#"cd "$1" || exit 3
f="./$2"
[ -f "$f" ] || exit 3
s=$(stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f") || exit 3
echo "$s"
[ "${s%% *}" -le "$3" ] || exit 4
cat -- "$f""#;

/// `$1` root, then one relative path each. A line `-` stands for a path that cannot be stat'ed.
const STAT_SCRIPT: &str = r#"cd "$1" || exit 3
shift
for r; do
  f="./$r"
  s=$(stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f" 2>/dev/null) || s=-
  printf '%s\n' "$s"
done"#;

fn parse_stat(line: &str) -> Option<FileStat> {
    let (size, mtime) = line.trim().split_once(' ')?;
    Some(FileStat {
        size: size.parse().ok()?,
        mtime: mtime.parse().ok()?,
    })
}

/// Splits off the first line (without its newline); the rest is returned untouched.
fn split_line(bytes: &[u8]) -> (&[u8], &[u8]) {
    match bytes.iter().position(|b| *b == b'\n') {
        Some(i) => (&bytes[..i], &bytes[i + 1..]),
        None => (bytes, &[]),
    }
}

fn script_error(status: i32, stderr: &str, what: &str) -> AppError {
    match status {
        3 => AppError::new("not_found", format!("no such file: {what:?}")),
        _ => AppError::new("io", stderr.trim().to_string()),
    }
}

fn bad_output() -> AppError {
    AppError::new("io", "unexpected output from the file script")
}

pub async fn read_file(t: &dyn Transport, root: &str, rel: &str) -> AppResult<FileContent> {
    check_rel(rel)?;
    let image = is_image(rel);
    let flag = if image { "img" } else { "txt" };
    let out = exec_bytes(t, &script_argv(READ_SCRIPT, &[root, rel, flag])).await?;
    if out.status != 0 {
        return Err(script_error(out.status, &out.stderr, rel));
    }
    let (stat, rest) = split_line(&out.stdout);
    let FileStat { size, mtime } =
        parse_stat(&String::from_utf8_lossy(stat)).ok_or_else(bad_output)?;
    let content = |kind, text, truncated| FileContent {
        kind,
        text,
        truncated,
        size,
        mtime,
    };
    if image {
        return Ok(content(ContentKind::Image, None, false));
    }
    let (binary, body) = split_line(rest);
    if binary == b"1" {
        return Ok(content(ContentKind::Binary, None, false));
    }
    Ok(content(
        ContentKind::Text,
        Some(String::from_utf8_lossy(body).into_owned()),
        size > MAX_TEXT_BYTES as u64,
    ))
}

pub async fn read_image(t: &dyn Transport, root: &str, rel: &str) -> AppResult<Vec<u8>> {
    check_rel(rel)?;
    let limit = MAX_IMAGE_BYTES.to_string();
    let out = exec_bytes(t, &script_argv(IMAGE_SCRIPT, &[root, rel, &limit])).await?;
    match out.status {
        0 => {}
        4 => return Err(AppError::new("invalid", "image larger than 5 MB")),
        s => return Err(script_error(s, &out.stderr, rel)),
    }
    Ok(split_line(&out.stdout).1.to_vec())
}

pub async fn stat_files(
    t: &dyn Transport,
    root: &str,
    rels: &[String],
) -> AppResult<Vec<Option<FileStat>>> {
    for r in rels {
        check_rel(r)?;
    }
    if rels.is_empty() {
        return Ok(vec![]);
    }
    let mut args: Vec<&str> = vec![root];
    args.extend(rels.iter().map(String::as_str));
    let out = exec(t, &script_argv(STAT_SCRIPT, &args)).await?;
    if out.status != 0 {
        return Err(script_error(out.status, &out.stderr, root));
    }
    let stats: Vec<Option<FileStat>> = out.stdout.lines().map(parse_stat).collect();
    if stats.len() != rels.len() {
        return Err(bad_output());
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    fn root() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("r o'ot");
        std::fs::create_dir_all(r.join("src")).unwrap();
        let s = r.to_string_lossy().into_owned();
        (tmp, s)
    }

    #[tokio::test]
    async fn reads_text_with_size_and_mtime() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/src/a b.ts"), "let x = 1;\n").unwrap();
        let c = read_file(&LocalTransport, &r, "src/a b.ts").await.unwrap();
        assert!(matches!(c.kind, ContentKind::Text));
        assert_eq!(c.text.as_deref(), Some("let x = 1;\n"));
        assert_eq!(c.size, 11);
        assert!(!c.truncated);
        assert!(c.mtime > 1_600_000_000);
    }

    #[tokio::test]
    async fn binary_and_truncated_and_image() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/bin"), [b'a', 0, b'b']).unwrap();
        let c = read_file(&LocalTransport, &r, "bin").await.unwrap();
        assert!(matches!(c.kind, ContentKind::Binary));
        assert_eq!(c.text, None);
        assert_eq!(c.size, 3);

        std::fs::write(format!("{r}/big.txt"), vec![b'x'; MAX_TEXT_BYTES + 10]).unwrap();
        let c = read_file(&LocalTransport, &r, "big.txt").await.unwrap();
        assert!(c.truncated);
        assert_eq!(c.text.unwrap().len(), MAX_TEXT_BYTES);
        assert_eq!(c.size, (MAX_TEXT_BYTES + 10) as u64);

        std::fs::write(format!("{r}/p.png"), [0x89, b'P', b'N', b'G', 0]).unwrap();
        let c = read_file(&LocalTransport, &r, "p.png").await.unwrap();
        assert!(matches!(c.kind, ContentKind::Image));
        assert_eq!(
            read_image(&LocalTransport, &r, "p.png").await.unwrap(),
            vec![0x89, b'P', b'N', b'G', 0]
        );
    }

    #[tokio::test]
    async fn too_large_image_is_refused() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/huge.png"), vec![0u8; MAX_IMAGE_BYTES + 1]).unwrap();
        let e = read_image(&LocalTransport, &r, "huge.png")
            .await
            .unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("invalid", "image larger than 5 MB")
        );
    }

    #[tokio::test]
    async fn missing_is_not_found_and_stat_maps_missing_to_none() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/a"), "abc").unwrap();
        assert_eq!(
            read_file(&LocalTransport, &r, "nope")
                .await
                .unwrap_err()
                .code,
            "not_found"
        );
        let s = stat_files(&LocalTransport, &r, &["a".into(), "nope".into()])
            .await
            .unwrap();
        assert_eq!(s[0].unwrap().size, 3);
        assert_eq!(s[1], None);
        assert!(stat_files(&LocalTransport, &r, &[])
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            stat_files(&LocalTransport, &r, &["../x".into()])
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
    }
}
