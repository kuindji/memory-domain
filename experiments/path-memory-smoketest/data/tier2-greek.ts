import type { ClaimSpec } from "./tier1-alex.js";

// Tier 2 — Greek history (~800 BCE through the Diadochi).
//
// Timestamp convention: years since 800 BCE (positive integers). So the
// first Olympics at 776 BCE = 24, Marathon (490 BCE) = 310, Alexander's
// death (323 BCE) = 477, Ipsus (301 BCE) = 499. Keeps `computeNow()` +
// recency arithmetic in the retriever working without changes.
//
// IDs are prefixed by cluster for readability:
//   pan_   pan-Hellenic / religious
//   pol_   Athenian politics
//   pw_    Persian Wars
//   pwar_  Delian League + Peloponnesian War
//   phil_  philosophers (pre-Socratics through Hellenistic)
//   alex_  Philip II + Alexander
//   diad_  the Diadochi and their successors
//   art_   drama, historiography, sculpture, architecture

export const tier2Greek: ClaimSpec[] = [
    // === Pan-Hellenic / religious ===================================
    {
        id: "pan_olympics_first",
        text: "The first Olympic Games were held at Olympia",
        validFrom: 24,
    },
    {
        id: "pan_pythian_games",
        text: "The Pythian Games were held every four years at Delphi",
        validFrom: 216,
    },
    { id: "pan_nemean_games", text: "The Nemean Games honored Zeus at Nemea", validFrom: 227 },
    {
        id: "pan_isthmian_games",
        text: "The Isthmian Games honored Poseidon near Corinth",
        validFrom: 218,
    },
    {
        id: "pan_sacred_truce",
        text: "A sacred truce halted wars during the Olympic Games",
        validFrom: 24,
    },
    {
        id: "pan_pythia_oracle",
        text: "The Pythia served as the priestess who delivered oracles at Delphi",
        validFrom: 100,
    },
    {
        id: "pan_delphi_apollo",
        text: "Delphi was the principal sanctuary of the god Apollo",
        validFrom: 80,
    },
    {
        id: "pan_know_thyself",
        text: "The maxim know thyself was inscribed at the temple of Apollo at Delphi",
        validFrom: 120,
    },
    {
        id: "pan_eleusinian",
        text: "The Eleusinian Mysteries initiated worshippers of Demeter and Persephone at Eleusis",
        validFrom: 150,
    },
    {
        id: "pan_panathenaia",
        text: "The Panathenaic Festival celebrated Athena as patron of Athens",
        validFrom: 240,
    },
    {
        id: "pan_zeus_olympia",
        text: "The statue of Zeus at Olympia was one of the Seven Wonders",
        validFrom: 360,
    },
    {
        id: "pan_olive_crown",
        text: "Olympic victors received a crown of wild olive leaves as their prize",
        validFrom: 24,
    },
    {
        id: "pan_hellenic_identity",
        text: "Pan-Hellenic festivals reinforced a shared Greek identity across rival city states",
        validFrom: 100,
    },
    {
        id: "pan_dodona",
        text: "The oracle at Dodona was sacred to Zeus and one of the oldest in Greece",
        validFrom: 50,
    },
    {
        id: "pan_delos_sanctuary",
        text: "The island of Delos was the sacred birthplace of Apollo and Artemis",
        validFrom: 60,
    },

    // === Athenian politics & democracy ==============================
    {
        id: "pol_draco_laws",
        text: "Draco codified the first written Athenian law code with harsh penalties",
        validFrom: 179,
    },
    {
        id: "pol_solon_archon",
        text: "Solon was elected archon of Athens to reform the city",
        validFrom: 206,
    },
    {
        id: "pol_solon_seisachtheia",
        text: "Solon cancelled debts and freed Athenians enslaved for debt through the seisachtheia",
        validFrom: 206,
    },
    {
        id: "pol_solon_classes",
        text: "Solon sorted Athenian citizens into four property classes",
        validFrom: 206,
    },
    {
        id: "pol_solon_council_400",
        text: "Solon established the Council of Four Hundred in Athens",
        validFrom: 206,
    },
    {
        id: "pol_solon_heliaia",
        text: "Solon created the Heliaia popular court open to all citizens",
        validFrom: 206,
    },
    {
        id: "pol_peisistratus_tyrant",
        text: "Peisistratus seized power in Athens and ruled as tyrant",
        validFrom: 239,
    },
    {
        id: "pol_peisistratus_works",
        text: "Peisistratus funded temples roads and the Panathenaic festival to win popular support",
        validFrom: 239,
    },
    {
        id: "pol_hippias_rule",
        text: "Hippias succeeded his father Peisistratus as tyrant of Athens",
        validFrom: 273,
        supersedes: "pol_peisistratus_tyrant",
    },
    {
        id: "pol_hipparchus_killed",
        text: "Harmodius and Aristogiton assassinated Hipparchus at the Panathenaic festival",
        validFrom: 286,
    },
    {
        id: "pol_hippias_expelled",
        text: "The Alcmaeonid family and Spartan intervention expelled the tyrant Hippias from Athens",
        validFrom: 290,
        supersedes: "pol_hippias_rule",
    },
    {
        id: "pol_cleisthenes_reforms",
        text: "Cleisthenes reorganized Athenian citizens into ten tribes based on local demes",
        validFrom: 292,
    },
    {
        id: "pol_cleisthenes_council_500",
        text: "Cleisthenes replaced the Council of Four Hundred with a Council of Five Hundred",
        validFrom: 292,
    },
    {
        id: "pol_cleisthenes_ostracism",
        text: "Cleisthenes introduced ostracism allowing the assembly to banish a citizen for ten years",
        validFrom: 292,
    },
    {
        id: "pol_cleisthenes_democracy",
        text: "Cleisthenes is credited with founding Athenian democracy after the expulsion of the tyrants",
        validFrom: 292,
    },
    {
        id: "pol_ephialtes_reforms",
        text: "Ephialtes stripped the Areopagus of its political powers",
        validFrom: 338,
    },
    {
        id: "pol_ephialtes_killed",
        text: "Ephialtes was assassinated shortly after his reforms",
        validFrom: 339,
    },
    {
        id: "pol_pericles_leader",
        text: "Pericles became the leading statesman of Athens after Ephialtes",
        validFrom: 339,
    },
    {
        id: "pol_pericles_jury_pay",
        text: "Pericles introduced pay for citizens who served on Athenian juries",
        validFrom: 346,
    },
    {
        id: "pol_pericles_citizenship",
        text: "Pericles restricted Athenian citizenship to those with two Athenian parents",
        validFrom: 349,
    },
    {
        id: "pol_pericles_building",
        text: "Pericles directed a major building program on the Acropolis using Delian League funds",
        validFrom: 353,
    },
    {
        id: "pol_parthenon_built",
        text: "The Parthenon temple was constructed on the Athenian Acropolis under Pericles",
        validFrom: 353,
    },
    {
        id: "pol_thirty_tyrants",
        text: "The Thirty Tyrants were installed as an oligarchic regime in Athens after the Peloponnesian War",
        validFrom: 396,
    },
    {
        id: "pol_democracy_restored",
        text: "Thrasybulus led exiles back to Athens and restored the democracy",
        validFrom: 397,
        supersedes: "pol_thirty_tyrants",
    },
    {
        id: "pol_assembly_ekklesia",
        text: "The Athenian assembly the ekklesia met on the Pnyx hill to vote on all major decisions",
        validFrom: 300,
    },
    {
        id: "pol_demes",
        text: "Each Athenian citizen belonged to a local deme which determined tribal affiliation",
        validFrom: 292,
    },
    {
        id: "pol_strategos_office",
        text: "The ten strategoi were elected generals who held real executive power in Athens",
        validFrom: 292,
    },

    // === Persian Wars ===============================================
    {
        id: "pw_ionian_revolt_start",
        text: "The Ionian Greek cities revolted against Persian rule under Aristagoras of Miletus",
        validFrom: 301,
    },
    {
        id: "pw_sardis_burned",
        text: "Ionian and Athenian troops burned the Persian regional capital at Sardis",
        validFrom: 302,
    },
    {
        id: "pw_lade_defeat",
        text: "The Ionian fleet was destroyed at the Battle of Lade ending the revolt",
        validFrom: 306,
    },
    {
        id: "pw_miletus_sacked",
        text: "The Persians sacked Miletus and deported its population after Lade",
        validFrom: 306,
    },
    {
        id: "pw_darius_heralds",
        text: "King Darius sent heralds demanding earth and water from Greek cities",
        validFrom: 307,
    },
    {
        id: "pw_mardonius_fleet_lost",
        text: "A Persian expedition under Mardonius lost its fleet to a storm off Mount Athos",
        validFrom: 308,
    },
    {
        id: "pw_datis_artaphernes",
        text: "Darius sent a second force under Datis and Artaphernes to punish Athens",
        validFrom: 310,
    },
    {
        id: "pw_eretria_sacked",
        text: "The Persians sacked the Greek city of Eretria before landing at Marathon",
        validFrom: 310,
    },
    {
        id: "pw_persians_at_marathon",
        text: "A Persian army landed on the plain of Marathon north of Athens",
        validFrom: 310,
    },
    {
        id: "pw_pheidippides_run",
        text: "The runner Pheidippides was sent from Athens to Sparta to request help against the Persians",
        validFrom: 310,
    },
    {
        id: "pw_miltiades_commands",
        text: "Miltiades commanded the Athenian hoplites at the Battle of Marathon",
        validFrom: 310,
    },
    {
        id: "pw_marathon_victory",
        text: "The Athenians defeated the Persians at the Battle of Marathon",
        validFrom: 310,
    },
    {
        id: "pw_miltiades_paros",
        text: "Miltiades led a failed expedition against Paros and was fined",
        validFrom: 311,
    },
    {
        id: "pw_themistocles_fleet",
        text: "Themistocles persuaded Athens to build a large fleet using silver from the Laurium mines",
        validFrom: 316,
    },
    {
        id: "pw_xerxes_king",
        text: "Xerxes succeeded his father Darius as king of the Persian Empire",
        validFrom: 314,
    },
    {
        id: "pw_xerxes_invasion",
        text: "Xerxes launched a massive invasion of Greece by land and sea",
        validFrom: 320,
    },
    {
        id: "pw_hellespont_bridge",
        text: "Xerxes built a pontoon bridge across the Hellespont to move his army into Europe",
        validFrom: 320,
    },
    {
        id: "pw_hellenic_league",
        text: "Greek city states formed the Hellenic League led by Sparta to resist the Persian invasion",
        validFrom: 320,
    },
    {
        id: "pw_leonidas_thermopylae",
        text: "King Leonidas of Sparta held the pass at Thermopylae with three hundred Spartans and allies",
        validFrom: 320,
    },
    {
        id: "pw_ephialtes_betrayal",
        text: "A local named Ephialtes showed the Persians a path around Thermopylae",
        validFrom: 320,
    },
    {
        id: "pw_leonidas_killed",
        text: "Leonidas and his rear guard were killed at Thermopylae after being outflanked",
        validFrom: 320,
    },
    {
        id: "pw_artemisium_sea",
        text: "The Greek fleet fought the Persians to a draw at the naval battle of Artemisium",
        validFrom: 320,
    },
    {
        id: "pw_athens_evacuated",
        text: "The Athenians evacuated their city to Salamis and Troezen before the Persian advance",
        validFrom: 320,
    },
    {
        id: "pw_acropolis_burned",
        text: "The Persians occupied Athens and burned the temples on the Acropolis",
        validFrom: 320,
    },
    {
        id: "pw_salamis_victory",
        text: "Themistocles led the Greek fleet to a decisive victory over the Persians at Salamis",
        validFrom: 320,
    },
    {
        id: "pw_xerxes_withdraws",
        text: "Xerxes withdrew to Asia after Salamis leaving Mardonius to continue the war",
        validFrom: 320,
    },
    {
        id: "pw_pausanias_commands",
        text: "Pausanias the Spartan regent commanded the allied Greek land army",
        validFrom: 321,
    },
    {
        id: "pw_plataea_victory",
        text: "The Greeks under Pausanias destroyed Mardonius and the Persian army at Plataea",
        validFrom: 321,
    },
    {
        id: "pw_mardonius_killed",
        text: "Mardonius was killed in the Greek victory at Plataea",
        validFrom: 321,
    },
    {
        id: "pw_mycale_naval",
        text: "The Greeks destroyed the remaining Persian fleet at Mycale on the Ionian coast",
        validFrom: 321,
    },
    {
        id: "pw_herodotus_chronicle",
        text: "Herodotus wrote the principal surviving account of the Persian Wars",
        validFrom: 370,
    },

    // === Delian League + Peloponnesian War ==========================
    {
        id: "pwar_delian_league",
        text: "Athens organized the Delian League as an alliance against Persia",
        validFrom: 322,
    },
    {
        id: "pwar_aristides_assesses",
        text: "Aristides the Just set the tribute each Delian League member owed",
        validFrom: 322,
    },
    {
        id: "pwar_league_treasury_delos",
        text: "The treasury of the Delian League was originally kept on the sacred island of Delos",
        validFrom: 322,
    },
    {
        id: "pwar_cimon_campaigns",
        text: "Cimon led the league in aggressive campaigns against remaining Persian garrisons",
        validFrom: 330,
    },
    {
        id: "pwar_eurymedon_victory",
        text: "Cimon defeated a Persian army and fleet at the Battle of the Eurymedon",
        validFrom: 334,
    },
    {
        id: "pwar_naxos_revolt",
        text: "Naxos tried to leave the Delian League and was forced back by Athens",
        validFrom: 329,
    },
    {
        id: "pwar_league_treasury_athens",
        text: "The Delian League treasury was transferred from Delos to Athens",
        validFrom: 346,
        supersedes: "pwar_league_treasury_delos",
    },
    {
        id: "pwar_first_peloponnesian",
        text: "A first Peloponnesian War between Athens and Sparta ended inconclusively",
        validFrom: 352,
    },
    {
        id: "pwar_thirty_years_peace",
        text: "Athens and Sparta signed the Thirty Years Peace recognizing two spheres of influence",
        validFrom: 354,
    },
    {
        id: "pwar_megarian_decree",
        text: "The Megarian Decree barred Megara from Athenian markets and harbors",
        validFrom: 367,
    },
    {
        id: "pwar_war_begins",
        text: "The Peloponnesian War between Athens and Sparta began when Sparta invaded Attica",
        validFrom: 369,
    },
    {
        id: "pwar_archidamus_invades",
        text: "King Archidamus of Sparta led the annual invasions of Attica in the early war",
        validFrom: 369,
    },
    {
        id: "pwar_funeral_oration",
        text: "Pericles delivered the funeral oration praising Athenian democracy in the first year of the war",
        validFrom: 369,
    },
    {
        id: "pwar_plague_athens",
        text: "A devastating plague struck Athens during the Spartan siege of Attica",
        validFrom: 370,
    },
    {
        id: "pwar_pericles_dies",
        text: "Pericles died of the plague during the Peloponnesian War",
        validFrom: 371,
        supersedes: "pol_pericles_leader",
    },
    {
        id: "pwar_cleon_leader",
        text: "Cleon rose as a demagogue leader of Athens after the death of Pericles",
        validFrom: 371,
    },
    {
        id: "pwar_mytilene_debate",
        text: "The Athenian assembly debated whether to execute the rebellious citizens of Mytilene",
        validFrom: 372,
    },
    {
        id: "pwar_demosthenes_pylos",
        text: "The Athenian general Demosthenes fortified Pylos on the Spartan coast",
        validFrom: 375,
    },
    {
        id: "pwar_sphacteria_surrender",
        text: "A force of Spartan hoplites surrendered to Athens on the island of Sphacteria",
        validFrom: 375,
    },
    {
        id: "pwar_brasidas_thrace",
        text: "The Spartan general Brasidas campaigned successfully in Thrace",
        validFrom: 377,
    },
    {
        id: "pwar_amphipolis_battle",
        text: "Brasidas and Cleon were both killed at the Battle of Amphipolis",
        validFrom: 378,
    },
    {
        id: "pwar_peace_nicias",
        text: "Athens and Sparta signed the Peace of Nicias halting the first phase of the war",
        validFrom: 379,
    },
    {
        id: "pwar_alcibiades_rises",
        text: "The young aristocrat Alcibiades emerged as a leading Athenian politician",
        validFrom: 381,
    },
    {
        id: "pwar_melian_dialogue",
        text: "Athens massacred the men of Melos after the island refused to join the Delian League",
        validFrom: 384,
    },
    {
        id: "pwar_sicilian_expedition",
        text: "Athens launched a massive expedition to conquer Sicily",
        validFrom: 385,
    },
    {
        id: "pwar_nicias_commander",
        text: "Nicias reluctantly commanded the Sicilian expedition after opposing it in assembly",
        validFrom: 385,
    },
    {
        id: "pwar_hermes_mutilation",
        text: "Athenian herms were mutilated on the eve of the Sicilian expedition and Alcibiades was blamed",
        validFrom: 385,
    },
    {
        id: "pwar_alcibiades_defects",
        text: "Alcibiades fled to Sparta and advised the Spartans against Athens",
        validFrom: 385,
    },
    {
        id: "pwar_sicilian_disaster",
        text: "The Athenian army and fleet in Sicily were completely destroyed at Syracuse",
        validFrom: 387,
        supersedes: "pwar_sicilian_expedition",
    },
    {
        id: "pwar_nicias_demosthenes_die",
        text: "Nicias and Demosthenes were executed after the Athenian defeat in Sicily",
        validFrom: 387,
    },
    {
        id: "pwar_decelea_occupied",
        text: "Sparta fortified Decelea in Attica on the advice of Alcibiades",
        validFrom: 386,
    },
    {
        id: "pwar_persian_gold",
        text: "Persia began funding the Spartan fleet to bring down Athens",
        validFrom: 388,
    },
    {
        id: "pwar_oligarchic_coup",
        text: "An oligarchic coup installed the Four Hundred briefly in Athens during the war",
        validFrom: 389,
    },
    {
        id: "pwar_alcibiades_returns",
        text: "Alcibiades returned from exile to command the Athenian fleet",
        validFrom: 390,
    },
    {
        id: "pwar_arginusae_trial",
        text: "Athens executed six generals after the naval victory at Arginusae for failing to rescue survivors",
        validFrom: 394,
    },
    {
        id: "pwar_lysander_fleet",
        text: "The Spartan admiral Lysander built a dominant fleet with Persian money",
        validFrom: 393,
    },
    {
        id: "pwar_aegospotami",
        text: "Lysander destroyed the Athenian fleet at Aegospotami in the Hellespont",
        validFrom: 395,
    },
    {
        id: "pwar_athens_surrenders",
        text: "Athens surrendered to Sparta ending the Peloponnesian War",
        validFrom: 396,
    },
    {
        id: "pwar_long_walls_demolished",
        text: "The Long Walls connecting Athens to its port at Piraeus were torn down after the surrender",
        validFrom: 396,
    },
    {
        id: "pwar_thucydides_writes",
        text: "Thucydides wrote the definitive contemporary history of the Peloponnesian War",
        validFrom: 395,
    },

    // === Philosophers ===============================================
    {
        id: "phil_thales_water",
        text: "Thales of Miletus taught that water was the fundamental substance of all things",
        validFrom: 200,
    },
    {
        id: "phil_thales_eclipse",
        text: "Thales reportedly predicted a solar eclipse that halted a battle between Lydia and Media",
        validFrom: 215,
    },
    {
        id: "phil_anaximander_apeiron",
        text: "Anaximander proposed that the primary substance was the boundless apeiron",
        validFrom: 220,
    },
    {
        id: "phil_anaximenes_air",
        text: "Anaximenes taught that air was the fundamental element of the cosmos",
        validFrom: 245,
    },
    {
        id: "phil_pythagoras_croton",
        text: "Pythagoras founded a philosophical and religious community at Croton in southern Italy",
        validFrom: 270,
    },
    {
        id: "phil_pythagorean_theorem",
        text: "The Pythagoreans studied the mathematical relationship between the sides of a right triangle",
        validFrom: 270,
    },
    {
        id: "phil_pythagorean_transmigration",
        text: "The Pythagoreans taught the transmigration of souls between bodies",
        validFrom: 270,
    },
    {
        id: "phil_heraclitus_flux",
        text: "Heraclitus of Ephesus taught that everything is in flux and you cannot step into the same river twice",
        validFrom: 275,
    },
    {
        id: "phil_parmenides_being",
        text: "Parmenides of Elea argued that being is eternal and change is illusion",
        validFrom: 305,
    },
    {
        id: "phil_zeno_paradoxes",
        text: "Zeno of Elea defended his teacher Parmenides with paradoxes about motion",
        validFrom: 320,
    },
    {
        id: "phil_anaxagoras_nous",
        text: "Anaxagoras introduced the concept of nous as a cosmic ordering mind",
        validFrom: 330,
    },
    {
        id: "phil_anaxagoras_athens",
        text: "Anaxagoras lived and taught in Athens and was a friend of Pericles",
        validFrom: 340,
    },
    {
        id: "phil_empedocles_elements",
        text: "Empedocles proposed four elements earth air fire and water combined by love and strife",
        validFrom: 335,
    },
    {
        id: "phil_leucippus_atoms",
        text: "Leucippus founded the atomist school teaching that matter is made of indivisible atoms",
        validFrom: 340,
    },
    {
        id: "phil_democritus_atoms",
        text: "Democritus developed atomism with his teacher Leucippus into a complete physical theory",
        validFrom: 360,
    },
    {
        id: "phil_protagoras_man_measure",
        text: "The sophist Protagoras taught that man is the measure of all things",
        validFrom: 345,
    },
    {
        id: "phil_gorgias_rhetoric",
        text: "The sophist Gorgias revolutionized rhetoric and denied that truth can be known",
        validFrom: 345,
    },
    {
        id: "phil_socrates_born",
        text: "Socrates was born in Athens the son of a stonecutter and a midwife",
        validFrom: 330,
    },
    {
        id: "phil_socrates_potidaea",
        text: "Socrates served as a hoplite at the siege of Potidaea",
        validFrom: 368,
    },
    {
        id: "phil_socrates_saves_alcibiades",
        text: "Socrates saved the life of the young Alcibiades at Potidaea",
        validFrom: 368,
    },
    {
        id: "phil_socrates_delium",
        text: "Socrates fought at the Battle of Delium during the Peloponnesian War",
        validFrom: 376,
    },
    {
        id: "phil_socratic_method",
        text: "Socrates practiced an elenchic method of questioning to expose unexamined assumptions",
        validFrom: 370,
    },
    {
        id: "phil_xenophon_pupil",
        text: "Xenophon was a student of Socrates and later wrote memoirs about his teacher",
        validFrom: 380,
    },
    {
        id: "phil_clouds_mocks_socrates",
        text: "Aristophanes lampooned Socrates as a sophist in the comedy Clouds",
        validFrom: 377,
    },
    {
        id: "phil_socrates_tried",
        text: "Socrates was put on trial in Athens on charges of impiety and corrupting the youth",
        validFrom: 401,
    },
    {
        id: "phil_socrates_executed",
        text: "Socrates was executed by drinking hemlock after refusing to escape",
        validFrom: 401,
    },
    {
        id: "phil_plato_born",
        text: "Plato was born into an aristocratic Athenian family",
        validFrom: 372,
    },
    {
        id: "phil_plato_socrates_pupil",
        text: "Plato became a devoted student of Socrates in Athens",
        validFrom: 390,
    },
    {
        id: "phil_plato_sicily",
        text: "Plato traveled to Sicily to advise the tyrant Dionysius the Elder",
        validFrom: 413,
    },
    {
        id: "phil_plato_academy",
        text: "Plato founded the Academy on the outskirts of Athens as a school of philosophy",
        validFrom: 415,
    },
    {
        id: "phil_plato_republic",
        text: "Plato wrote the Republic describing a just city governed by philosopher kings",
        validFrom: 425,
    },
    {
        id: "phil_plato_symposium",
        text: "Plato wrote the Symposium portraying speeches about love at a dinner party",
        validFrom: 430,
    },
    {
        id: "phil_plato_forms",
        text: "Plato taught the theory of forms holding that eternal ideas are more real than material things",
        validFrom: 425,
    },
    {
        id: "phil_plato_dies",
        text: "Plato died in Athens leaving the Academy to his nephew Speusippus",
        validFrom: 452,
    },
    {
        id: "phil_speusippus_academy",
        text: "Speusippus succeeded his uncle Plato as head of the Academy",
        validFrom: 452,
        supersedes: "phil_plato_academy",
    },
    {
        id: "phil_aristotle_born",
        text: "Aristotle was born in Stagira on the coast of Thrace",
        validFrom: 416,
    },
    {
        id: "phil_aristotle_academy_joins",
        text: "Aristotle joined Plato's Academy as a student and stayed for twenty years",
        validFrom: 433,
    },
    {
        id: "phil_aristotle_leaves_academy",
        text: "Aristotle left the Academy after Plato's death",
        validFrom: 452,
    },
    {
        id: "phil_aristotle_tutors_alexander",
        text: "Aristotle was hired by Philip the Second to tutor the young Alexander at Mieza",
        validFrom: 457,
    },
    {
        id: "phil_aristotle_lyceum",
        text: "Aristotle founded the Lyceum in Athens as a rival school to the Academy",
        validFrom: 465,
    },
    {
        id: "phil_aristotle_nicomachean",
        text: "Aristotle wrote the Nicomachean Ethics on human flourishing and virtue",
        validFrom: 470,
    },
    {
        id: "phil_aristotle_politics",
        text: "Aristotle wrote the Politics analyzing constitutions of Greek city states",
        validFrom: 470,
    },
    {
        id: "phil_aristotle_metaphysics",
        text: "Aristotle wrote the Metaphysics on being and first principles",
        validFrom: 470,
    },
    {
        id: "phil_aristotle_poetics",
        text: "Aristotle wrote the Poetics analyzing tragedy and epic poetry",
        validFrom: 470,
    },
    {
        id: "phil_aristotle_golden_mean",
        text: "Aristotle taught that virtue is a mean between extremes of excess and deficiency",
        validFrom: 470,
    },
    {
        id: "phil_aristotle_flees",
        text: "Aristotle fled Athens after Alexander's death fearing anti-Macedonian reprisals",
        validFrom: 477,
    },
    {
        id: "phil_aristotle_dies",
        text: "Aristotle died in exile on the island of Euboea",
        validFrom: 478,
    },
    {
        id: "phil_theophrastus_lyceum",
        text: "Theophrastus succeeded Aristotle as head of the Lyceum",
        validFrom: 478,
        supersedes: "phil_aristotle_lyceum",
    },
    {
        id: "phil_diogenes_cynic",
        text: "Diogenes of Sinope lived as a Cynic in Athens rejecting conventional possessions",
        validFrom: 460,
    },
    {
        id: "phil_diogenes_alexander",
        text: "Diogenes famously asked Alexander to step out of his sunlight",
        validFrom: 465,
    },
    {
        id: "phil_epicurus_garden",
        text: "Epicurus founded a philosophical community called the Garden in Athens",
        validFrom: 493,
    },
    {
        id: "phil_zeno_stoa",
        text: "Zeno of Citium taught his students in the Stoa Poikile founding Stoicism",
        validFrom: 500,
    },

    // === Macedon + Alexander ========================================
    {
        id: "alex_philip_king",
        text: "Philip the Second became king of Macedon and began transforming the kingdom",
        validFrom: 441,
    },
    {
        id: "alex_phalanx_sarissa",
        text: "Philip reformed the Macedonian army around a phalanx armed with the long sarissa pike",
        validFrom: 442,
    },
    {
        id: "alex_philip_amphipolis",
        text: "Philip captured the strategic city of Amphipolis from Athens",
        validFrom: 443,
    },
    {
        id: "alex_olympias_marriage",
        text: "Philip married Olympias a princess of Epirus",
        validFrom: 443,
    },
    {
        id: "alex_born_pella",
        text: "Alexander was born in Pella the Macedonian capital to Philip and Olympias",
        validFrom: 444,
    },
    {
        id: "alex_bucephalus",
        text: "The young Alexander tamed the warhorse Bucephalus no one else could ride",
        validFrom: 454,
    },
    {
        id: "alex_demosthenes_philippics",
        text: "The Athenian orator Demosthenes delivered the Philippics warning against Philip",
        validFrom: 449,
    },
    {
        id: "alex_chaeronea_battle",
        text: "Philip and Alexander defeated Athens and Thebes at the Battle of Chaeronea",
        validFrom: 462,
    },
    {
        id: "alex_league_corinth",
        text: "Philip organized Greek city states into the League of Corinth under Macedonian leadership",
        validFrom: 463,
    },
    {
        id: "alex_philip_persia_plan",
        text: "Philip was planning an invasion of Persia at the time of his death",
        validFrom: 464,
    },
    {
        id: "alex_philip_assassinated",
        text: "Philip was assassinated by Pausanias of Orestis during a royal wedding",
        validFrom: 464,
    },
    {
        id: "alex_macedon_king",
        text: "Alexander became king of Macedon at the age of twenty",
        validFrom: 464,
    },
    {
        id: "alex_thebes_destroyed",
        text: "Alexander destroyed the city of Thebes after it revolted from Macedonian rule",
        validFrom: 465,
    },
    {
        id: "alex_crosses_hellespont",
        text: "Alexander crossed the Hellespont and invaded the Persian Empire",
        validFrom: 466,
    },
    {
        id: "alex_granicus",
        text: "Alexander won his first major victory over Persian forces at the Granicus River",
        validFrom: 466,
    },
    {
        id: "alex_gordian_knot",
        text: "Alexander cut the Gordian knot at the temple of Zeus in Gordium",
        validFrom: 467,
    },
    {
        id: "alex_issus",
        text: "Alexander defeated King Darius the Third at the Battle of Issus in Cilicia",
        validFrom: 467,
    },
    {
        id: "alex_tyre_siege",
        text: "Alexander captured the island fortress of Tyre after a seven-month siege",
        validFrom: 468,
    },
    {
        id: "alex_egypt_rule",
        text: "Alexander entered Egypt and was welcomed as a liberator from Persian rule",
        validFrom: 468,
    },
    {
        id: "alex_alexandria_founded",
        text: "Alexander founded the city of Alexandria on the western edge of the Nile delta",
        validFrom: 469,
    },
    {
        id: "alex_siwa_oracle",
        text: "Alexander visited the oracle of Amon at Siwa and was hailed as son of the god",
        validFrom: 469,
    },
    {
        id: "alex_gaugamela",
        text: "Alexander decisively defeated Darius the Third at the Battle of Gaugamela in Mesopotamia",
        validFrom: 469,
    },
    {
        id: "alex_babylon_enters",
        text: "Alexander was welcomed into Babylon as the new great king of Asia",
        validFrom: 469,
    },
    {
        id: "alex_persepolis_burned",
        text: "Alexander burned the royal palace at Persepolis after a drunken banquet",
        validFrom: 470,
    },
    {
        id: "alex_darius_killed",
        text: "The Persian satrap Bessus murdered the fleeing Darius the Third",
        validFrom: 470,
    },
    {
        id: "alex_persian_king",
        text: "Alexander took the title of great king of the Persian Empire",
        validFrom: 470,
    },
    {
        id: "alex_philotas_executed",
        text: "Alexander executed his friend Philotas on charges of conspiracy",
        validFrom: 471,
    },
    {
        id: "alex_kills_clitus",
        text: "Alexander killed his friend Clitus the Black in a drunken quarrel in Samarkand",
        validFrom: 472,
    },
    {
        id: "alex_roxana_marriage",
        text: "Alexander married Roxana a Sogdian noblewoman captured in central Asia",
        validFrom: 473,
    },
    {
        id: "alex_india_crosses",
        text: "Alexander crossed into India over the Indus River",
        validFrom: 474,
    },
    {
        id: "alex_hydaspes_porus",
        text: "Alexander defeated the Indian king Porus at the Battle of the Hydaspes",
        validFrom: 474,
    },
    {
        id: "alex_troops_mutiny",
        text: "Alexander's troops refused to advance further east at the Hyphasis River",
        validFrom: 474,
    },
    {
        id: "alex_gedrosian_march",
        text: "Alexander led his army back through the brutal Gedrosian desert losing many soldiers",
        validFrom: 475,
    },
    {
        id: "alex_mass_marriages_susa",
        text: "Alexander held mass marriages at Susa pairing his officers with Persian noblewomen",
        validFrom: 476,
    },
    {
        id: "alex_dies_babylon",
        text: "Alexander fell ill and died in Babylon at the age of thirty-two",
        validFrom: 477,
    },

    // === The Diadochi ==============================================
    {
        id: "diad_perdiccas_regent",
        text: "Perdiccas served as regent of the empire for Alexander's successors",
        validFrom: 477,
    },
    {
        id: "diad_babylon_partition",
        text: "Alexander's generals divided the provinces of the empire at the Partition of Babylon",
        validFrom: 477,
    },
    {
        id: "diad_wars_begin",
        text: "The Wars of the Diadochi broke out among Alexander's generals over control of the empire",
        validFrom: 478,
    },
    {
        id: "diad_ptolemy_egypt",
        text: "Ptolemy son of Lagus took Egypt as his satrapy and later declared himself king",
        validFrom: 478,
        supersedes: "alex_egypt_rule",
    },
    {
        id: "diad_antigonus_asia",
        text: "Antigonus the One-Eyed made himself master of much of Asia Minor",
        validFrom: 485,
    },
    {
        id: "diad_seleucus_babylon",
        text: "Seleucus seized Babylon and founded the Seleucid Empire over former Persian lands",
        validFrom: 488,
    },
    {
        id: "diad_cassander_macedon",
        text: "Cassander took control of Macedon and Greece",
        validFrom: 489,
    },
    {
        id: "diad_ipsus_battle",
        text: "Antigonus was defeated and killed at the Battle of Ipsus in Phrygia",
        validFrom: 499,
    },
    {
        id: "diad_lysimachus_thrace",
        text: "Lysimachus ruled Thrace and parts of Asia Minor after Ipsus",
        validFrom: 499,
    },
    {
        id: "diad_ptolemaic_dynasty",
        text: "The Ptolemaic dynasty ruled Egypt from Alexandria for nearly three centuries",
        validFrom: 480,
    },
    {
        id: "diad_seleucid_empire",
        text: "The Seleucid Empire controlled a vast territory from the Aegean to the borders of India",
        validFrom: 490,
    },
    {
        id: "diad_library_alexandria",
        text: "The Ptolemies founded the Library of Alexandria to collect the knowledge of the world",
        validFrom: 505,
    },
    {
        id: "diad_museum_alexandria",
        text: "The Ptolemies established the Museum of Alexandria as a center of Hellenistic scholarship",
        validFrom: 505,
    },
    {
        id: "diad_pyrrhus_epirus",
        text: "Pyrrhus of Epirus fought costly campaigns against Rome in Italy",
        validFrom: 520,
    },
    {
        id: "diad_pyrrhic_victory",
        text: "The term Pyrrhic victory originates from the ruinous triumphs of Pyrrhus over Rome",
        validFrom: 520,
    },

    // === Arts & historiography =====================================
    {
        id: "art_aeschylus_persians",
        text: "Aeschylus wrote the tragedy Persians dramatizing the Greek victory at Salamis",
        validFrom: 328,
    },
    {
        id: "art_aeschylus_salamis",
        text: "Aeschylus himself fought as a hoplite at the Battle of Salamis",
        validFrom: 320,
    },
    {
        id: "art_aeschylus_oresteia",
        text: "Aeschylus wrote the Oresteia trilogy about the curse on the house of Atreus",
        validFrom: 342,
    },
    {
        id: "art_aeschylus_dies",
        text: "Aeschylus died in Sicily reportedly killed by a tortoise dropped from above",
        validFrom: 344,
    },
    {
        id: "art_sophocles_first_win",
        text: "Sophocles defeated Aeschylus to win his first dramatic victory at the Dionysia",
        validFrom: 332,
    },
    {
        id: "art_sophocles_antigone",
        text: "Sophocles wrote the tragedy Antigone about defiance of unjust royal decrees",
        validFrom: 358,
    },
    {
        id: "art_sophocles_oedipus",
        text: "Sophocles wrote Oedipus Rex about a king who unknowingly kills his father and marries his mother",
        validFrom: 365,
    },
    {
        id: "art_sophocles_dies",
        text: "Sophocles died in Athens in the last years of the Peloponnesian War",
        validFrom: 394,
    },
    {
        id: "art_euripides_medea",
        text: "Euripides wrote the tragedy Medea about a sorceress who kills her children for revenge",
        validFrom: 369,
    },
    {
        id: "art_euripides_bacchae",
        text: "Euripides wrote the Bacchae about the god Dionysus punishing the king of Thebes",
        validFrom: 395,
    },
    {
        id: "art_euripides_macedon",
        text: "Euripides spent his last years at the court of King Archelaus of Macedon",
        validFrom: 392,
    },
    {
        id: "art_aristophanes_clouds",
        text: "Aristophanes wrote the comedy Clouds satirizing Socrates and sophistry",
        validFrom: 377,
    },
    {
        id: "art_aristophanes_lysistrata",
        text: "Aristophanes wrote the comedy Lysistrata in which women withhold sex to stop the war",
        validFrom: 389,
    },
    {
        id: "art_aristophanes_frogs",
        text: "Aristophanes wrote the comedy Frogs in which Dionysus descends to the underworld to retrieve a tragedian",
        validFrom: 395,
    },
    {
        id: "art_herodotus_travels",
        text: "Herodotus traveled widely in Egypt Persia and the Black Sea to gather material",
        validFrom: 355,
    },
    {
        id: "art_herodotus_histories",
        text: "Herodotus composed the Histories narrating the conflict between Greeks and Persians",
        validFrom: 370,
    },
    {
        id: "art_herodotus_father_history",
        text: "Cicero later called Herodotus the Father of History for his method of inquiry",
        validFrom: 370,
    },
    {
        id: "art_thucydides_general",
        text: "Thucydides served as an Athenian general in Thrace during the Peloponnesian War",
        validFrom: 376,
    },
    {
        id: "art_thucydides_exiled",
        text: "Thucydides was exiled from Athens after failing to save Amphipolis from Brasidas",
        validFrom: 377,
    },
    {
        id: "art_thucydides_method",
        text: "Thucydides pioneered a political method of history focused on causes and motives rather than myth",
        validFrom: 395,
    },
    {
        id: "art_xenophon_anabasis",
        text: "Xenophon wrote the Anabasis recounting the march of the Ten Thousand Greek mercenaries",
        validFrom: 410,
    },
    {
        id: "art_xenophon_mercenaries",
        text: "Xenophon led ten thousand Greek mercenaries back from Persia after their employer Cyrus was killed",
        validFrom: 404,
    },
    {
        id: "art_menander_comedy",
        text: "Menander wrote New Comedy portraying the domestic lives of ordinary Athenians",
        validFrom: 480,
    },
    {
        id: "art_phidias_parthenon",
        text: "The sculptor Phidias oversaw the sculptural program of the Parthenon",
        validFrom: 355,
    },
    {
        id: "art_phidias_zeus",
        text: "Phidias created the chryselephantine statue of Zeus at Olympia",
        validFrom: 360,
    },
    {
        id: "art_praxiteles",
        text: "Praxiteles carved the Aphrodite of Knidos the first major nude female sculpture in Greek art",
        validFrom: 440,
    },
    {
        id: "art_ictinus_parthenon",
        text: "Ictinus and Callicrates designed the Parthenon temple under Phidias's artistic direction",
        validFrom: 353,
    },
];
