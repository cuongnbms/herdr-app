//! Installed monospace font families, for the terminal font picker.

/// Unique family names of the monospace faces, sorted case-insensitively.
/// Hidden system families (leading `.`) are skipped: the WebView cannot select them by name.
pub fn monospace_families(faces: impl IntoIterator<Item = (String, bool)>) -> Vec<String> {
    let mut out: Vec<String> = faces
        .into_iter()
        .filter(|(name, mono)| *mono && !name.is_empty() && !name.starts_with('.'))
        .map(|(name, _)| name)
        .collect();
    out.sort_by_key(|n| n.to_lowercase());
    out.dedup();
    out
}

/// Never panics: core-text's `family_name()`/`traits()` assert on missing attributes, and the
/// release profile aborts on panic, so one odd font must only be skipped.
#[cfg(target_os = "macos")]
pub fn installed_monospace() -> Vec<String> {
    use core_text::font_collection::create_for_all_families;
    let Some(descs) = create_for_all_families().get_descriptors() else {
        return Vec::new();
    };
    monospace_families(descs.iter().filter_map(|d| mac::face(&d)))
}

/// Whether the WebView can be handed this face as a web font: a single-face file outside the
/// system font folders. WebKit already renders system fonts everywhere; a collection would only
/// yield its first face.
pub fn web_loadable(path: &std::path::Path) -> bool {
    let single = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "otf" | "ttf" | "woff" | "woff2"));
    single && !path.starts_with("/System/")
}

/// The file of `family`'s face named `style` (CoreText style name, e.g. "Bold Italic"), when
/// [`web_loadable`]. Installed (non-system) fonts must be registered with the WebView this way:
/// WebKit hides them from detached canvases, which is where xterm's WebGL atlas draws glyphs.
#[cfg(target_os = "macos")]
pub fn face_file(family: &str, style: &str) -> Option<std::path::PathBuf> {
    let descs = core_text::font_collection::create_for_family(family)?.get_descriptors()?;
    descs
        .iter()
        .filter_map(|d| mac::style_and_path(&d))
        .find(|(s, _)| s.eq_ignore_ascii_case(style))
        .map(|(_, p)| p)
        .filter(|p| web_loadable(p))
}

#[cfg(not(target_os = "macos"))]
pub fn face_file(_family: &str, _style: &str) -> Option<std::path::PathBuf> {
    None
}

#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation::url::CFURL;
    use core_text::font_descriptor::{
        kCTFontFamilyNameAttribute, kCTFontMonoSpaceTrait, kCTFontStyleNameAttribute,
        kCTFontSymbolicTrait, kCTFontTraitsAttribute, kCTFontURLAttribute, CTFontDescriptor,
        CTFontDescriptorCopyAttribute,
    };

    fn attribute(d: &CTFontDescriptor, key: CFStringRef) -> Option<CFType> {
        // SAFETY: a valid descriptor and attribute key; the copy is owned (create rule) or null.
        unsafe {
            let v = CTFontDescriptorCopyAttribute(d.as_concrete_TypeRef(), key);
            (!v.is_null()).then(|| CFType::wrap_under_create_rule(v))
        }
    }

    /// `(family, is_monospace)`, or `None` when the descriptor has no family name.
    pub fn face(d: &CTFontDescriptor) -> Option<(String, bool)> {
        let family = attribute(d, unsafe { kCTFontFamilyNameAttribute })?
            .downcast::<CFString>()?
            .to_string();
        let mono = attribute(d, unsafe { kCTFontTraitsAttribute })
            .and_then(|t| t.downcast::<CFDictionary>())
            .and_then(|t| {
                // SAFETY: the traits dictionary maps CFString keys to CF values.
                let t: CFDictionary<CFString, CFType> =
                    unsafe { CFDictionary::wrap_under_get_rule(t.as_concrete_TypeRef() as _) };
                t.find(unsafe { CFString::wrap_under_get_rule(kCTFontSymbolicTrait) })
                    .map(|v| v.clone())
            })
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i64())
            .is_some_and(|bits| bits as u32 & kCTFontMonoSpaceTrait != 0);
        Some((family, mono))
    }

    /// `(style name, file)`, or `None` when either attribute is missing.
    pub fn style_and_path(d: &CTFontDescriptor) -> Option<(String, std::path::PathBuf)> {
        let style = attribute(d, unsafe { kCTFontStyleNameAttribute })?
            .downcast::<CFString>()?
            .to_string();
        let path = attribute(d, unsafe { kCTFontURLAttribute })?
            .downcast::<CFURL>()?
            .to_path()?;
        Some((style, path))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn installed_monospace() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face(name: &str, mono: bool) -> (String, bool) {
        (name.to_string(), mono)
    }

    #[test]
    fn keeps_monospace_families_once_sorted() {
        let got = monospace_families([
            face("Menlo", true),
            face("lilex", true),
            face("Helvetica", false),
            face("Menlo", true),
            face(".SF NS Mono", true),
            face("", true),
            face("Fira Code", true),
        ]);
        assert_eq!(got, ["Fira Code", "lilex", "Menlo"]);
    }

    #[test]
    fn web_loadable_takes_single_face_files_outside_the_system() {
        use std::path::Path;
        assert!(web_loadable(Path::new("/Users/me/Library/Fonts/Lilex-Regular.otf")));
        assert!(web_loadable(Path::new("/Library/Fonts/Foo.TTF")));
        assert!(!web_loadable(Path::new("/Users/me/Library/Fonts/Iosevka.ttc")));
        assert!(!web_loadable(Path::new("/System/Library/Fonts/SFNSMono.ttf")));
        assert!(!web_loadable(Path::new("/Users/me/Library/Fonts/Old.dfont")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_fonts_have_no_face_file() {
        assert_eq!(face_file("Menlo", "Regular"), None);
        assert_eq!(face_file("No Such Family 1234", "Regular"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_menlo_on_macos() {
        assert!(installed_monospace().iter().any(|f| f == "Menlo"));
    }
}
