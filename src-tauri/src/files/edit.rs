//! Create, Rename and Delete of items below a root (ADR-0006). Create and Rename never replace
//! anything; Delete is the one destructive write, and the UI confirms it first.

use super::paths::{check_rel, io_error, script_argv};
use super::transfer::{run_piped, TRANSFER_TIMEOUT};
use crate::error::{AppError, AppResult};
use crate::transport::{exec_bytes, Transport};

/// `$1` root, `$2` item, `$3` `dir` or `file`. Exit 4 when the name is taken (a dangling link
/// too); missing parent folders are made.
const CREATE_SCRIPT: &str = r#"cd "$1" || exit 3
f="./$2"
if [ -e "$f" ] || [ -L "$f" ]; then exit 4; fi
mkdir -p -- "$(dirname -- "$f")" || exit 1
if [ "$3" = dir ]; then mkdir -- "$f"; else (set -C; : > "$f"); fi"#;

/// `$1` root, `$2` item, `$3` its new path. Exit 5 when the item is missing, 4 when the new
/// name is taken (checked before `mv -n`, and again if the item did not move). Without GNU
/// `-T`, a folder of that name created between the check and the move receives the item
/// inside it: the narrow race ADR-0005 accepts, since nothing is replaced.
const RENAME_SCRIPT: &str = r#"cd "$1" || exit 3
[ -e "./$2" ] || [ -L "./$2" ] || exit 5
if [ -e "./$3" ] || [ -L "./$3" ]; then exit 4; fi
mv -n -- "./$2" "./$3" || exit 1
if [ -e "./$2" ] || [ -L "./$2" ]; then exit 4; fi"#;

/// `$1` root, `$2` item. Exit 5 when it is missing. A linked folder loses only its link: the
/// path never ends with `/`, so `rm` does not follow it.
const DELETE_SCRIPT: &str = r#"cd "$1" || exit 3
[ -e "./$2" ] || [ -L "./$2" ] || exit 5
rm -rf -- "./$2""#;

/// An item below the root: not the root itself, and every segment a real name (no empty,
/// `.` or `..` segment, so no trailing `/` either).
fn check_item(rel: &str) -> AppResult<()> {
    check_rel(rel)?;
    if rel.split('/').any(|s| s.is_empty() || s == ".") {
        return Err(AppError::new("invalid", format!("invalid path: {rel:?}")));
    }
    Ok(())
}

/// A name within one folder.
fn check_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return Err(AppError::new("invalid", format!("invalid name: {name:?}")));
    }
    Ok(())
}

fn script_error(status: i32, stderr: &str, root: &str, rel: &str) -> AppError {
    match status {
        3 => AppError::new("not_found", format!("no such folder: {root:?}")),
        4 => AppError::new("invalid", format!("{rel} already exists")),
        5 => AppError::new("not_found", format!("no such file or folder: {rel:?}")),
        _ => io_error(status, stderr),
    }
}

/// An empty file, or a folder with `is_dir`, at `rel`; never over anything already there.
pub async fn create(t: &dyn Transport, root: &str, rel: &str, is_dir: bool) -> AppResult<()> {
    check_item(rel)?;
    let kind = if is_dir { "dir" } else { "file" };
    let out = exec_bytes(t, &script_argv(CREATE_SCRIPT, &[root, rel, kind])).await?;
    match out.status {
        0 => Ok(()),
        s => Err(script_error(s, &out.stderr, root, rel)),
    }
}

/// Renames `rel` to `name` in the same folder; returns the new path. Never replaces anything.
pub async fn rename(t: &dyn Transport, root: &str, rel: &str, name: &str) -> AppResult<String> {
    check_item(rel)?;
    check_name(name)?;
    let to = match rel.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/{name}"),
        None => name.to_string(),
    };
    if to == rel {
        return Ok(to);
    }
    let out = exec_bytes(t, &script_argv(RENAME_SCRIPT, &[root, rel, &to])).await?;
    match out.status {
        0 => Ok(to),
        4 => Err(script_error(4, &out.stderr, root, &to)),
        s => Err(script_error(s, &out.stderr, root, rel)),
    }
}

