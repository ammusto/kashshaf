//! The shipped Qurʾān satisfies the alignment contract (spec §3.3, §4.4):
//! every sūra line's token count is what the tokenizer finds in its body,
//! and the āya ranges partition each sūra exactly as the tokenizer splits
//! the āya texts. Not gated: the data is inside the binary.

use kashshaf_lab_lib::analysis::align::display_token_count;
use kashshaf_lab_lib::quran_data::QuranText;

struct Dir(std::path::PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn load() -> (QuranText, Dir) {
    let dir = std::env::temp_dir().join(format!("kashshaf-lab-quran-{}-{}", std::process::id(), rand_tag()));
    std::fs::create_dir_all(&dir).unwrap();
    let q = QuranText::load(&dir).expect("embedded Qurʾān loads");
    (q, Dir(dir))
}

fn rand_tag() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

#[test]
fn shape() {
    let (q, _d) = load();
    assert_eq!(q.pages.len(), 114);
    assert_eq!(q.ayas.len(), 6236);
    assert_eq!(q.token_count(), 78_248);
    assert_eq!(q.sura(1).unwrap().name, "الفاتحة");
    assert_eq!(q.sura(2).unwrap().ayas, 286);
    assert_eq!(q.info["ingest_version"], "1");
    assert!(q.pages.iter().all(|p| p.book_id == 0 && p.part_index == 0));
    assert!(q.pages.iter().all(|p| p.tokens.iter().enumerate().all(|(i, t)| t.idx == i)));
}

#[test]
fn alignment_contract_holds_on_every_sura() {
    let (q, _d) = load();
    for p in &q.pages {
        assert_eq!(display_token_count(&p.body), p.tokens.len(), "sūra {}", p.page_id);
    }
}

#[test]
fn aya_ranges_partition_each_sura_and_match_the_tokenizer() {
    let (q, _d) = load();
    let mut expect = 0usize;
    let mut sura = 0u32;
    for a in &q.ayas {
        if a.sura != sura {
            assert_eq!(expect, sura.checked_sub(1).map(|s| q.pages[s as usize].tokens.len()).unwrap_or(0), "sūra {} ends where its ayāt end", sura);
            sura = a.sura;
            expect = 0;
        }
        assert_eq!(a.tok_start, expect, "{}:{} starts where the previous āya ends", a.sura, a.aya);
        assert!(a.tok_end > a.tok_start, "{}:{} is not empty", a.sura, a.aya);
        // The āya's own text tokenizes to exactly its range.
        let (text, uthmani) = q.aya_text(a.sura, a.aya).unwrap();
        assert_eq!(display_token_count(&text), a.tok_end - a.tok_start, "{}:{} text", a.sura, a.aya);
        assert!(!uthmani.is_empty());
        expect = a.tok_end;
    }
    assert_eq!(expect, q.pages[113].tokens.len());
}

#[test]
fn lookups() {
    let (q, _d) = load();
    let kursi = *q.aya(2, 255).unwrap();
    assert_eq!(q.aya_tokens(&kursi).len(), 50);
    assert_eq!(q.aya_tokens(&kursi)[0].lemma, "الله");
    assert_eq!(q.aya_at(2, kursi.tok_start), Some(&kursi));
    assert_eq!(q.aya_at(2, kursi.tok_end - 1), Some(&kursi));
    assert_ne!(q.aya_at(2, kursi.tok_end), Some(&kursi));
    assert!(q.aya_at(2, 1_000_000).is_none());
    assert!(q.aya_at(115, 0).is_none());
    // Fātiḥa: 7 āyāt, 29 tokens; the basmala is 1:1.
    assert_eq!(q.aya(1, 1).unwrap().tok_end, 4);
    assert_eq!(q.aya_tokens(q.aya(1, 1).unwrap()).iter().map(|t| t.lemma.as_str()).collect::<Vec<_>>(), ["سم", "الله", "رحمن", "رحيم"]);
}
