use super::*;

#[test]
fn only_a_complete_answer_confirms_or_cancels() {
    assert_eq!(classify_uninstall_confirmation("Sim!"), Decision::Confirm);
    assert_eq!(
        classify_uninstall_confirmation("  Não  desinstale. "),
        Decision::Cancel
    );
    assert_eq!(
        classify_uninstall_confirmation("yes, and also list zones"),
        Decision::Ambiguous
    );
    assert_eq!(classify_uninstall_confirmation(""), Decision::Ambiguous);
    assert!(capability_continuation("Pode instalar?"));
    assert!(!capability_continuation(
        "Pode instalar o Slack e listar canais?"
    ));
}

#[test]
fn search_text_keeps_words_of_any_script_and_splits_spaceless_runs() {
    assert_eq!(search_text("Café, DNS-zones!"), "cafe dns zones");
    assert_eq!(search_text("安装云flare"), "安装云 flare");
    assert_eq!(
        tokens(&["安装云"]),
        vec!["安装".to_owned(), "装云".to_owned()]
    );
    assert_eq!(tokens(&["the a shimpz"]), Vec::<String>::new());
}

#[test]
fn a_phrase_matches_only_at_word_edges_in_spaced_scripts() {
    assert!(contains_phrase("install cloudflare now", "Cloudflare"));
    assert!(!contains_phrase("install cloudflares now", "Cloudflare"));
    assert!(contains_phrase("安装云flare", "云"));
    assert!(!contains_phrase("anything", ""));
}

fn capability(id: &str) -> Capability {
    Capability {
        assistant_id: id.to_owned(),
        name: id.to_owned(),
        summary: String::new(),
        actions: vec!["run".to_owned()],
        integrations: Vec::new(),
    }
}

#[test]
fn a_tie_across_the_bound_yields_no_pool() {
    let tied: Vec<(usize, String, u8)> = (0..3).map(|index| (10, format!("a{index}"), 0)).collect();
    assert_eq!(bounded_pool(ranked(tied), 2), Vec::<u8>::new());
    let distinct: Vec<(usize, String, u8)> = vec![
        (30, "b".to_owned(), 1),
        (20, "a".to_owned(), 2),
        (10, "c".to_owned(), 3),
    ];
    assert_eq!(bounded_pool(ranked(distinct), 2), vec![2, 1]);
    let candidates: Vec<UninstallCandidate> = ["cloudflare", "slack"]
        .iter()
        .map(|id| UninstallCandidate {
            assistant: capability(id),
            version: "1.0.0".to_owned(),
            provenance: "published".to_owned(),
        })
        .collect();
    assert_eq!(uninstall_shortlist("remove slack", &candidates).len(), 2);
    assert_eq!(uninstall_shortlist("!!", &candidates), Vec::new());
}
