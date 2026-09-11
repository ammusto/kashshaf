//! Arabic query normalization shared by search, highlighting and the token
//! cache. Must stay identical to the normalization the pipeline applies
//! before indexing `surface_text` (alif/hamza folding, tashkil removal,
//! Persian/Urdu letter folds).

/// Normalize Arabic text for search: removes diacritics, normalizes
/// hamza/alif variants and common Persian/Urdu letter forms.
pub fn normalize_arabic(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{0671}' => None,
            'أ' | 'إ' | 'آ' => Some('ا'),
            'ؤ' => Some('و'),
            'ئ' | 'ى' => Some('ي'),
            'ک' | 'گ' | 'ڭ' => Some('ك'),
            'ی' | 'ے' => Some('ي'),
            'ۀ' | 'ە' => Some('ه'),
            'ۃ' => Some('ة'),
            'ٹ' => Some('ت'),
            'پ' => Some('ب'),
            'چ' => Some('ج'),
            'ژ' => Some('ز'),
            'ڤ' => Some('ف'),
            'ڨ' => Some('ق'),
            _ => Some(c),
        })
        .collect()
}

/// Convert a root query to the indexed format: letters joined with `.`,
/// weak letters (و ي ا ء) replaced with `#`. `قول` -> `ق.#.ل`.
pub fn normalize_root_query(query: &str) -> String {
    let normalized = normalize_arabic(query);
    let weak_letters = ['و', 'ي', 'ا', 'ء'];

    normalized
        .split_whitespace()
        .map(|word| {
            word.chars()
                .map(|c| {
                    if weak_letters.contains(&c) {
                        "#".to_string()
                    } else {
                        c.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(".")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Count Arabic letters (excluding diacritics). Used by wildcard validation.
pub fn count_arabic_letters(text: &str) -> usize {
    text.chars()
        .filter(|c| {
            let code = *c as u32;
            (0x0621..=0x064A).contains(&code) || (0x0671..=0x06D3).contains(&code)
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_alif_and_strips_tashkil() {
        assert_eq!(normalize_arabic("أَحْمَد"), "احمد");
        assert_eq!(normalize_arabic("إسلام"), "اسلام");
        assert_eq!(normalize_arabic("مؤمن"), "مومن");
    }

    #[test]
    fn root_query_dots_and_weak_letters() {
        assert_eq!(normalize_root_query("علم"), "ع.ل.م");
        assert_eq!(normalize_root_query("قول"), "ق.#.ل");
        assert_eq!(normalize_root_query("قول كتب"), "ق.#.ل ك.ت.ب");
    }

    #[test]
    fn counts_letters_not_diacritics() {
        assert_eq!(count_arabic_letters("أَح"), 2);
        assert_eq!(count_arabic_letters("abc"), 0);
    }
}
