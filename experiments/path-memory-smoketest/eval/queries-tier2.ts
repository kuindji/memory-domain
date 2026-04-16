import type { ClaimId, RetrievalMode } from "../src/types.js";

export type EvalQueryTier2 = {
    name: string;
    probes: string[];
    naturalQuery: string;
    ideal: ClaimId[];
    mode?: RetrievalMode;
};

// Five categories, ordered as they appear in the file:
//
//   cross-cluster multi-probe (1-6)  — exercise A2/A3; ideal claims
//                                       live in different id-prefix
//                                       clusters from each other.
//   within-cluster multi-claim (7-12) — recall under K == |ideal|.
//   as-of historical state    (13-16) — exercise bitemporal-light.
//   strong-literal-cue control (17-19) — baseline should win or tie.
//
// Timestamp reminder: years since 800 BCE (positive integers). So
// `at: 460` means "as of 340 BCE". Ideal claim ids must be valid
// under the asOf mode (validFrom <= at < validUntil).

export const queriesTier2: EvalQueryTier2[] = [
    // --- cross-cluster multi-probe -------------------------------
    {
        name: "philosophers who taught Alexander",
        probes: [
            "philosophers who influenced Alexander the Great",
            "teachers and tutors of Alexander",
        ],
        naturalQuery: "Which philosophers taught or influenced Alexander?",
        ideal: ["phil_aristotle_tutors_alexander", "phil_diogenes_alexander"],
    },
    {
        name: "Athenians at Salamis",
        probes: ["Athenians who fought at the Battle of Salamis", "Greek commanders at Salamis"],
        naturalQuery: "Who from Athens fought at the Battle of Salamis?",
        ideal: ["pw_salamis_victory", "art_aeschylus_salamis", "pw_themistocles_fleet"],
    },
    {
        name: "historians of the Peloponnesian War",
        probes: [
            "historians who wrote about the Peloponnesian War",
            "chroniclers of the Athens Sparta conflict",
        ],
        naturalQuery: "Which historians chronicled the Peloponnesian War?",
        ideal: [
            "pwar_thucydides_writes",
            "art_thucydides_method",
            "art_thucydides_general",
            "art_thucydides_exiled",
        ],
    },
    {
        name: "Ptolemaic Egypt",
        probes: ["Ptolemaic rule over Egypt", "Egypt under the successors of Alexander"],
        naturalQuery: "Who ruled Egypt after Alexander the Great?",
        ideal: [
            "diad_ptolemy_egypt",
            "diad_ptolemaic_dynasty",
            "diad_library_alexandria",
            "diad_museum_alexandria",
        ],
    },
    {
        name: "students of Plato",
        probes: ["pupils who studied at Plato's Academy", "students of Plato"],
        naturalQuery: "Who studied at Plato's Academy?",
        ideal: ["phil_aristotle_academy_joins", "phil_speusippus_academy"],
    },
    {
        name: "kings of Macedon",
        probes: ["rulers of Macedon", "kings of the Macedonian kingdom"],
        naturalQuery: "Who were the kings of Macedon?",
        ideal: ["alex_philip_king", "alex_macedon_king", "diad_cassander_macedon"],
    },

    // --- within-cluster multi-claim ------------------------------
    {
        name: "Alexander's victories over Persia",
        probes: [
            "Alexander's battles against the Persian Empire",
            "victories of Alexander over Darius",
        ],
        naturalQuery: "Which battles did Alexander win against the Persians?",
        ideal: ["alex_granicus", "alex_issus", "alex_gaugamela"],
    },
    {
        name: "students of Socrates",
        probes: ["pupils of Socrates", "disciples who learned from Socrates"],
        naturalQuery: "Who were the students of Socrates?",
        ideal: ["phil_plato_socrates_pupil", "phil_xenophon_pupil"],
    },
    {
        name: "reforms of Cleisthenes",
        probes: ["reforms by Cleisthenes", "Cleisthenic reorganization of Athens"],
        naturalQuery: "What reforms did Cleisthenes introduce in Athens?",
        ideal: [
            "pol_cleisthenes_reforms",
            "pol_cleisthenes_council_500",
            "pol_cleisthenes_ostracism",
            "pol_cleisthenes_democracy",
        ],
    },
    {
        name: "Plato's dialogues",
        probes: ["dialogues written by Plato", "major works of Plato"],
        naturalQuery: "What did Plato write?",
        ideal: ["phil_plato_republic", "phil_plato_symposium", "phil_plato_forms"],
    },
    {
        name: "Ionian Revolt",
        probes: ["Ionian Greek revolt against Persia", "cities that revolted against Persian rule"],
        naturalQuery: "Tell me about the Ionian Revolt.",
        ideal: [
            "pw_ionian_revolt_start",
            "pw_sardis_burned",
            "pw_lade_defeat",
            "pw_miletus_sacked",
        ],
    },
    {
        name: "Athenian tragic playwrights",
        probes: ["tragic playwrights of Athens", "Greek tragedy writers of the classical period"],
        naturalQuery: "Who were the great Athenian tragedians?",
        ideal: [
            "art_aeschylus_persians",
            "art_aeschylus_oresteia",
            "art_sophocles_antigone",
            "art_sophocles_oedipus",
            "art_euripides_medea",
            "art_euripides_bacchae",
        ],
    },

    // --- as-of historical state ----------------------------------
    {
        // 330 BCE — Alexander has taken Egypt (468) but hasn't yet died (477).
        name: "as-of: ruler of Egypt in 330 BCE",
        probes: ["ruler of Egypt", "who controls Egypt"],
        naturalQuery: "Who ruled Egypt in 330 BCE?",
        ideal: ["alex_egypt_rule"],
        mode: { kind: "asOf", at: 470 },
    },
    {
        // 300 BCE — Ptolemy has taken Egypt (478), Alexander's rule superseded.
        name: "as-of: ruler of Egypt in 300 BCE",
        probes: ["ruler of Egypt", "who controls Egypt"],
        naturalQuery: "Who ruled Egypt in 300 BCE?",
        ideal: ["diad_ptolemy_egypt"],
        mode: { kind: "asOf", at: 500 },
    },
    {
        // 340 BCE — Speusippus took over the Academy at 452; Plato is dead.
        name: "as-of: head of the Academy in 340 BCE",
        probes: ["head of the Academy", "leader of Plato's school"],
        naturalQuery: "Who led the Academy in 340 BCE?",
        ideal: ["phil_speusippus_academy"],
        mode: { kind: "asOf", at: 460 },
    },
    {
        // 450 BCE — Pericles is the leading statesman (339 onwards, dies 371).
        name: "as-of: leading Athenian statesman in 450 BCE",
        probes: ["leading statesman of Athens", "Athenian political leader"],
        naturalQuery: "Who was the leading Athenian statesman in 450 BCE?",
        ideal: ["pol_pericles_leader"],
        mode: { kind: "asOf", at: 350 },
    },

    // --- strong-literal-cue control ------------------------------
    // Baseline cosine should tie or beat path retriever here — cheap
    // literal-token cue ("hemlock", "Bucephalus", "Pythagorean") is
    // enough without graph structure. Protects against over-optimizing
    // path retrieval into hurting the easy cases.
    {
        name: "Socrates' poison",
        probes: ["Socrates poison", "Socrates hemlock"],
        naturalQuery: "What did Socrates drink when he was executed?",
        ideal: ["phil_socrates_executed"],
    },
    {
        name: "Alexander's horse",
        probes: ["Alexander's warhorse", "Alexander's famous horse"],
        naturalQuery: "What was the name of Alexander's horse?",
        ideal: ["alex_bucephalus"],
    },
    {
        name: "Pythagorean theorem",
        probes: ["Pythagorean theorem", "Pythagoras right triangle"],
        naturalQuery: "Who is credited with the Pythagorean theorem?",
        ideal: ["phil_pythagorean_theorem"],
    },
];