/// Removes `rel` and everything in it. Blocking, with the transfer timeout: a big tree takes
/// longer than a plain exec allows.
pub fn delete(t: &dyn Transport, root: &str, rel: &str) -> AppResult<()> {
    check_item(rel)?;
    let argv = script_argv(DELETE_SCRIPT, &[root, rel]);
    let (exit, _) = run_piped(t, &argv, TRANSFER_TIMEOUT, |stdin, _| {
        drop(stdin);
        Ok(())
    })?;
    match exit.code {
        0 => Ok(()),
        s => Err(script_error(s, &exit.stderr, root, rel)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::path::Path;

    fn root() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("r o'ot");
        std::fs::create_dir_all(r.join("src")).unwrap();
        let s = r.to_string_lossy().into_owned();
        (tmp, s)
    }

    fn code(e: crate::error::AppError) -> String {
        e.code
    }

    #[tokio::test]
    async fn creates_an_empty_file() {
        let (_t, r) = root();
        create(&LocalTransport, &r, "src/a b.ts", false)
            .await
            .unwrap();
        assert_eq!(std::fs::read(format!("{r}/src/a b.ts")).unwrap(), b"");
    }

    #[tokio::test]
    async fn creates_a_folder() {
        let (_t, r) = root();
        create(&LocalTransport, &r, "src/lib", true).await.unwrap();
        assert!(Path::new(&format!("{r}/src/lib")).is_dir());
    }

    #[tokio::test]
    async fn creates_missing_parent_folders() {
        let (_t, r) = root();
        create(&LocalTransport, &r, "a/b/c.md", false)
            .await
            .unwrap();
        assert!(Path::new(&format!("{r}/a/b/c.md")).is_file());
    }

    #[tokio::test]
    async fn create_never_replaces_a_file() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/src/x"), "keep").unwrap();
        for is_dir in [false, true] {
            let e = create(&LocalTransport, &r, "src/x", is_dir)
                .await
                .unwrap_err();
            assert!(e.message.contains("already exists"), "{e:?}");
        }
        assert_eq!(
            std::fs::read_to_string(format!("{r}/src/x")).unwrap(),
            "keep"
        );
    }

    #[tokio::test]
    async fn create_refuses_a_dangling_symlink_name() {
        let (_t, r) = root();
        std::os::unix::fs::symlink("/nowhere", format!("{r}/link")).unwrap();
        let e = create(&LocalTransport, &r, "link", false)
            .await
            .unwrap_err();
        assert!(e.message.contains("already exists"), "{e:?}");
        assert!(!Path::new("/nowhere").exists());
    }

    #[tokio::test]
    async fn renames_a_file_in_its_folder() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/src/a.ts"), "x").unwrap();
        let to = rename(&LocalTransport, &r, "src/a.ts", "b c.ts")
            .await
            .unwrap();
        assert_eq!(to, "src/b c.ts");
        assert!(!Path::new(&format!("{r}/src/a.ts")).exists());
        assert_eq!(
            std::fs::read_to_string(format!("{r}/src/b c.ts")).unwrap(),
            "x"
        );
    }

    #[tokio::test]
    async fn renames_a_folder_at_the_root() {
        let (_t, r) = root();
        let to = rename(&LocalTransport, &r, "src", "lib").await.unwrap();
        assert_eq!(to, "lib");
        assert!(Path::new(&format!("{r}/lib")).is_dir());
    }

    #[tokio::test]
    async fn rename_never_replaces() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/a"), "a").unwrap();
        std::fs::write(format!("{r}/b"), "b").unwrap();
        let e = rename(&LocalTransport, &r, "a", "b").await.unwrap_err();
        assert!(e.message.contains("already exists"), "{e:?}");
        // Nor moves into a folder of that name.
        let e = rename(&LocalTransport, &r, "a", "src").await.unwrap_err();
        assert!(e.message.contains("already exists"), "{e:?}");
        assert_eq!(std::fs::read_to_string(format!("{r}/a")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(format!("{r}/b")).unwrap(), "b");
        assert!(!Path::new(&format!("{r}/src/a")).exists());
    }

    #[tokio::test]
    async fn rename_of_a_missing_item_is_not_found() {
        let (_t, r) = root();
        let e = rename(&LocalTransport, &r, "nope", "x").await.unwrap_err();
        assert_eq!(code(e), "not_found");
    }

    #[tokio::test]
    async fn rename_rejects_bad_names() {
        let (_t, r) = root();
        for name in ["", ".", "..", "a/b", "a\0b"] {
            let e = rename(&LocalTransport, &r, "src", name).await.unwrap_err();
            assert_eq!(code(e), "invalid", "{name:?}");
        }
    }

    #[tokio::test]
    async fn rename_to_the_same_name_is_a_no_op() {
        let (_t, r) = root();
        assert_eq!(
            rename(&LocalTransport, &r, "src", "src").await.unwrap(),
            "src"
        );
        assert!(Path::new(&format!("{r}/src")).is_dir());
    }

    #[test]
    fn deletes_a_file() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/src/a"), "x").unwrap();
        delete(&LocalTransport, &r, "src/a").unwrap();
        assert!(!Path::new(&format!("{r}/src/a")).exists());
        assert!(Path::new(&format!("{r}/src")).is_dir());
    }

    #[test]
    fn deletes_a_folder_with_its_contents() {
        let (_t, r) = root();
        std::fs::create_dir_all(format!("{r}/src/deep/er")).unwrap();
        std::fs::write(format!("{r}/src/deep/er/f"), "x").unwrap();
        delete(&LocalTransport, &r, "src").unwrap();
        assert!(!Path::new(&format!("{r}/src")).exists());
        assert!(Path::new(&r).is_dir());
    }

    #[test]
    fn delete_of_a_linked_folder_removes_only_the_link() {
        let (t, r) = root();
        let target = t.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "x").unwrap();
        std::os::unix::fs::symlink(&target, format!("{r}/link")).unwrap();
        delete(&LocalTransport, &r, "link").unwrap();
        assert!(std::fs::symlink_metadata(format!("{r}/link")).is_err());
        assert!(target.join("keep").exists());
    }

    #[test]
    fn delete_of_a_missing_item_is_not_found() {
        let (_t, r) = root();
        let e = delete(&LocalTransport, &r, "nope").unwrap_err();
        assert_eq!(code(e), "not_found");
    }

    #[tokio::test]
    async fn refuses_the_root_and_unclean_paths() {
        let (_t, r) = root();
        for rel in ["", "src/", "a//b", "./src", "src/.", "../x", "/etc"] {
            let e = delete(&LocalTransport, &r, rel).unwrap_err();
            assert_eq!(code(e), "invalid", "delete {rel:?}");
            let e = rename(&LocalTransport, &r, rel, "y").await.unwrap_err();
            assert_eq!(code(e), "invalid", "rename {rel:?}");
            let e = create(&LocalTransport, &r, rel, false).await.unwrap_err();
            assert_eq!(code(e), "invalid", "create {rel:?}");
        }
        assert!(Path::new(&format!("{r}/src")).is_dir());
    }
}
