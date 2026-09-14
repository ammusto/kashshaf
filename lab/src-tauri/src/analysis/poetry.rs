//! Poetry extraction (Lab spec §4.6, experimental).
//!
//! **Candidates.** A line of a page body is a verse when it carries a
//! hemistich marker — `۞`, ` ... `, or the `%~%` residue the pipeline leaves
//! — or when wide whitespace (three spaces or a tab) splits it into two
//! segments of near-equal length. Each candidate carries its page
//! coordinates as a token range.
//!
//! **Meter.** Only where the hemistich is vowelled: the surface is written
//! prosodically as a string of mutaḥarrik (`/`) and sākin (`o`) units by the
//! standard rules (a short vowel is `/`, a sukūn or a long vowel is `o`, a
//! shadda doubles its letter, tanwīn adds a sākin nūn, the hamzat al-waṣl of
//! the article is dropped after a vowel, and the final unit of a hemistich
//! is read pausally), and the string is matched against the sixteen meters'
//! feet with their common ziḥāfāt. A hemistich that is not fully vowelled,
//! or that matches no meter, is `unknown` — never a guess; one that matches
//! several is reported with all of them.

use crate::analysis::align::{char_to_token_map, strip_html};
use serde::{Deserialize, Serialize};

pub const EXTRACTOR_VERSION: &str = "0.1.0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Verse {
    /// The line's index in the page body (after HTML stripping).
    pub line: usize,
    /// Page token range of the whole line.
    pub tok_start: usize,
    pub tok_end: usize,
    /// Token range of each hemistich.
    pub h1: (usize, usize),
    pub h2: Option<(usize, usize)>,
    pub h1_text: String,
    pub h2_text: String,
    /// What made it a candidate: `۞`, `...`, `%~%`, or `whitespace`.
    pub marker: String,
    /// Share of consonants carrying a mark in the first hemistich.
    pub vowelled: f64,
    /// Meters the first hemistich scans as; empty = unknown.
    pub meters: Vec<String>,
    /// The prosodic writing of the first hemistich, for the "why".
    pub pattern: String,
}

const MIN_HEMISTICH_CHARS: usize = 8;

/// Split one line into hemistichs, if it looks like a verse.
fn split_line(line: &str) -> Option<(String, String, &'static str)> {
    let t = line.trim();
    if t.chars().count() < MIN_HEMISTICH_CHARS * 2 {
        return None;
    }
    for (needle, label) in [("۞", "۞"), ("%~%", "%~%"), (" ... ", "..."), (" … ", "...")] {
        if let Some(i) = t.find(needle) {
            let (a, b) = (t[..i].trim(), t[i + needle.len()..].trim());
            if a.chars().count() >= MIN_HEMISTICH_CHARS && b.chars().count() >= MIN_HEMISTICH_CHARS {
                return Some((a.to_string(), b.to_string(), label));
            }
        }
    }
    // Wide whitespace between two near-equal halves.
    let mut best: Option<(usize, usize)> = None; // (byte offset, gap chars)
    let bytes = t.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\t' || (bytes[i] == b' ' && i + 2 < bytes.len() && bytes[i + 1] == b' ' && bytes[i + 2] == b' ') {
            let start = i;
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            let gap = i - start;
            if best.map(|b| gap > b.1).unwrap_or(true) {
                best = Some((start, gap));
            }
        } else {
            i += 1;
        }
    }
    let (at, _) = best?;
    let (a, b) = (t[..at].trim(), t[at..].trim());
    let (la, lb) = (a.chars().count(), b.chars().count());
    if la < MIN_HEMISTICH_CHARS || lb < MIN_HEMISTICH_CHARS {
        return None;
    }
    let ratio = la as f64 / lb as f64;
    if !(0.6..=1.66).contains(&ratio) {
        return None;
    }
    Some((a.to_string(), b.to_string(), "whitespace"))
}

fn is_letter(c: char) -> bool {
    super::align::is_arabic_letter(c)
}

fn is_mark(c: char) -> bool {
    super::align::is_tashkil(c)
}

/// Share of letters that carry a mark (or are a long-vowel letter).
pub fn vowelled_share(s: &str) -> f64 {
    let chars: Vec<char> = s.chars().collect();
    let mut letters = 0usize;
    let mut marked = 0usize;
    for (i, &c) in chars.iter().enumerate() {
        if !is_letter(c) {
            continue;
        }
        letters += 1;
        let next_mark = chars.get(i + 1).map(|n| is_mark(*n)).unwrap_or(false);
        if next_mark || matches!(c, 'ا' | 'آ' | 'ى' | 'ٱ') {
            marked += 1;
        }
    }
    if letters == 0 { 0.0 } else { marked as f64 / letters as f64 }
}

