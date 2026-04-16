import type { ClaimId, RetrievalMode } from "../src/types.js";

export type Turn = {
    probes: string[];
    naturalQuery: string;
    expectedClaimsAfterThisTurn: ClaimId[];
};

export type ConversationTrace = {
    name: string;
    description: string;
    mode?: RetrievalMode;
    turns: Turn[];
};

export const tracesTier2: ConversationTrace[] = [
    {
        name: "philosophers to Alexander arc",
        description:
            "Progressive narrowing from Greek philosophy broadly, through Plato's Academy, to Aristotle specifically tutoring Alexander — cross-cluster by construction.",
        turns: [
            {
                probes: ["classical Greek philosophy", "the major Athenian philosophers"],
                naturalQuery: "Tell me about Greek philosophy.",
                expectedClaimsAfterThisTurn: [
                    "phil_socrates_born",
                    "phil_plato_academy",
                    "phil_aristotle_lyceum",
                ],
            },
            {
                probes: [
                    "Plato's school and its pupils",
                    "philosophers who trained at the Academy",
                ],
                naturalQuery: "Who studied at Plato's Academy?",
                expectedClaimsAfterThisTurn: [
                    "phil_plato_academy",
                    "phil_aristotle_academy_joins",
                    "phil_speusippus_academy",
                ],
            },
            {
                probes: ["Aristotle's most famous pupil", "which king did Aristotle teach"],
                naturalQuery: "Did Aristotle teach anyone famous?",
                expectedClaimsAfterThisTurn: ["phil_aristotle_tutors_alexander"],
            },
        ],
    },
    {
        name: "Athens at war arc",
        description:
            "Athens' trajectory from Persian-invasion defender, to imperial leader of the Delian League, to loser of the Peloponnesian War — tests cross-cluster temporal narrative.",
        turns: [
            {
                probes: ["Persian invasions of Greece", "Greek resistance to Persia"],
                naturalQuery: "What happened when the Persians invaded Greece?",
                expectedClaimsAfterThisTurn: [
                    "pw_marathon_victory",
                    "pw_salamis_victory",
                    "pw_plataea_victory",
                ],
            },
            {
                probes: ["the Athenian empire after the Persian Wars", "the Delian League"],
                naturalQuery: "What did Athens do after winning the Persian Wars?",
                expectedClaimsAfterThisTurn: [
                    "pwar_delian_league",
                    "pwar_league_treasury_athens",
                    "pol_pericles_building",
                ],
            },
            {
                probes: [
                    "Athens fights Sparta in the Peloponnesian War",
                    "Peloponnesian War between Athens and Sparta",
                ],
                naturalQuery: "Did Athens go to war with Sparta?",
                expectedClaimsAfterThisTurn: [
                    "pwar_war_begins",
                    "pwar_plague_athens",
                    "pwar_sicilian_disaster",
                ],
            },
            {
                probes: ["Athens defeat and surrender", "the end of the Peloponnesian War"],
                naturalQuery: "How did the Peloponnesian War end?",
                expectedClaimsAfterThisTurn: [
                    "pwar_aegospotami",
                    "pwar_athens_surrenders",
                    "pwar_long_walls_demolished",
                ],
            },
        ],
    },
    {
        // asOf 440 (= 360 BCE) — Plato is still alive and running the
        // Academy; Aristotle has joined it as a student; Socrates is
        // dead. Speusippus has not yet taken over.
        name: "Academy arc (asOf 360 BCE)",
        description:
            "State of Plato's Academy at a fixed moment in time. Supersession primitive should keep Plato's headship visible while filtering out Speusippus (who takes over later).",
        mode: { kind: "asOf", at: 440 },
        turns: [
            {
                probes: ["Plato's life and work", "the philosopher Plato"],
                naturalQuery: "Who was Plato?",
                expectedClaimsAfterThisTurn: [
                    "phil_plato_born",
                    "phil_plato_socrates_pupil",
                    "phil_plato_academy",
                ],
            },
            {
                probes: ["where did Plato teach", "Plato's philosophical school"],
                naturalQuery: "Where did Plato teach?",
                expectedClaimsAfterThisTurn: ["phil_plato_academy"],
            },
            {
                probes: ["Plato's most important writings", "Plato's dialogues and theories"],
                naturalQuery: "What did Plato write about?",
                expectedClaimsAfterThisTurn: [
                    "phil_plato_republic",
                    "phil_plato_symposium",
                    "phil_plato_forms",
                ],
            },
        ],
    },
    {
        name: "Alexander succession arc",
        description:
            "Narrowing from Alexander's conquests to the partition among his generals — supersession-heavy, spans alex_ and diad_ clusters.",
        turns: [
            {
                probes: ["Alexander the Great's conquests", "the Macedonian empire at its height"],
                naturalQuery: "How big was Alexander's empire?",
                expectedClaimsAfterThisTurn: [
                    "alex_gaugamela",
                    "alex_persian_king",
                    "alex_india_crosses",
                ],
            },
            {
                probes: [
                    "what happened after Alexander died",
                    "division of the empire among Alexander's generals",
                ],
                naturalQuery: "What happened to the empire after Alexander died?",
                expectedClaimsAfterThisTurn: [
                    "alex_dies_babylon",
                    "diad_babylon_partition",
                    "diad_wars_begin",
                ],
            },
            {
                probes: [
                    "generals who kept parts of the empire",
                    "which Diadochi founded lasting kingdoms",
                ],
                naturalQuery: "Which of Alexander's generals founded lasting kingdoms?",
                expectedClaimsAfterThisTurn: [
                    "diad_ptolemy_egypt",
                    "diad_seleucus_babylon",
                    "diad_cassander_macedon",
                ],
            },
        ],
    },
];
