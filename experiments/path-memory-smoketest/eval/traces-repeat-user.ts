import type { ClaimId, RetrievalMode } from "../src/types.js";

// Phase 2.9 — eval-C: repeat-user multi-session traces.
//
// Each trace simulates a single user returning across multiple sessions,
// asking overlapping-but-evolving questions that revisit the same cluster
// neighborhood. Shared graph, fresh session per block — measures whether
// access concentrates on a stable well-worn path across sessions.
//
// See experiments/path-memory-smoketest/PLAN-post-2.8.md § "Phase 2.9"
// for methodology and pass criterion (edge top-5 share >=5x uniform).

export type RepeatUserTurn = {
    probes: string[];
    naturalQuery: string;
    expectedClaimsAfterThisTurn: ClaimId[];
};

export type RepeatUserSession = {
    label: string;
    turns: RepeatUserTurn[];
};

export type RepeatUserTrace = {
    name: string;
    description: string;
    mode?: RetrievalMode;
    sessions: RepeatUserSession[];
};

export const tracesRepeatUser: RepeatUserTrace[] = [
    // ================================================================
    // Trace 1 — Plato & the Academy arc (phil_ cluster focus)
    // ================================================================
    {
        name: "plato-academy-returning",
        description:
            "User keeps returning over weeks to explore Plato's Academy from different angles: dialogues, predecessors, pupils, rivals, legacy.",
        sessions: [
            {
                label: "S1: Plato's dialogues and core works",
                turns: [
                    {
                        probes: ["Plato's most famous written works", "dialogues by Plato"],
                        naturalQuery: "What did Plato write?",
                        expectedClaimsAfterThisTurn: [
                            "phil_plato_republic",
                            "phil_plato_symposium",
                            "phil_plato_forms",
                        ],
                    },
                    {
                        probes: ["Plato's theory of forms", "the theory of ideas in Plato"],
                        naturalQuery: "What is Plato's theory of forms?",
                        expectedClaimsAfterThisTurn: ["phil_plato_forms"],
                    },
                    {
                        probes: ["Plato on the ideal state", "politics in the Republic"],
                        naturalQuery: "What did Plato say about government?",
                        expectedClaimsAfterThisTurn: ["phil_plato_republic"],
                    },
                    {
                        probes: ["Plato Symposium on love", "speeches about eros in Plato"],
                        naturalQuery: "What is the Symposium about?",
                        expectedClaimsAfterThisTurn: ["phil_plato_symposium"],
                    },
                    {
                        probes: ["when did Plato die", "end of Plato's life"],
                        naturalQuery: "When did Plato die?",
                        expectedClaimsAfterThisTurn: ["phil_plato_dies"],
                    },
                ],
            },
            {
                label: "S2: Plato's teacher Socrates",
                turns: [
                    {
                        probes: ["Plato and Socrates relationship", "Socrates as Plato's teacher"],
                        naturalQuery: "How did Plato meet Socrates?",
                        expectedClaimsAfterThisTurn: [
                            "phil_plato_socrates_pupil",
                            "phil_socrates_born",
                        ],
                    },
                    {
                        probes: ["Socratic method questioning", "elenchus dialectic"],
                        naturalQuery: "What is the Socratic method?",
                        expectedClaimsAfterThisTurn: ["phil_socratic_method"],
                    },
                    {
                        probes: ["trial of Socrates", "Socrates condemned in Athens"],
                        naturalQuery: "Why was Socrates executed?",
                        expectedClaimsAfterThisTurn: [
                            "phil_socrates_tried",
                            "phil_socrates_executed",
                        ],
                    },
                    {
                        probes: ["hemlock death of Socrates", "how Socrates died"],
                        naturalQuery: "How did Socrates die?",
                        expectedClaimsAfterThisTurn: ["phil_socrates_executed"],
                    },
                    {
                        probes: ["Socrates pupils besides Plato", "other students of Socrates"],
                        naturalQuery: "Who else studied under Socrates?",
                        expectedClaimsAfterThisTurn: ["phil_xenophon_pupil"],
                    },
                ],
            },
            {
                label: "S3: The Academy and its pupils",
                turns: [
                    {
                        probes: ["Plato founded the Academy", "when was the Academy opened"],
                        naturalQuery: "When did Plato start the Academy?",
                        expectedClaimsAfterThisTurn: ["phil_plato_academy"],
                    },
                    {
                        probes: ["who studied at Plato's Academy", "pupils of the Academy"],
                        naturalQuery: "Who were Plato's students?",
                        expectedClaimsAfterThisTurn: [
                            "phil_aristotle_academy_joins",
                            "phil_speusippus_academy",
                        ],
                    },
                    {
                        probes: ["Speusippus successor Academy", "who led the Academy after Plato"],
                        naturalQuery: "Who ran the Academy after Plato?",
                        expectedClaimsAfterThisTurn: ["phil_speusippus_academy"],
                    },
                    {
                        probes: ["Aristotle joined the Academy", "Aristotle as Plato's student"],
                        naturalQuery: "Did Aristotle study under Plato?",
                        expectedClaimsAfterThisTurn: [
                            "phil_aristotle_academy_joins",
                            "phil_aristotle_leaves_academy",
                        ],
                    },
                    {
                        probes: ["Aristotle leaves Academy", "why Aristotle left Plato's school"],
                        naturalQuery: "Why did Aristotle leave the Academy?",
                        expectedClaimsAfterThisTurn: ["phil_aristotle_leaves_academy"],
                    },
                ],
            },
            {
                label: "S4: Plato vs Aristotle",
                turns: [
                    {
                        probes: [
                            "differences Plato Aristotle",
                            "Aristotle disagreement with Plato",
                        ],
                        naturalQuery: "How did Aristotle differ from Plato?",
                        expectedClaimsAfterThisTurn: [
                            "phil_aristotle_metaphysics",
                            "phil_plato_forms",
                        ],
                    },
                    {
                        probes: ["Aristotle founded Lyceum", "Aristotle's own school"],
                        naturalQuery: "Did Aristotle have his own school?",
                        expectedClaimsAfterThisTurn: ["phil_aristotle_lyceum"],
                    },
                    {
                        probes: ["Aristotle Nicomachean Ethics", "Aristotle on virtue"],
                        naturalQuery: "What did Aristotle teach about ethics?",
                        expectedClaimsAfterThisTurn: [
                            "phil_aristotle_nicomachean",
                            "phil_aristotle_golden_mean",
                        ],
                    },
                    {
                        probes: ["Aristotle Politics book", "Aristotle on the polis"],
                        naturalQuery: "What did Aristotle write about politics?",
                        expectedClaimsAfterThisTurn: ["phil_aristotle_politics"],
                    },
                    {
                        probes: ["Aristotle dies Euboea", "death of Aristotle"],
                        naturalQuery: "How did Aristotle die?",
                        expectedClaimsAfterThisTurn: [
                            "phil_aristotle_flees",
                            "phil_aristotle_dies",
                        ],
                    },
                ],
            },
            {
                label: "S5: Plato's wider influence",
                turns: [
                    {
                        probes: ["Plato influence later philosophy", "legacy of Plato"],
                        naturalQuery: "What is Plato's legacy?",
                        expectedClaimsAfterThisTurn: ["phil_plato_academy", "phil_plato_forms"],
                    },
                    {
                        probes: ["Plato's visits to Sicily", "Plato and Dionysius"],
                        naturalQuery: "Why did Plato go to Sicily?",
                        expectedClaimsAfterThisTurn: ["phil_plato_sicily"],
                    },
                    {
                        probes: ["Plato's ideal republic philosopher king", "philosopher kings"],
                        naturalQuery: "Who should rule in Plato's ideal city?",
                        expectedClaimsAfterThisTurn: ["phil_plato_republic"],
                    },
                    {
                        probes: [
                            "Plato's relationship to pre-Socratics",
                            "Heraclitus influence Plato",
                        ],
                        naturalQuery: "Which earlier thinkers shaped Plato?",
                        expectedClaimsAfterThisTurn: [
                            "phil_heraclitus_flux",
                            "phil_parmenides_being",
                        ],
                    },
                    {
                        probes: ["Plato born Athens", "early life of Plato"],
                        naturalQuery: "When was Plato born?",
                        expectedClaimsAfterThisTurn: ["phil_plato_born"],
                    },
                ],
            },
        ],
    },

    // ================================================================
    // Trace 2 — Athens at war (pw_/pwar_/pol_ clusters)
    // ================================================================
    {
        name: "athens-at-war-returning",
        description:
            "User explores Athens' military trajectory over many sessions: Persian wars, Delian League, Peloponnesian defeat.",
        sessions: [
            {
                label: "S1: Persian invasions",
                turns: [
                    {
                        probes: ["Persian invasion of Greece", "Darius attacks Athens"],
                        naturalQuery: "When did the Persians invade Greece?",
                        expectedClaimsAfterThisTurn: [
                            "pw_persians_at_marathon",
                            "pw_xerxes_invasion",
                        ],
                    },
                    {
                        probes: ["battle of Marathon", "Athenians at Marathon"],
                        naturalQuery: "What happened at Marathon?",
                        expectedClaimsAfterThisTurn: [
                            "pw_marathon_victory",
                            "pw_miltiades_commands",
                        ],
                    },
                    {
                        probes: ["Thermopylae Leonidas Spartans", "300 at Thermopylae"],
                        naturalQuery: "What happened at Thermopylae?",
                        expectedClaimsAfterThisTurn: [
                            "pw_leonidas_thermopylae",
                            "pw_leonidas_killed",
                        ],
                    },
                    {
                        probes: ["battle of Salamis", "Greek navy defeats Persians"],
                        naturalQuery: "What happened at Salamis?",
                        expectedClaimsAfterThisTurn: ["pw_salamis_victory"],
                    },
                ],
            },
            {
                label: "S2: Persian wars finale",
                turns: [
                    {
                        probes: ["Plataea battle Persian war", "final land battle Persian war"],
                        naturalQuery: "How did the Persian invasion end on land?",
                        expectedClaimsAfterThisTurn: ["pw_plataea_victory", "pw_mardonius_killed"],
                    },
                    {
                        probes: ["Mycale naval battle", "Persian fleet destroyed at Mycale"],
                        naturalQuery: "Where did the Persian fleet meet its end?",
                        expectedClaimsAfterThisTurn: ["pw_mycale_naval"],
                    },
                    {
                        probes: ["Themistocles Athenian fleet", "Athens builds navy"],
                        naturalQuery: "Who built the Athenian fleet?",
                        expectedClaimsAfterThisTurn: ["pw_themistocles_fleet"],
                    },
                    {
                        probes: ["Acropolis burned Persians", "Athens evacuated during invasion"],
                        naturalQuery: "Did Athens itself fall?",
                        expectedClaimsAfterThisTurn: ["pw_athens_evacuated", "pw_acropolis_burned"],
                    },
                ],
            },
            {
                label: "S3: Delian League and Athenian empire",
                turns: [
                    {
                        probes: ["Delian League formed", "Athens leads alliance after Persians"],
                        naturalQuery: "What did Athens do after the Persian Wars?",
                        expectedClaimsAfterThisTurn: ["pwar_delian_league"],
                    },
                    {
                        probes: ["Delos treasury league", "Delian League funds"],
                        naturalQuery: "Where was the Delian League treasury?",
                        expectedClaimsAfterThisTurn: [
                            "pwar_league_treasury_delos",
                            "pwar_league_treasury_athens",
                        ],
                    },
                    {
                        probes: ["Cimon campaigns Persia", "Cimon Eurymedon"],
                        naturalQuery: "Who led Athens' Delian League campaigns?",
                        expectedClaimsAfterThisTurn: [
                            "pwar_cimon_campaigns",
                            "pwar_eurymedon_victory",
                        ],
                    },
                    {
                        probes: ["Pericles building Athens", "Parthenon construction"],
                        naturalQuery: "What did Pericles build?",
                        expectedClaimsAfterThisTurn: [
                            "pol_pericles_building",
                            "pol_parthenon_built",
                        ],
                    },
                    {
                        probes: ["Pericles leader Athens", "Pericles political rise"],
                        naturalQuery: "Who was Pericles?",
                        expectedClaimsAfterThisTurn: ["pol_pericles_leader"],
                    },
                ],
            },
            {
                label: "S4: Peloponnesian War starts",
                turns: [
                    {
                        probes: ["Peloponnesian War begins", "Athens Sparta war starts"],
                        naturalQuery: "How did the Peloponnesian War start?",
                        expectedClaimsAfterThisTurn: ["pwar_war_begins", "pwar_megarian_decree"],
                    },
                    {
                        probes: ["plague Athens Peloponnesian", "disease in besieged Athens"],
                        naturalQuery: "What plague hit Athens during the war?",
                        expectedClaimsAfterThisTurn: ["pwar_plague_athens", "pwar_pericles_dies"],
                    },
                    {
                        probes: ["Pericles funeral oration", "Pericles speech for the dead"],
                        naturalQuery: "What was Pericles' famous speech?",
                        expectedClaimsAfterThisTurn: ["pwar_funeral_oration"],
                    },
                    {
                        probes: ["Spartan invasion of Attica", "Archidamus raids Athens"],
                        naturalQuery: "Did Sparta invade Attica?",
                        expectedClaimsAfterThisTurn: ["pwar_archidamus_invades"],
                    },
                ],
            },
            {
                label: "S5: Peloponnesian War turns",
                turns: [
                    {
                        probes: ["Sicilian expedition Athens", "Athens attacks Syracuse"],
                        naturalQuery: "Why did Athens invade Sicily?",
                        expectedClaimsAfterThisTurn: [
                            "pwar_sicilian_expedition",
                            "pwar_sicilian_disaster",
                        ],
                    },
                    {
                        probes: ["Alcibiades defects Sparta", "Athenian general defects"],
                        naturalQuery: "Who betrayed Athens to Sparta?",
                        expectedClaimsAfterThisTurn: [
                            "pwar_alcibiades_rises",
                            "pwar_alcibiades_defects",
                        ],
                    },
                    {
                        probes: ["Nicias killed Sicily", "Nicias Demosthenes death"],
                        naturalQuery: "Who died in the Sicilian disaster?",
                        expectedClaimsAfterThisTurn: ["pwar_nicias_demosthenes_die"],
                    },
                    {
                        probes: ["Persian gold Sparta", "Persia funds Sparta"],
                        naturalQuery: "Did Persia support Sparta?",
                        expectedClaimsAfterThisTurn: ["pwar_persian_gold"],
                    },
                ],
            },
            {
                label: "S6: Athenian defeat",
                turns: [
                    {
                        probes: ["Lysander defeats Athenian fleet", "Spartan admiral final battle"],
                        naturalQuery: "Who destroyed the Athenian fleet?",
                        expectedClaimsAfterThisTurn: ["pwar_lysander_fleet", "pwar_aegospotami"],
                    },
                    {
                        probes: ["Aegospotami battle", "final naval defeat Athens"],
                        naturalQuery: "Where did Athens lose its fleet?",
                        expectedClaimsAfterThisTurn: ["pwar_aegospotami"],
                    },
                    {
                        probes: ["Athens surrenders Sparta", "end Peloponnesian War"],
                        naturalQuery: "How did the Peloponnesian War end?",
                        expectedClaimsAfterThisTurn: [
                            "pwar_athens_surrenders",
                            "pwar_long_walls_demolished",
                        ],
                    },
                    {
                        probes: ["Thirty Tyrants rule Athens", "oligarchy in Athens after war"],
                        naturalQuery: "What happened to Athens after the war?",
                        expectedClaimsAfterThisTurn: [
                            "pol_thirty_tyrants",
                            "pol_democracy_restored",
                        ],
                    },
                    {
                        probes: ["Thucydides history war", "writer of Peloponnesian War"],
                        naturalQuery: "Who wrote the history of the war?",
                        expectedClaimsAfterThisTurn: ["pwar_thucydides_writes"],
                    },
                ],
            },
        ],
    },

    // ================================================================
    // Trace 3 — Alexander's campaigns
    // ================================================================
    {
        name: "alexander-campaigns-returning",
        description:
            "User keeps returning to understand Alexander's conquests: origins, battles, empire-building, death.",
        sessions: [
            {
                label: "S1: Alexander's origin",
                turns: [
                    {
                        probes: ["Alexander born Pella", "Alexander's childhood in Macedon"],
                        naturalQuery: "Where was Alexander born?",
                        expectedClaimsAfterThisTurn: ["alex_born_pella"],
                    },
                    {
                        probes: ["Philip king Macedon", "Alexander's father"],
                        naturalQuery: "Who was Alexander's father?",
                        expectedClaimsAfterThisTurn: ["alex_philip_king"],
                    },
                    {
                        probes: ["Aristotle tutors Alexander", "Alexander's famous teacher"],
                        naturalQuery: "Who taught Alexander?",
                        expectedClaimsAfterThisTurn: ["phil_aristotle_tutors_alexander"],
                    },
                    {
                        probes: ["Bucephalus Alexander horse", "Alexander tames horse"],
                        naturalQuery: "What was Alexander's horse?",
                        expectedClaimsAfterThisTurn: ["alex_bucephalus"],
                    },
                    {
                        probes: ["Olympias mother Alexander", "Philip's wife"],
                        naturalQuery: "Who was Alexander's mother?",
                        expectedClaimsAfterThisTurn: ["alex_olympias_marriage"],
                    },
                ],
            },
            {
                label: "S2: Philip and the rise of Macedon",
                turns: [
                    {
                        probes: ["Philip sarissa phalanx", "Macedonian infantry innovations"],
                        naturalQuery: "What military reforms did Philip make?",
                        expectedClaimsAfterThisTurn: ["alex_phalanx_sarissa"],
                    },
                    {
                        probes: ["Chaeronea battle Philip", "Macedon conquers Greece"],
                        naturalQuery: "How did Macedon become dominant in Greece?",
                        expectedClaimsAfterThisTurn: [
                            "alex_chaeronea_battle",
                            "alex_league_corinth",
                        ],
                    },
                    {
                        probes: ["Philip assassinated", "death of Philip II"],
                        naturalQuery: "How did Philip die?",
                        expectedClaimsAfterThisTurn: ["alex_philip_assassinated"],
                    },
                    {
                        probes: ["Demosthenes speeches against Philip", "anti-Macedon orator"],
                        naturalQuery: "Who opposed Philip in Athens?",
                        expectedClaimsAfterThisTurn: ["alex_demosthenes_philippics"],
                    },
                    {
                        probes: ["Alexander crowned Macedon", "Alexander takes throne"],
                        naturalQuery: "When did Alexander become king?",
                        expectedClaimsAfterThisTurn: ["alex_macedon_king"],
                    },
                ],
            },
            {
                label: "S3: Campaigns against Persia",
                turns: [
                    {
                        probes: ["Alexander crosses Hellespont", "invasion of Persia begins"],
                        naturalQuery: "When did Alexander start the Persian campaign?",
                        expectedClaimsAfterThisTurn: ["alex_crosses_hellespont"],
                    },
                    {
                        probes: ["battle of Granicus", "Alexander first battle Persia"],
                        naturalQuery: "What was Alexander's first battle in Asia?",
                        expectedClaimsAfterThisTurn: ["alex_granicus"],
                    },
                    {
                        probes: ["battle of Issus", "Alexander defeats Darius"],
                        naturalQuery: "Where did Alexander first fight Darius?",
                        expectedClaimsAfterThisTurn: ["alex_issus"],
                    },
                    {
                        probes: ["siege of Tyre", "Alexander captures Tyre"],
                        naturalQuery: "How long was the siege of Tyre?",
                        expectedClaimsAfterThisTurn: ["alex_tyre_siege"],
                    },
                    {
                        probes: ["Gaugamela final battle", "Alexander defeats Darius decisively"],
                        naturalQuery: "Where did Alexander finally defeat Darius?",
                        expectedClaimsAfterThisTurn: ["alex_gaugamela"],
                    },
                ],
            },
            {
                label: "S4: Empire consolidation",
                turns: [
                    {
                        probes: ["Alexander Egypt Alexandria", "founding of Alexandria"],
                        naturalQuery: "What city did Alexander found in Egypt?",
                        expectedClaimsAfterThisTurn: ["alex_egypt_rule", "alex_alexandria_founded"],
                    },
                    {
                        probes: ["oracle of Siwa Alexander", "Alexander son of Zeus"],
                        naturalQuery: "What did the Siwa oracle tell Alexander?",
                        expectedClaimsAfterThisTurn: ["alex_siwa_oracle"],
                    },
                    {
                        probes: ["Persepolis burned", "Alexander destroys Persian capital"],
                        naturalQuery: "Did Alexander burn Persepolis?",
                        expectedClaimsAfterThisTurn: ["alex_persepolis_burned"],
                    },
                    {
                        probes: ["Darius killed by satraps", "death of Darius III"],
                        naturalQuery: "How did Darius III die?",
                        expectedClaimsAfterThisTurn: ["alex_darius_killed"],
                    },
                    {
                        probes: ["Alexander marries Roxana", "Alexander's Bactrian wife"],
                        naturalQuery: "Who did Alexander marry?",
                        expectedClaimsAfterThisTurn: ["alex_roxana_marriage"],
                    },
                ],
            },
            {
                label: "S5: India and death",
                turns: [
                    {
                        probes: ["Alexander invades India", "Alexander crosses into India"],
                        naturalQuery: "Did Alexander reach India?",
                        expectedClaimsAfterThisTurn: ["alex_india_crosses"],
                    },
                    {
                        probes: ["battle of Hydaspes Porus", "Alexander fights Indian king"],
                        naturalQuery: "Who did Alexander fight in India?",
                        expectedClaimsAfterThisTurn: ["alex_hydaspes_porus"],
                    },
                    {
                        probes: ["troops mutiny Alexander", "Alexander's army refuses to go on"],
                        naturalQuery: "Why did Alexander turn back?",
                        expectedClaimsAfterThisTurn: ["alex_troops_mutiny"],
                    },
                    {
                        probes: ["Gedrosian desert march", "Alexander's disastrous return"],
                        naturalQuery: "What was the Gedrosian march?",
                        expectedClaimsAfterThisTurn: ["alex_gedrosian_march"],
                    },
                    {
                        probes: ["Alexander dies Babylon", "death of Alexander the Great"],
                        naturalQuery: "Where did Alexander die?",
                        expectedClaimsAfterThisTurn: ["alex_dies_babylon"],
                    },
                ],
            },
        ],
    },

    // ================================================================
    // Trace 4 — Diadochi succession
    // ================================================================
    {
        name: "diadochi-succession-returning",
        description:
            "User returns repeatedly to understand what happened to Alexander's empire — partition, wars, successor kingdoms.",
        sessions: [
            {
                label: "S1: Alexander's death aftermath",
                turns: [
                    {
                        probes: ["Alexander died Babylon", "end of Alexander"],
                        naturalQuery: "When did Alexander die?",
                        expectedClaimsAfterThisTurn: ["alex_dies_babylon"],
                    },
                    {
                        probes: ["Perdiccas regent", "who controlled Alexander's empire"],
                        naturalQuery: "Who became regent after Alexander?",
                        expectedClaimsAfterThisTurn: ["diad_perdiccas_regent"],
                    },
                    {
                        probes: ["partition of Babylon", "dividing Alexander's empire"],
                        naturalQuery: "How was the empire divided?",
                        expectedClaimsAfterThisTurn: ["diad_babylon_partition"],
                    },
                    {
                        probes: ["wars of successors begin", "Diadochi wars"],
                        naturalQuery: "When did the successor wars start?",
                        expectedClaimsAfterThisTurn: ["diad_wars_begin"],
                    },
                ],
            },
            {
                label: "S2: Ptolemy and Egypt",
                turns: [
                    {
                        probes: ["Ptolemy takes Egypt", "Alexander's general in Egypt"],
                        naturalQuery: "Who ruled Egypt after Alexander?",
                        expectedClaimsAfterThisTurn: ["diad_ptolemy_egypt"],
                    },
                    {
                        probes: ["Ptolemaic dynasty founded", "Ptolemies of Egypt"],
                        naturalQuery: "What dynasty did Ptolemy found?",
                        expectedClaimsAfterThisTurn: ["diad_ptolemaic_dynasty"],
                    },
                    {
                        probes: ["Library of Alexandria founded", "Alexandria library"],
                        naturalQuery: "When was the Library of Alexandria built?",
                        expectedClaimsAfterThisTurn: ["diad_library_alexandria"],
                    },
                    {
                        probes: ["Museum Alexandria scholars", "Alexandria center of learning"],
                        naturalQuery: "What was the Museum of Alexandria?",
                        expectedClaimsAfterThisTurn: ["diad_museum_alexandria"],
                    },
                    {
                        probes: ["city Alexandria founded Egypt", "Alexander's city"],
                        naturalQuery: "Who founded Alexandria?",
                        expectedClaimsAfterThisTurn: ["alex_alexandria_founded"],
                    },
                ],
            },
            {
                label: "S3: Antigonus and Asia",
                turns: [
                    {
                        probes: ["Antigonus Asia successor", "Antigonus one-eyed"],
                        naturalQuery: "Who took control of Asia?",
                        expectedClaimsAfterThisTurn: ["diad_antigonus_asia"],
                    },
                    {
                        probes: ["Seleucus Babylon successor", "Seleucus takes Babylon"],
                        naturalQuery: "Who controlled Babylon after Alexander?",
                        expectedClaimsAfterThisTurn: ["diad_seleucus_babylon"],
                    },
                    {
                        probes: ["Seleucid empire founded", "Seleucid dynasty"],
                        naturalQuery: "What was the Seleucid empire?",
                        expectedClaimsAfterThisTurn: ["diad_seleucid_empire"],
                    },
                    {
                        probes: ["battle of Ipsus", "final battle of successors"],
                        naturalQuery: "What decided the successor wars?",
                        expectedClaimsAfterThisTurn: ["diad_ipsus_battle"],
                    },
                ],
            },
            {
                label: "S4: Cassander and Macedon",
                turns: [
                    {
                        probes: ["Cassander takes Macedon", "who ruled Macedon after Alexander"],
                        naturalQuery: "Who controlled Macedon?",
                        expectedClaimsAfterThisTurn: ["diad_cassander_macedon"],
                    },
                    {
                        probes: ["Lysimachus Thrace", "Lysimachus successor"],
                        naturalQuery: "Who ruled Thrace?",
                        expectedClaimsAfterThisTurn: ["diad_lysimachus_thrace"],
                    },
                    {
                        probes: ["Pyrrhus Epirus king", "Pyrrhus of Epirus"],
                        naturalQuery: "Who was Pyrrhus?",
                        expectedClaimsAfterThisTurn: ["diad_pyrrhus_epirus"],
                    },
                    {
                        probes: ["pyrrhic victory Rome", "costly victory Pyrrhus"],
                        naturalQuery: "What is a pyrrhic victory?",
                        expectedClaimsAfterThisTurn: ["diad_pyrrhic_victory"],
                    },
                    {
                        probes: ["Roxana wife Alexander", "Bactrian princess Alexander"],
                        naturalQuery: "What happened to Roxana?",
                        expectedClaimsAfterThisTurn: ["alex_roxana_marriage"],
                    },
                ],
            },
            {
                label: "S5: Legacy of the empire",
                turns: [
                    {
                        probes: ["Alexander's empire fate", "what became of Alexander's empire"],
                        naturalQuery: "What was the long-term fate of Alexander's empire?",
                        expectedClaimsAfterThisTurn: [
                            "diad_babylon_partition",
                            "diad_ipsus_battle",
                        ],
                    },
                    {
                        probes: ["Hellenistic kingdoms founded", "successor kingdoms"],
                        naturalQuery: "What kingdoms emerged from the wars?",
                        expectedClaimsAfterThisTurn: [
                            "diad_ptolemaic_dynasty",
                            "diad_seleucid_empire",
                        ],
                    },
                    {
                        probes: ["Library Alexandria learning", "center of Hellenistic culture"],
                        naturalQuery: "Where was the cultural center of the Hellenistic world?",
                        expectedClaimsAfterThisTurn: [
                            "diad_library_alexandria",
                            "diad_museum_alexandria",
                        ],
                    },
                    {
                        probes: ["Alexander son heir", "what happened after Alexander's death"],
                        naturalQuery: "Did Alexander have an heir?",
                        expectedClaimsAfterThisTurn: [
                            "alex_roxana_marriage",
                            "diad_perdiccas_regent",
                        ],
                    },
                ],
            },
        ],
    },

    // ================================================================
    // Trace 5 — Pan-Hellenic religion / oracles
    // ================================================================
    {
        name: "religion-oracles-returning",
        description:
            "User focuses on Greek religion and oracles across sessions — games, sanctuaries, Delphi.",
        sessions: [
            {
                label: "S1: The pan-Hellenic games",
                turns: [
                    {
                        probes: ["Olympic Games held", "first Olympics"],
                        naturalQuery: "When did the Olympics start?",
                        expectedClaimsAfterThisTurn: ["pan_olympics_first"],
                    },
                    {
                        probes: ["Pythian Games Delphi", "games every four years"],
                        naturalQuery: "What were the Pythian Games?",
                        expectedClaimsAfterThisTurn: ["pan_pythian_games"],
                    },
                    {
                        probes: ["Nemean Games Zeus", "athletic games Nemea"],
                        naturalQuery: "What were the Nemean Games?",
                        expectedClaimsAfterThisTurn: ["pan_nemean_games"],
                    },
                    {
                        probes: ["Isthmian Games Poseidon", "games near Corinth"],
                        naturalQuery: "What were the Isthmian Games?",
                        expectedClaimsAfterThisTurn: ["pan_isthmian_games"],
                    },
                    {
                        probes: ["sacred truce Olympics", "truce during games"],
                        naturalQuery: "Did the Greeks stop fighting during the games?",
                        expectedClaimsAfterThisTurn: ["pan_sacred_truce"],
                    },
                    {
                        probes: ["olive crown prize Olympics", "victor's crown"],
                        naturalQuery: "What did Olympic winners receive?",
                        expectedClaimsAfterThisTurn: ["pan_olive_crown"],
                    },
                ],
            },
            {
                label: "S2: Delphi and Apollo",
                turns: [
                    {
                        probes: ["Delphi sanctuary Apollo", "Apollo's temple Delphi"],
                        naturalQuery: "What was Delphi?",
                        expectedClaimsAfterThisTurn: ["pan_delphi_apollo"],
                    },
                    {
                        probes: ["Pythia priestess oracle", "Pythia speaks for Apollo"],
                        naturalQuery: "Who was the Pythia?",
                        expectedClaimsAfterThisTurn: ["pan_pythia_oracle"],
                    },
                    {
                        probes: ["know thyself maxim Delphi", "Delphic maxim"],
                        naturalQuery: "What was the famous Delphic maxim?",
                        expectedClaimsAfterThisTurn: ["pan_know_thyself"],
                    },
                    {
                        probes: ["Socratic method know thyself", "Socrates and self-knowledge"],
                        naturalQuery: "How did Socrates relate to Delphi?",
                        expectedClaimsAfterThisTurn: ["phil_socratic_method", "pan_know_thyself"],
                    },
                    {
                        probes: ["Pythian Games Apollo", "Apollo honored at Pythian Games"],
                        naturalQuery: "Which god was honored at the Pythian Games?",
                        expectedClaimsAfterThisTurn: ["pan_pythian_games", "pan_delphi_apollo"],
                    },
                    {
                        probes: ["Dodona oracle Zeus", "other major oracle"],
                        naturalQuery: "Were there other oracles besides Delphi?",
                        expectedClaimsAfterThisTurn: ["pan_dodona"],
                    },
                ],
            },
            {
                label: "S3: Mysteries and festivals",
                turns: [
                    {
                        probes: ["Eleusinian Mysteries Demeter", "secret rites Eleusis"],
                        naturalQuery: "What were the Eleusinian Mysteries?",
                        expectedClaimsAfterThisTurn: ["pan_eleusinian"],
                    },
                    {
                        probes: ["Panathenaia festival Athena", "festival of Athena"],
                        naturalQuery: "What was the Panathenaia?",
                        expectedClaimsAfterThisTurn: ["pan_panathenaia"],
                    },
                    {
                        probes: ["Zeus Olympia statue", "statue of Zeus at Olympia"],
                        naturalQuery: "What was the statue of Zeus at Olympia?",
                        expectedClaimsAfterThisTurn: ["pan_zeus_olympia", "art_phidias_zeus"],
                    },
                    {
                        probes: ["Phidias sculptor Olympia", "Phidias Zeus statue"],
                        naturalQuery: "Who sculpted the Zeus statue?",
                        expectedClaimsAfterThisTurn: ["art_phidias_zeus"],
                    },
                    {
                        probes: ["Delos sacred island", "Delos Apollo birthplace"],
                        naturalQuery: "Why was Delos sacred?",
                        expectedClaimsAfterThisTurn: ["pan_delos_sanctuary"],
                    },
                    {
                        probes: ["pan-Hellenic identity", "what united the Greeks"],
                        naturalQuery: "What made people feel Greek?",
                        expectedClaimsAfterThisTurn: ["pan_hellenic_identity"],
                    },
                ],
            },
            {
                label: "S4: Oracles in history",
                turns: [
                    {
                        probes: ["Pythia delivered oracles", "consulting Delphi"],
                        naturalQuery: "How did people consult the Delphic oracle?",
                        expectedClaimsAfterThisTurn: ["pan_pythia_oracle", "pan_delphi_apollo"],
                    },
                    {
                        probes: ["oracle Siwa Alexander", "Alexander visits oracle"],
                        naturalQuery: "Which oracle did Alexander consult?",
                        expectedClaimsAfterThisTurn: ["alex_siwa_oracle"],
                    },
                    {
                        probes: ["religious center Greece", "main Greek sanctuary"],
                        naturalQuery: "What was the main religious center of Greece?",
                        expectedClaimsAfterThisTurn: ["pan_delphi_apollo", "pan_zeus_olympia"],
                    },
                    {
                        probes: ["Olympic Games every four years", "Olympiad measure"],
                        naturalQuery: "How often were the Olympics held?",
                        expectedClaimsAfterThisTurn: ["pan_olympics_first"],
                    },
                    {
                        probes: ["Eleusis mystery initiation", "Demeter and Persephone rites"],
                        naturalQuery: "What happened at Eleusis?",
                        expectedClaimsAfterThisTurn: ["pan_eleusinian"],
                    },
                ],
            },
        ],
    },

    // ================================================================
    // Trace 6 — Greek theatre and historiography
    // ================================================================
    {
        name: "theatre-historians-returning",
        description:
            "User explores tragic/comic playwrights and the Greek historians over many sessions.",
        sessions: [
            {
                label: "S1: Aeschylus and the birth of tragedy",
                turns: [
                    {
                        probes: ["Aeschylus Persians play", "tragedy about Salamis"],
                        naturalQuery: "What did Aeschylus write about Salamis?",
                        expectedClaimsAfterThisTurn: [
                            "art_aeschylus_persians",
                            "art_aeschylus_salamis",
                        ],
                    },
                    {
                        probes: ["Oresteia trilogy Aeschylus", "Agamemnon Aeschylus"],
                        naturalQuery: "What is the Oresteia?",
                        expectedClaimsAfterThisTurn: ["art_aeschylus_oresteia"],
                    },
                    {
                        probes: ["Aeschylus death Gela", "how Aeschylus died"],
                        naturalQuery: "How did Aeschylus die?",
                        expectedClaimsAfterThisTurn: ["art_aeschylus_dies"],
                    },
                    {
                        probes: ["Aeschylus fought at Salamis", "playwright in Persian Wars"],
                        naturalQuery: "Did Aeschylus fight in the Persian Wars?",
                        expectedClaimsAfterThisTurn: [
                            "art_aeschylus_salamis",
                            "pw_salamis_victory",
                        ],
                    },
                    {
                        probes: ["Sophocles first victory tragedy", "Sophocles early career"],
                        naturalQuery: "When did Sophocles first win?",
                        expectedClaimsAfterThisTurn: ["art_sophocles_first_win"],
                    },
                ],
            },
            {
                label: "S2: Sophocles and Euripides",
                turns: [
                    {
                        probes: ["Sophocles Antigone", "Antigone play"],
                        naturalQuery: "What is Antigone about?",
                        expectedClaimsAfterThisTurn: ["art_sophocles_antigone"],
                    },
                    {
                        probes: ["Oedipus Rex Sophocles", "Oedipus the king"],
                        naturalQuery: "What is Oedipus Rex?",
                        expectedClaimsAfterThisTurn: ["art_sophocles_oedipus"],
                    },
                    {
                        probes: ["Euripides Medea", "play about Medea"],
                        naturalQuery: "What is Medea?",
                        expectedClaimsAfterThisTurn: ["art_euripides_medea"],
                    },
                    {
                        probes: ["Euripides Bacchae", "play about Dionysus"],
                        naturalQuery: "What is the Bacchae?",
                        expectedClaimsAfterThisTurn: ["art_euripides_bacchae"],
                    },
                    {
                        probes: ["Euripides Macedon court", "Euripides moves to Macedon"],
                        naturalQuery: "Why did Euripides go to Macedon?",
                        expectedClaimsAfterThisTurn: ["art_euripides_macedon"],
                    },
                    {
                        probes: ["Sophocles death old age", "Sophocles dies"],
                        naturalQuery: "When did Sophocles die?",
                        expectedClaimsAfterThisTurn: ["art_sophocles_dies"],
                    },
                ],
            },
            {
                label: "S3: Comedy and Aristophanes",
                turns: [
                    {
                        probes: ["Aristophanes Clouds play", "comedy mocks Socrates"],
                        naturalQuery: "Did a comedy mock Socrates?",
                        expectedClaimsAfterThisTurn: [
                            "art_aristophanes_clouds",
                            "phil_clouds_mocks_socrates",
                        ],
                    },
                    {
                        probes: ["Lysistrata Aristophanes", "women and peace comedy"],
                        naturalQuery: "What is Lysistrata about?",
                        expectedClaimsAfterThisTurn: ["art_aristophanes_lysistrata"],
                    },
                    {
                        probes: ["Frogs Aristophanes", "comedy in the underworld"],
                        naturalQuery: "What is the Frogs about?",
                        expectedClaimsAfterThisTurn: ["art_aristophanes_frogs"],
                    },
                    {
                        probes: ["Menander new comedy", "Hellenistic comic playwright"],
                        naturalQuery: "Who was Menander?",
                        expectedClaimsAfterThisTurn: ["art_menander_comedy"],
                    },
                    {
                        probes: ["Socrates mocked in Clouds", "Socrates in comedy"],
                        naturalQuery: "How did comedy treat Socrates?",
                        expectedClaimsAfterThisTurn: ["phil_clouds_mocks_socrates"],
                    },
                ],
            },
            {
                label: "S4: Herodotus and the first historians",
                turns: [
                    {
                        probes: ["Herodotus father of history", "Herodotus historian"],
                        naturalQuery: "Who is called the father of history?",
                        expectedClaimsAfterThisTurn: ["art_herodotus_father_history"],
                    },
                    {
                        probes: ["Herodotus Histories work", "Herodotus book"],
                        naturalQuery: "What did Herodotus write?",
                        expectedClaimsAfterThisTurn: ["art_herodotus_histories"],
                    },
                    {
                        probes: [
                            "Herodotus travels Egypt Persia",
                            "Herodotus travels for research",
                        ],
                        naturalQuery: "Where did Herodotus travel?",
                        expectedClaimsAfterThisTurn: ["art_herodotus_travels"],
                    },
                    {
                        probes: ["Herodotus Persian Wars record", "Herodotus on Persian Wars"],
                        naturalQuery: "Did Herodotus cover the Persian Wars?",
                        expectedClaimsAfterThisTurn: [
                            "pw_herodotus_chronicle",
                            "art_herodotus_histories",
                        ],
                    },
                ],
            },
            {
                label: "S5: Thucydides and Xenophon",
                turns: [
                    {
                        probes: ["Thucydides Peloponnesian War book", "Thucydides history"],
                        naturalQuery: "What did Thucydides write?",
                        expectedClaimsAfterThisTurn: ["pwar_thucydides_writes"],
                    },
                    {
                        probes: ["Thucydides general exiled", "Thucydides military career"],
                        naturalQuery: "Was Thucydides a general?",
                        expectedClaimsAfterThisTurn: [
                            "art_thucydides_general",
                            "art_thucydides_exiled",
                        ],
                    },
                    {
                        probes: ["Thucydides method scientific history", "Thucydides approach"],
                        naturalQuery: "How did Thucydides approach history?",
                        expectedClaimsAfterThisTurn: ["art_thucydides_method"],
                    },
                    {
                        probes: ["Xenophon Anabasis march", "ten thousand march"],
                        naturalQuery: "What is the Anabasis?",
                        expectedClaimsAfterThisTurn: [
                            "art_xenophon_anabasis",
                            "art_xenophon_mercenaries",
                        ],
                    },
                    {
                        probes: ["Xenophon pupil Socrates", "Xenophon philosopher"],
                        naturalQuery: "Was Xenophon connected to Socrates?",
                        expectedClaimsAfterThisTurn: ["phil_xenophon_pupil"],
                    },
                ],
            },
        ],
    },

    // ================================================================
    // Trace 7 — Athenian politics: Pericles to Peloponnesian loss
    // ================================================================
    {
        name: "athens-politics-returning",
        description:
            "User digs into Athens' internal politics across sessions — reformers, Pericles, democracy, collapse after the war.",
        sessions: [
            {
                label: "S1: Early reformers",
                turns: [
                    {
                        probes: ["Solon archon Athens", "Solon's reforms"],
                        naturalQuery: "Who was Solon?",
                        expectedClaimsAfterThisTurn: ["pol_solon_archon", "pol_solon_seisachtheia"],
                    },
                    {
                        probes: ["Solon debt cancellation", "seisachtheia shaking off burdens"],
                        naturalQuery: "What is the seisachtheia?",
                        expectedClaimsAfterThisTurn: ["pol_solon_seisachtheia"],
                    },
                    {
                        probes: ["Solon council of 400", "Solon's councils"],
                        naturalQuery: "What councils did Solon create?",
                        expectedClaimsAfterThisTurn: ["pol_solon_council_400", "pol_solon_heliaia"],
                    },
                    {
                        probes: ["Draco laws written", "harsh laws Draco"],
                        naturalQuery: "Who wrote Athens' first written laws?",
                        expectedClaimsAfterThisTurn: ["pol_draco_laws"],
                    },
                    {
                        probes: ["Peisistratus tyrant Athens", "tyrant of Athens"],
                        naturalQuery: "Who was the tyrant of Athens?",
                        expectedClaimsAfterThisTurn: [
                            "pol_peisistratus_tyrant",
                            "pol_peisistratus_works",
                        ],
                    },
                ],
            },
            {
                label: "S2: Cleisthenes and democracy",
                turns: [
                    {
                        probes: ["Cleisthenes reforms Athens", "founder of democracy Athens"],
                        naturalQuery: "Who founded Athenian democracy?",
                        expectedClaimsAfterThisTurn: [
                            "pol_cleisthenes_reforms",
                            "pol_cleisthenes_democracy",
                        ],
                    },
                    {
                        probes: ["council of 500 Cleisthenes", "Athens Boule"],
                        naturalQuery: "What was the council of 500?",
                        expectedClaimsAfterThisTurn: ["pol_cleisthenes_council_500"],
                    },
                    {
                        probes: ["ostracism Cleisthenes", "exile by ostracism"],
                        naturalQuery: "What was ostracism?",
                        expectedClaimsAfterThisTurn: ["pol_cleisthenes_ostracism"],
                    },
                    {
                        probes: ["Athens demes tribes", "Cleisthenes tribal organization"],
                        naturalQuery: "How did Cleisthenes reorganize Athens?",
                        expectedClaimsAfterThisTurn: ["pol_demes"],
                    },
                    {
                        probes: ["Hippias tyrant expelled", "last tyrant Athens"],
                        naturalQuery: "How did tyranny end in Athens?",
                        expectedClaimsAfterThisTurn: ["pol_hippias_rule", "pol_hippias_expelled"],
                    },
                ],
            },
            {
                label: "S3: Pericles era",
                turns: [
                    {
                        probes: ["Pericles leader Athens", "Pericles rise to power"],
                        naturalQuery: "Who was Pericles?",
                        expectedClaimsAfterThisTurn: ["pol_pericles_leader"],
                    },
                    {
                        probes: ["Pericles jury pay democracy", "Pericles pay for public service"],
                        naturalQuery: "What did Pericles do for democracy?",
                        expectedClaimsAfterThisTurn: [
                            "pol_pericles_jury_pay",
                            "pol_pericles_citizenship",
                        ],
                    },
                    {
                        probes: ["Pericles building program", "Parthenon and Pericles"],
                        naturalQuery: "Did Pericles build the Parthenon?",
                        expectedClaimsAfterThisTurn: [
                            "pol_pericles_building",
                            "pol_parthenon_built",
                        ],
                    },
                    {
                        probes: ["strategos general Athens", "Athenian generals"],
                        naturalQuery: "What was a strategos?",
                        expectedClaimsAfterThisTurn: ["pol_strategos_office"],
                    },
                    {
                        probes: ["Ephialtes reforms Athens", "further democratic reforms"],
                        naturalQuery: "Who was Ephialtes?",
                        expectedClaimsAfterThisTurn: [
                            "pol_ephialtes_reforms",
                            "pol_ephialtes_killed",
                        ],
                    },
                ],
            },
            {
                label: "S4: Peloponnesian collapse",
                turns: [
                    {
                        probes: ["Pericles dies plague", "Pericles death during war"],
                        naturalQuery: "How did Pericles die?",
                        expectedClaimsAfterThisTurn: ["pwar_pericles_dies", "pwar_plague_athens"],
                    },
                    {
                        probes: ["Thirty Tyrants rule Athens", "oligarchy imposed on Athens"],
                        naturalQuery: "What were the Thirty Tyrants?",
                        expectedClaimsAfterThisTurn: ["pol_thirty_tyrants"],
                    },
                    {
                        probes: ["Athens democracy restored", "restoration of democracy"],
                        naturalQuery: "When was Athens' democracy restored?",
                        expectedClaimsAfterThisTurn: ["pol_democracy_restored"],
                    },
                    {
                        probes: ["Athens loses Peloponnesian War", "Athens surrender to Sparta"],
                        naturalQuery: "How did Athens' war with Sparta end?",
                        expectedClaimsAfterThisTurn: [
                            "pwar_athens_surrenders",
                            "pwar_long_walls_demolished",
                        ],
                    },
                    {
                        probes: ["Athens Assembly ekklesia", "democratic assembly Athens"],
                        naturalQuery: "What was the ekklesia?",
                        expectedClaimsAfterThisTurn: ["pol_assembly_ekklesia"],
                    },
                ],
            },
            {
                label: "S5: Legacy of Athenian democracy",
                turns: [
                    {
                        probes: ["Athenian democracy institutions", "how Athens governed itself"],
                        naturalQuery: "How did Athenian democracy work?",
                        expectedClaimsAfterThisTurn: [
                            "pol_assembly_ekklesia",
                            "pol_strategos_office",
                        ],
                    },
                    {
                        probes: ["jury courts heliaia", "Athenian courts"],
                        naturalQuery: "How did Athens try cases?",
                        expectedClaimsAfterThisTurn: ["pol_solon_heliaia"],
                    },
                    {
                        probes: ["Pericles citizenship law", "who counted as Athenian"],
                        naturalQuery: "Who was an Athenian citizen?",
                        expectedClaimsAfterThisTurn: ["pol_pericles_citizenship"],
                    },
                    {
                        probes: ["Pericles funeral oration democracy", "speech praising Athens"],
                        naturalQuery: "What did Pericles say about Athens?",
                        expectedClaimsAfterThisTurn: ["pwar_funeral_oration"],
                    },
                    {
                        probes: ["Hipparchus assassination", "killing of tyrant's brother"],
                        naturalQuery: "Was a tyrant ever killed in Athens?",
                        expectedClaimsAfterThisTurn: ["pol_hipparchus_killed"],
                    },
                ],
            },
        ],
    },

    // ================================================================
    // Trace 8 — Philosophers: Academy → Lyceum → Hellenistic schools
    // ================================================================
    {
        name: "schools-philosophy-returning",
        description:
            "User traces the philosophical schools lineage across sessions — pre-Socratics, Academy, Lyceum, Hellenistic schools.",
        sessions: [
            {
                label: "S1: Pre-Socratic foundations",
                turns: [
                    {
                        probes: ["Thales water first philosopher", "Thales Miletus"],
                        naturalQuery: "Who was the first Greek philosopher?",
                        expectedClaimsAfterThisTurn: ["phil_thales_water", "phil_thales_eclipse"],
                    },
                    {
                        probes: ["Anaximander apeiron", "Anaximander boundless"],
                        naturalQuery: "Who was Anaximander?",
                        expectedClaimsAfterThisTurn: ["phil_anaximander_apeiron"],
                    },
                    {
                        probes: ["Heraclitus flux change", "everything flows"],
                        naturalQuery: "What did Heraclitus teach?",
                        expectedClaimsAfterThisTurn: ["phil_heraclitus_flux"],
                    },
                    {
                        probes: ["Parmenides being existence", "Parmenides on being"],
                        naturalQuery: "What did Parmenides argue?",
                        expectedClaimsAfterThisTurn: ["phil_parmenides_being"],
                    },
                    {
                        probes: ["Pythagoras Croton mathematics", "Pythagorean theorem"],
                        naturalQuery: "Who was Pythagoras?",
                        expectedClaimsAfterThisTurn: [
                            "phil_pythagoras_croton",
                            "phil_pythagorean_theorem",
                        ],
                    },
                    {
                        probes: ["Democritus atoms", "atomist philosophy"],
                        naturalQuery: "Who proposed atoms?",
                        expectedClaimsAfterThisTurn: [
                            "phil_leucippus_atoms",
                            "phil_democritus_atoms",
                        ],
                    },
                ],
            },
            {
                label: "S2: Socrates and Plato's Academy",
                turns: [
                    {
                        probes: ["Socrates philosophy Athens", "Socrates in Athens"],
                        naturalQuery: "Who was Socrates?",
                        expectedClaimsAfterThisTurn: ["phil_socrates_born", "phil_socratic_method"],
                    },
                    {
                        probes: ["Socrates executed hemlock", "death of Socrates"],
                        naturalQuery: "How did Socrates die?",
                        expectedClaimsAfterThisTurn: [
                            "phil_socrates_tried",
                            "phil_socrates_executed",
                        ],
                    },
                    {
                        probes: ["Plato Academy founded", "Plato's school"],
                        naturalQuery: "What was Plato's Academy?",
                        expectedClaimsAfterThisTurn: ["phil_plato_academy"],
                    },
                    {
                        probes: ["theory of forms Plato", "Platonic forms"],
                        naturalQuery: "What is Plato's theory of forms?",
                        expectedClaimsAfterThisTurn: ["phil_plato_forms"],
                    },
                    {
                        probes: ["Speusippus Academy head", "Plato's successor"],
                        naturalQuery: "Who succeeded Plato at the Academy?",
                        expectedClaimsAfterThisTurn: ["phil_speusippus_academy"],
                    },
                    {
                        probes: ["Plato's Republic", "Plato ideal city"],
                        naturalQuery: "What is the Republic?",
                        expectedClaimsAfterThisTurn: ["phil_plato_republic"],
                    },
                ],
            },
            {
                label: "S3: Aristotle and the Lyceum",
                turns: [
                    {
                        probes: ["Aristotle studied Academy", "Aristotle student of Plato"],
                        naturalQuery: "Did Aristotle study at the Academy?",
                        expectedClaimsAfterThisTurn: ["phil_aristotle_academy_joins"],
                    },
                    {
                        probes: ["Aristotle tutors Alexander", "Aristotle teacher of Alexander"],
                        naturalQuery: "Did Aristotle teach Alexander?",
                        expectedClaimsAfterThisTurn: ["phil_aristotle_tutors_alexander"],
                    },
                    {
                        probes: ["Aristotle Lyceum founded", "Aristotle's own school"],
                        naturalQuery: "What was the Lyceum?",
                        expectedClaimsAfterThisTurn: ["phil_aristotle_lyceum"],
                    },
                    {
                        probes: ["Aristotle Nicomachean Ethics", "Aristotle ethics book"],
                        naturalQuery: "What did Aristotle write on ethics?",
                        expectedClaimsAfterThisTurn: ["phil_aristotle_nicomachean"],
                    },
                    {
                        probes: ["Aristotle Politics work", "Aristotle on polis"],
                        naturalQuery: "What did Aristotle write on politics?",
                        expectedClaimsAfterThisTurn: ["phil_aristotle_politics"],
                    },
                    {
                        probes: ["Theophrastus Lyceum head", "Aristotle's successor"],
                        naturalQuery: "Who succeeded Aristotle?",
                        expectedClaimsAfterThisTurn: ["phil_theophrastus_lyceum"],
                    },
                ],
            },
            {
                label: "S4: Hellenistic schools",
                turns: [
                    {
                        probes: ["Epicurus garden Athens", "Epicurean philosophy"],
                        naturalQuery: "What was Epicurus' school?",
                        expectedClaimsAfterThisTurn: ["phil_epicurus_garden"],
                    },
                    {
                        probes: ["Zeno Stoa Stoic school", "Stoicism founded"],
                        naturalQuery: "Who founded Stoicism?",
                        expectedClaimsAfterThisTurn: ["phil_zeno_stoa"],
                    },
                    {
                        probes: ["Diogenes cynic Alexander", "Diogenes in a barrel"],
                        naturalQuery: "Who was Diogenes the Cynic?",
                        expectedClaimsAfterThisTurn: [
                            "phil_diogenes_cynic",
                            "phil_diogenes_alexander",
                        ],
                    },
                    {
                        probes: ["Diogenes meets Alexander", "Alexander and Diogenes"],
                        naturalQuery: "Did Alexander meet Diogenes?",
                        expectedClaimsAfterThisTurn: ["phil_diogenes_alexander"],
                    },
                    {
                        probes: ["sophist Protagoras man measure", "sophists Athens"],
                        naturalQuery: "Who were the sophists?",
                        expectedClaimsAfterThisTurn: [
                            "phil_protagoras_man_measure",
                            "phil_gorgias_rhetoric",
                        ],
                    },
                ],
            },
            {
                label: "S5: The philosophical lineage",
                turns: [
                    {
                        probes: [
                            "Socrates Plato Aristotle lineage",
                            "chain of Athenian philosophers",
                        ],
                        naturalQuery: "Was there a teaching lineage Socrates-Plato-Aristotle?",
                        expectedClaimsAfterThisTurn: [
                            "phil_plato_socrates_pupil",
                            "phil_aristotle_academy_joins",
                        ],
                    },
                    {
                        probes: ["Academy Lyceum schools", "philosophical schools Athens"],
                        naturalQuery: "What were the main philosophical schools?",
                        expectedClaimsAfterThisTurn: [
                            "phil_plato_academy",
                            "phil_aristotle_lyceum",
                        ],
                    },
                    {
                        probes: [
                            "pre-Socratics Plato influence",
                            "how earlier thinkers shaped Plato",
                        ],
                        naturalQuery: "How did pre-Socratics influence Plato?",
                        expectedClaimsAfterThisTurn: [
                            "phil_heraclitus_flux",
                            "phil_parmenides_being",
                        ],
                    },
                    {
                        probes: ["Aristotle dies Chalcis", "Aristotle's last years"],
                        naturalQuery: "When did Aristotle die?",
                        expectedClaimsAfterThisTurn: [
                            "phil_aristotle_flees",
                            "phil_aristotle_dies",
                        ],
                    },
                    {
                        probes: ["Plato influence Western philosophy", "Plato's enduring legacy"],
                        naturalQuery: "Why does Plato still matter?",
                        expectedClaimsAfterThisTurn: ["phil_plato_academy", "phil_plato_forms"],
                    },
                    {
                        probes: ["philosophers sanctuaries Delphi", "philosophers and Delphi"],
                        naturalQuery: "Did philosophers engage with Delphi?",
                        expectedClaimsAfterThisTurn: ["pan_know_thyself", "pan_delphi_apollo"],
                    },
                ],
            },
        ],
    },
];