/// The prosodic writing of a vowelled hemistich: `/` mutaḥarrik, `o` sākin.
/// `None` when a letter has no reading (unvowelled), so nothing is guessed.
pub fn prosody(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().filter(|c| is_letter(*c) || is_mark(*c) || *c == ' ').collect();
    let mut out = String::new();
    let mut i = 0;
    let mut prev_vowel: Option<char> = None; // the last short vowel written
    let mut at_word_start = true;
    while i < chars.len() {
        let c = chars[i];
        if c == ' ' {
            at_word_start = true;
            i += 1;
            continue;
        }
        if is_mark(c) {
            i += 1;
            continue;
        }
        // Collect the marks on this letter.
        let mut j = i + 1;
        let mut marks: Vec<char> = Vec::new();
        while j < chars.len() && is_mark(chars[j]) {
            marks.push(chars[j]);
            j += 1;
        }
        let shadda = marks.contains(&'\u{0651}');
        let sukun = marks.contains(&'\u{0652}');
        let short = marks.iter().find(|m| matches!(m, '\u{064E}' | '\u{064F}' | '\u{0650}')).copied();
        let tanwin = marks.iter().find(|m| matches!(m, '\u{064B}' | '\u{064C}' | '\u{064D}')).copied();
        let dagger = marks.contains(&'\u{0670}');
        let next_is_letter = j < chars.len() && is_letter(chars[j]);

        match c {
            // Hamzat al-waṣl (ٱ, or a bare alif opening a word after a vowel): silent.
            'ٱ' => {
                i = j;
                at_word_start = false;
                continue;
            }
            'ا' if at_word_start && short.is_none() && prev_vowel.is_some() && !out.is_empty() => {
                i = j;
                at_word_start = false;
                continue;
            }
            // A long vowel or a bare alif: sākin.
            'ا' | 'ى' if short.is_none() && !shadda => {
                out.push('o');
                prev_vowel = None;
            }
            'آ' => {
                out.push('/');
                out.push('o');
                prev_vowel = None;
            }
            'و' | 'ي' if short.is_none() && !shadda && !sukun && tanwin.is_none() => {
                // Written without a mark: a long vowel after its vowel, else unreadable.
                match (c, prev_vowel) {
                    ('و', Some('\u{064F}')) | ('ي', Some('\u{0650}')) => {
                        out.push('o');
                        prev_vowel = None;
                    }
                    _ => return None,
                }
            }
            _ => {
                if shadda {
                    out.push('o');
                }
                if let Some(v) = short {
                    out.push('/');
                    prev_vowel = Some(v);
                    if dagger {
                        out.push('o');
                        prev_vowel = None;
                    }
                } else if tanwin.is_some() {
                    // Tanwīn: the vowel, then a sākin nūn.
                    out.push('/');
                    out.push('o');
                    prev_vowel = None;
                } else if sukun {
                    out.push('o');
                    prev_vowel = None;
                } else if !next_is_letter && j >= chars.len() {
                    // A bare final letter: read with pausal sukūn.
                    out.push('o');
                    prev_vowel = None;
                } else {
                    return None;
                }
            }
        }
        at_word_start = false;
        i = j;
    }
    // Pausal reading: the hemistich ends on a sākin.
    if out.ends_with('/') {
        out.push('o');
    }
    Some(out)
}

/// A foot slot: the forms it may take (base and its common ziḥāfāt).
type Foot = &'static [&'static str];

const FAULUN: Foot = &["//o/o", "//o/", "//oo", "//o"]; // فعولن، فعولُ، فعولْ، فعو
const MAFAILUN: Foot = &["//o/o/o", "//o//o", "//o/o/", "//o/o"]; // مفاعيلن، مفاعلن، مفاعيلُ، مفاعي
const FAILATUN: Foot = &["/o//o/o", "///o/o", "/o//o/", "/o//o", "///o", "/o//"]; // فاعلاتن، فعلاتن، فاعلاتُ، فاعلن، فعلن
const FAILUN: Foot = &["/o//o", "///o", "/o/o", "/o/"]; // فاعلن، فعِلن، فعْلن، فاعِلْ
const MUSTAFILUN: Foot = &["/o/o//o", "//o//o", "/o///o", "////o", "/o/o/o", "/o/o//"]; // مستفعلن، متفعلن، مستعلن، متعلن، مفعولن، مستفعلُ
const MUFAALATUN: Foot = &["//o///o", "//o/o/o", "//o//o", "//o/o"]; // مفاعلتن، مفاعلْتن، مفاعلن، فعولن
const MUTAFAILUN: Foot = &["///o//o", "/o/o//o", "///o/o", "///o//oo", "/o/o/o"]; // متفاعلن، متْفاعلن، فعِلاتن، متفاعلان، مفعولن
const MAFULATU: Foot = &["/o/o/o/", "/o/o/o", "//o/o/", "/o//o/"]; // مفعولاتُ، مفعولان، معولاتُ، مفعلاتُ

/// The sixteen meters as sequences of foot slots for one hemistich.
const METERS: &[(&str, &[Foot])] = &[
    ("الطويل", &[FAULUN, MAFAILUN, FAULUN, MAFAILUN]),
    ("المديد", &[FAILATUN, FAILUN, FAILATUN]),
    ("البسيط", &[MUSTAFILUN, FAILUN, MUSTAFILUN, FAILUN]),
    ("الوافر", &[MUFAALATUN, MUFAALATUN, FAULUN]),
    ("الكامل", &[MUTAFAILUN, MUTAFAILUN, MUTAFAILUN]),
    ("الهزج", &[MAFAILUN, MAFAILUN]),
    ("الرجز", &[MUSTAFILUN, MUSTAFILUN, MUSTAFILUN]),
    ("الرمل", &[FAILATUN, FAILATUN, FAILATUN]),
    ("السريع", &[MUSTAFILUN, MUSTAFILUN, FAILUN]),
    ("المنسرح", &[MUSTAFILUN, MAFULATU, MUSTAFILUN]),
    ("الخفيف", &[FAILATUN, MUSTAFILUN, FAILATUN]),
    ("المضارع", &[MAFAILUN, FAILATUN]),
    ("المقتضب", &[MAFULATU, MUSTAFILUN]),
    ("المجتث", &[MUSTAFILUN, FAILATUN]),
    ("المتقارب", &[FAULUN, FAULUN, FAULUN, FAULUN]),
    ("المتدارك", &[FAILUN, FAILUN, FAILUN, FAILUN]),
    // Majzūʾ forms: two feet of the trimeters.
    ("الكامل (مجزوء)", &[MUTAFAILUN, MUTAFAILUN]),
    ("الرجز (مجزوء)", &[MUSTAFILUN, MUSTAFILUN]),
    ("الرمل (مجزوء)", &[FAILATUN, FAILATUN]),
    ("الوافر (مجزوء)", &[MUFAALATUN, MUFAALATUN]),
    ("المتقارب (مجزوء)", &[FAULUN, FAULUN, FAULUN]),
];

fn matches_feet(pattern: &str, feet: &[Foot]) -> bool {
    fn go(p: &str, feet: &[Foot]) -> bool {
        match feet.split_first() {
            None => p.is_empty(),
            Some((foot, rest)) => foot.iter().any(|f| p.starts_with(f) && go(&p[f.len()..], rest)),
        }
    }
    go(pattern, feet)
}

/// Every meter the prosodic pattern scans as, in the canonical order.
pub fn scan(pattern: &str) -> Vec<String> {
    METERS.iter().filter(|(_, feet)| matches_feet(pattern, feet)).map(|(n, _)| n.to_string()).collect()
}

/// Minimum vowelled share for meter detection to be attempted.
pub const MIN_VOWELLED: f64 = 0.6;

/// Every verse candidate on a page, with page token coordinates.
pub fn extract_page(body: &str) -> Vec<Verse> {
    let text = strip_html(body);
    let map = char_to_token_map(&text);
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut line_start = 0usize;
    let mut line_no = 0usize;
    for (i, &c) in chars.iter().enumerate().chain(std::iter::once((chars.len(), &'\n'))) {
        if c != '\n' {
            continue;
        }
        let line: String = chars[line_start..i].iter().collect();
        if let Some((h1, h2, marker)) = split_line(&line) {
            // Token ranges: the line's, and each hemistich's by its characters.
            let tokens_in = |from: usize, to: usize| -> Option<(usize, usize)> {
                let mut lo = None;
                let mut hi = None;
                for k in from..to.min(map.len()) {
                    if let Some(t) = map[k] {
                        lo.get_or_insert(t);
                        hi = Some(t + 1);
                    }
                }
                lo.zip(hi)
            };
            let h1_at = line.find(&h1).unwrap_or(0);
            let h2_at = line.rfind(&h2).unwrap_or(line.len());
            let cidx = |byte: usize| line[..byte.min(line.len())].chars().count();
            let (h1c0, h1c1) = (line_start + cidx(h1_at), line_start + cidx(h1_at + h1.len()));
            let (h2c0, h2c1) = (line_start + cidx(h2_at), line_start + cidx(h2_at + h2.len()));
            if let (Some(r1), Some(r2)) = (tokens_in(h1c0, h1c1), tokens_in(h2c0, h2c1)) {
                let v = vowelled_share(&h1);
                let (pattern, meters) = if v >= MIN_VOWELLED {
                    match prosody(&h1) {
                        Some(p) => {
                            let m = scan(&p);
                            (p, m)
                        }
                        None => (String::new(), vec![]),
                    }
                } else {
                    (String::new(), vec![])
                };
                out.push(Verse {
                    line: line_no,
                    tok_start: r1.0,
                    tok_end: r2.1.max(r1.1),
                    h1: r1,
                    h2: Some(r2),
                    h1_text: h1,
                    h2_text: h2,
                    marker: marker.to_string(),
                    vowelled: v,
                    meters,
                    pattern,
                });
            }
        }
        line_start = i + 1;
        line_no += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vowelled_hemistich_scans_as_its_meter() {
        // Imruʾ al-Qays: ṭawīl.
        let p = prosody("قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ").unwrap();
        assert_eq!(p, "//o/o//o/o/o//o/o//o//o");
        assert_eq!(scan(&p), vec!["الطويل"]);
        // Kāmil: كَأَنَّ الْمَوْتَ ... — a plain line of three متفاعلن.
        let p = prosody("وَإِذَا صَحَوْتُ فَمَا أُقَصِّرُ عَنْ نَدًى").unwrap();
        assert_eq!(scan(&p), vec!["الكامل"], "{}", p);
        // Mutaqārib: فعولن ×4.
        let p = prosody("فَلَا تَحْسَبَنَّ الْحَيَاةَ لَهُمْ").unwrap();
        assert!(scan(&p).contains(&"المتقارب".to_string()), "{}", p);
    }

    #[test]
    fn an_unvowelled_hemistich_is_unknown_not_guessed() {
        assert_eq!(prosody("قفا نبك من ذكرى حبيب ومنزل"), None);
        assert!(vowelled_share("قفا نبك من ذكرى حبيب ومنزل") < MIN_VOWELLED);
        assert!(vowelled_share("قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ") > 0.9);
        // Vowelled but scanning as nothing: unknown, not the nearest meter.
        assert!(scan("////////////").is_empty());
    }

    #[test]
    fn candidates_come_from_markers_and_wide_whitespace_with_coordinates() {
        let body = "قال الشاعر:<br>قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ ۞ بِسِقْطِ اللِّوَى بَيْنَ الدَّخُولِ فَحَوْمَلِ<br>وهذا كلام نثر عادي لا يقسم إلى شطرين<br>فَتُوضِحَ فَالْمِقْرَاةِ لَمْ يَعْفُ رَسْمُهَا     لِمَا نَسَجَتْهَا مِنْ جَنُوبٍ وَشَمْأَلِ";
        let vs = extract_page(body);
        assert_eq!(vs.len(), 2, "{:?}", vs.iter().map(|v| (v.line, &v.marker)).collect::<Vec<_>>());
        assert_eq!(vs[0].marker, "۞");
        assert_eq!(vs[0].line, 1);
        assert_eq!(vs[0].h1, (2, 8), "قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ are tokens 2–7");
        // ۞ (U+06DE) is an Arabic letter to the tokenizer, so it is token 8.
        assert_eq!(vs[0].h2.map(|h| h.0), Some(9));
        assert_eq!(vs[0].meters, vec!["الطويل"]);
        assert_eq!(vs[1].marker, "whitespace");
        assert_eq!(vs[1].line, 3);
        assert!(vs[1].vowelled > 0.9);
        // The prose line splits nowhere.
        assert!(split_line("وهذا كلام نثر عادي لا يقسم إلى شطرين").is_none());
        assert!(split_line("قصير ۞ قصير").is_none(), "hemistichs too short");
    }
}
