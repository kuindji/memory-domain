// tests-integration/kb-architecture/phases/0-collect.ts
import type { Dataset, DatasetEntry, VerificationQuestion } from "../types.js";
import { writeDataset } from "../checkpoint.js";

/**
 * Fetches a Wikipedia article summary via the REST API.
 * Returns the extract text.
 */
async function fetchWikipediaExtract(title: string): Promise<string> {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const response = await fetch(url);
    if (!response.ok) {
        console.warn(`[collect] Failed to fetch "${title}": ${response.status}`);
        return "";
    }
    const data = (await response.json()) as { extract?: string };
    return data.extract ?? "";
}

/**
 * Splits a long extract into sentence-level chunks, merging short sentences
 * to keep chunks in the ~50-200 word range for KB ingestion.
 */
function chunkExtract(text: string, minWords: number = 30, maxWords: number = 150): string[] {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const chunks: string[] = [];
    let current = "";

    for (const sentence of sentences) {
        const combined = current ? `${current} ${sentence}` : sentence;
        const wordCount = combined.split(/\s+/).length;

        if (wordCount >= maxWords && current) {
            chunks.push(current.trim());
            current = sentence;
        } else {
            current = combined;
        }
    }

    if (current.trim()) {
        const wordCount = current.trim().split(/\s+/).length;
        if (wordCount >= minWords) {
            chunks.push(current.trim());
        } else if (chunks.length > 0) {
            chunks[chunks.length - 1] += " " + current.trim();
        } else {
            chunks.push(current.trim());
        }
    }

    return chunks;
}

// Wikipedia articles to fetch — chosen for obscure detail density
const WIKIPEDIA_SOURCES: { title: string; expectedClassifications: string[] }[] = [
    { title: "Justinian_I", expectedClassifications: ["fact", "reference"] },
    { title: "Nika_riots", expectedClassifications: ["fact", "concept"] },
    { title: "Battle_of_Manzikert", expectedClassifications: ["fact"] },
    { title: "Corpus_Juris_Civilis", expectedClassifications: ["reference", "definition"] },
    { title: "Byzantine_Iconoclasm", expectedClassifications: ["concept", "fact"] },
    { title: "Basil_II", expectedClassifications: ["fact"] },
    { title: "Fall_of_Constantinople", expectedClassifications: ["fact"] },
    { title: "Theme_(Byzantine_district)", expectedClassifications: ["definition", "concept"] },
    { title: "Byzantine_economy", expectedClassifications: ["fact", "concept"] },
    { title: "Hagia_Sophia", expectedClassifications: ["fact", "reference"] },
    { title: "Belisarius", expectedClassifications: ["fact"] },
    { title: "Varangian_Guard", expectedClassifications: ["fact"] },
    { title: "Fourth_Crusade", expectedClassifications: ["fact"] },
    { title: "Greek_fire", expectedClassifications: ["definition", "concept"] },
    { title: "Filioque", expectedClassifications: ["concept", "definition"] },

    // People & Politics
    { title: "Theodora_(wife_of_Justinian_I)", expectedClassifications: ["concept", "fact"] },

    // Culture & Art
    { title: "Byzantine_art", expectedClassifications: ["concept", "reference"] },
    { title: "Byzantine_music", expectedClassifications: ["reference"] },

    // Military & Defense
    { title: "Byzantine_navy", expectedClassifications: ["fact", "reference"] },
    { title: "Walls_of_Constantinople", expectedClassifications: ["reference", "fact"] },
    {
        title: "Siege_of_Constantinople_(717\u2013718)",
        expectedClassifications: ["fact"],
    },

    // Science & Education
    { title: "Byzantine_medicine", expectedClassifications: ["reference", "fact"] },

    // Periods & Events
    { title: "Macedonian_dynasty", expectedClassifications: ["concept", "fact"] },
    { title: "Latin_Empire", expectedClassifications: ["fact"] },

    // Geography & Infrastructure
    { title: "Constantinople", expectedClassifications: ["definition", "fact"] },

    // Foreign Relations
    { title: "Byzantine\u2013Sasanian_wars", expectedClassifications: ["fact"] },

    // Religion & Society
    {
        title: "Ecumenical_Patriarch_of_Constantinople",
        expectedClassifications: ["definition", "reference"],
    },
    { title: "Byzantine_dress", expectedClassifications: ["reference"] },
    { title: "East\u2013West_Schism", expectedClassifications: ["concept", "fact"] },
    { title: "Procopius", expectedClassifications: ["fact", "reference"] },
    { title: "Hippodrome_of_Constantinople", expectedClassifications: ["reference", "fact"] },

    // Additional diverse topics
    { title: "Byzantine_Senate", expectedClassifications: ["definition", "reference"] },
    { title: "Komnenian_restoration", expectedClassifications: ["concept", "fact"] },
    { title: "Palaiologos", expectedClassifications: ["fact"] },
    { title: "Byzantine_coinage", expectedClassifications: ["reference", "fact"] },
    { title: "Heraclius", expectedClassifications: ["fact"] },
];

/**
 * Manually crafted entries for supersession testing and hard-to-find facts.
 * These supplement the Wikipedia extracts with deliberate structure.
 */
function getManualEntries(): DatasetEntry[] {
    return [
        // Supersession pair: incorrect then corrected
        {
            id: "supersession-manzikert-wrong",
            content:
                "The Battle of Manzikert in 1071 was fought between the Byzantine Empire and the Seljuk Turks. Emperor Romanos IV Diogenes led approximately 40,000 troops and was decisively defeated, losing half his army.",
            expectedClassification: "fact",
            supersessionGroup: "manzikert-casualties",
        },
        {
            id: "supersession-manzikert-correct",
            content:
                "The Battle of Manzikert (1071) between Emperor Romanos IV Diogenes and Sultan Alp Arslan resulted in a Byzantine defeat, but modern scholarship estimates Byzantine forces at 20,000-30,000, not the 40,000 often cited. The defeat was due more to desertions by Andronikos Doukas than battlefield losses.",
            expectedClassification: "fact",
            supersessionGroup: "manzikert-casualties",
        },

        // Supersession pair: outdated then updated
        {
            id: "supersession-hagia-wrong",
            content:
                "Hagia Sophia served as a mosque from 1453 until 1934, when it was converted into a museum by the Republic of Turkey under Ataturk's secularization reforms.",
            expectedClassification: "fact",
            supersessionGroup: "hagia-sophia-status",
        },
        {
            id: "supersession-hagia-correct",
            content:
                "Hagia Sophia served as a mosque from 1453 to 1934, then as a museum until July 2020, when it was reconverted into a mosque by a Turkish presidential decree. It remains an active mosque while also being open to tourists outside prayer times.",
            expectedClassification: "fact",
            supersessionGroup: "hagia-sophia-status",
        },

        // Related knowledge cluster: Byzantine silk industry
        {
            id: "related-silk-monopoly",
            content:
                "The Byzantine Empire held a strict monopoly on silk production in Europe from the 6th century onward. Emperor Justinian I allegedly sent two Nestorian monks to smuggle silkworm eggs from China hidden inside hollow bamboo canes around 552 CE, breaking China's ancient monopoly.",
            expectedClassification: "fact",
            relatedGroup: "silk-industry",
        },
        {
            id: "related-silk-guilds",
            content:
                "Byzantine silk production was managed by imperial guilds regulated under the Book of the Eparch (10th century). The guilds controlled every stage: raw silk purchase (metaxopratai), dyeing (katartarioi), and weaving (serikarioi). Purple silk was reserved exclusively for the imperial family.",
            expectedClassification: "reference",
            relatedGroup: "silk-industry",
        },
        {
            id: "related-silk-diplomacy",
            content:
                "Silk served as a key instrument of Byzantine diplomacy. Imperial silk garments were given as gifts to foreign rulers and ambassadors, functioning as both luxury items and symbols of Byzantine cultural superiority. The Liudprand of Cremona embassy accounts (968 CE) describe strict export controls on purple-dyed silk.",
            expectedClassification: "insight",
            relatedGroup: "silk-industry",
        },

        // Hard facts Haiku would likely hallucinate
        {
            id: "hard-bezant",
            content:
                "The Byzantine gold solidus (bezant) maintained nearly constant weight and purity (4.48g, 24 karats) for over 700 years from Constantine I (309 CE) until Emperor Constantine IX began debasement in 1034 CE. The nomisma histamenon eventually fell to 8 karats under Nikephoros III Botaneiates (1078-1081).",
            expectedClassification: "fact",
        },
        {
            id: "hard-varangian-guard",
            content:
                "The Varangian Guard was established around 988 CE when Prince Vladimir I of Kyiv sent 6,000 warriors to Emperor Basil II as part of a military alliance sealed by Vladimir's marriage to Basil's sister Anna. After the Norman Conquest of 1066, many Anglo-Saxon nobles joined the Guard, eventually becoming its dominant contingent.",
            expectedClassification: "fact",
        },
        {
            id: "hard-themes",
            content:
                "The Theme system replaced the late Roman provincial structure beginning under Emperor Heraclius (610-641) or possibly Constans II (641-668). The original four themes were Anatolikon, Armeniakon, Opsikion, and the naval Karabisianoi. Each theme was governed by a strategos who held both military and civil authority, fundamentally different from the Roman separation of powers.",
            expectedClassification: "definition",
        },
        {
            id: "hard-iconoclasm-dates",
            content:
                "Byzantine Iconoclasm had two distinct phases: the First Iconoclasm (726-787 CE) initiated by Emperor Leo III the Isaurian and ended by the Second Council of Nicaea under Empress Irene; the Second Iconoclasm (814-842 CE) began under Emperor Leo V the Armenian and ended definitively on the first Sunday of Lent 843 CE, now celebrated as the Feast of Orthodoxy.",
            expectedClassification: "fact",
        },
        {
            id: "hard-greek-fire",
            content:
                "Greek fire was invented around 672 CE, traditionally attributed to Kallinikos, a refugee from Heliopolis (modern Baalbek, Lebanon). The exact composition remains unknown, but likely included naphtha, quicklime, sulfur, and possibly saltpeter. It was deployed through bronze siphons mounted on ship prows and could burn on water. Its use was decisive in repelling the Arab sieges of Constantinople in 674-678 and 717-718 CE.",
            expectedClassification: "reference",
        },
        {
            id: "hard-fourth-crusade",
            content:
                "The Fourth Crusade's sack of Constantinople in April 1204 was preceded by a complex chain of events: the crusaders diverted to Constantinople to support Alexios IV Angelos' claim to the throne, installed him as co-emperor, then attacked when he couldn't pay the promised 200,000 marks of silver. The resulting Latin Empire lasted only until 1261 when Michael VIII Palaiologos recaptured the city from Baldwin II.",
            expectedClassification: "fact",
        },
        {
            id: "hard-filioque",
            content:
                "The Filioque controversy centered on whether the Holy Spirit proceeds from the Father alone (Eastern position) or from the Father 'and the Son' (Filioque, Western position). The original Niceno-Constantinopolitan Creed of 381 CE stated 'proceeds from the Father.' The Filioque was first added at the Third Council of Toledo in 589 CE. It became a key factor in the Great Schism of 1054 when Cardinal Humbert excommunicated Patriarch Michael Cerularius.",
            expectedClassification: "concept",
        },
        // How-to and insight entries
        {
            id: "howto-identify-coins",
            content:
                "To identify a Byzantine coin's era: examine the cross on the obverse — a simple cross suggests pre-7th century, a cross on steps indicates 7th-8th century, and Christ's portrait appears from the late 7th century onward. The reverse typically shows the emperor's title and regnal year in Greek numerals. Coins with facing portraits (rather than profile) generally date after Justinian II's second reign (705-711 CE).",
            expectedClassification: "how-to",
        },
        {
            id: "insight-bureaucracy",
            content:
                "The Byzantine Empire's longevity (over 1,100 years) owed much to its sophisticated bureaucratic system rather than military might alone. The civil service was merit-based with examinations, officials rotated to prevent local power bases, and the tax system (based on the Roman capitatio-iugatio) adapted remarkably to territorial losses. When the empire lost Anatolia after 1071, it was the collapse of the tax base — not the military defeat itself — that proved fatal.",
            expectedClassification: "insight",
        },

        // New diverse sub-topic entries
        {
            id: "theodora-political-influence",
            content:
                "Empress Theodora (c. 500–548 CE) wielded extraordinary political influence as co-ruler with Justinian I. A former actress from humble origins, she became one of the most powerful women in Byzantine history. During the Nika riots of 532, when Justinian considered fleeing Constantinople, Theodora's famous speech convinced him to stay and fight. She championed women's rights, closing forced prostitution houses and expanding divorce and property rights for women.",
            expectedClassification: "concept",
        },
        {
            id: "theodosian-walls",
            content:
                "The Theodosian Walls were built between 408-413 CE under Emperor Theodosius II. The triple-wall system stretched 6.5 kilometers across the peninsula, featuring an inner wall 5 meters thick and 12 meters high, an outer wall, and a 20-meter-wide moat. These walls successfully defended Constantinople for over a thousand years until the Ottoman siege of 1453 when Sultan Mehmed II breached them using massive cannons, particularly the great bombard built by the Hungarian engineer Orban.",
            expectedClassification: "reference",
        },
        {
            id: "byzantine-hospitals",
            content:
                "The Pantokrator monastery hospital complex in Constantinople, founded in 1136 by Emperor John II Komnenos, was one of the most advanced medical facilities in the medieval world. It had 50 beds divided into five specialized wards: surgical, ophthalmological, gynecological, and two for general ailments. The hospital employed a staff hierarchy including chief physicians, surgeons, female doctors for women's wards, pharmacists, and orderlies, establishing a model for institutional healthcare.",
            expectedClassification: "fact",
        },
        {
            id: "byzantine-sasanian-treaty",
            content:
                "The Eternal Peace of 532 CE between Emperor Justinian I and Khosrau I of Sassanid Persia ended decades of Roman-Persian conflict. Justinian agreed to pay 11,000 pounds of gold to secure his eastern frontier, freeing him to pursue reconquest of the western Mediterranean. The peace lasted only eight years before Khosrau broke it in 540 CE by sacking Antioch, one of the empire's wealthiest cities.",
            expectedClassification: "fact",
        },
        {
            id: "byzantine-717-siege",
            content:
                "The Arab siege of Constantinople in 717-718 CE was one of the most decisive battles in world history. The massive Arab fleet of over 1,800 ships and 120,000 troops besieged the city by land and sea. The Byzantines under Emperor Leo III used Greek fire to devastating effect against the Arab fleet, while a harsh winter and Bulgarian attacks on the Arab land forces led to catastrophic losses. The failed siege halted Arab expansion into Europe for centuries.",
            expectedClassification: "fact",
        },
        {
            id: "byzantine-education-system",
            content:
                "The University of Constantinople, refounded by Emperor Constantine IX Monomachos in 1045 CE, was organized into faculties of philosophy and law. The philosophy faculty was headed by Michael Psellos, one of the greatest Byzantine intellectuals. Unlike Western universities which were church-controlled, Byzantine higher education remained under imperial patronage and emphasized classical Greek literature, rhetoric, and Aristotelian philosophy alongside Christian theology.",
            expectedClassification: "concept",
        },
        {
            id: "byzantine-hippodrome-factions",
            content:
                "The Hippodrome of Constantinople was far more than a chariot racing venue — it was the center of Byzantine political life. The four racing factions (Blues, Greens, Reds, and Whites) evolved into powerful political parties. The Blues generally represented the aristocratic and orthodox faction, while the Greens drew support from merchants and monophysites. The emperor's appearance in the imperial box (kathisma) was a key ritual of imperial legitimacy, and crowd reactions served as a form of public opinion polling.",
            expectedClassification: "concept",
        },
        {
            id: "byzantine-diplomacy-methods",
            content:
                "Byzantine diplomacy was arguably the most sophisticated in the medieval world. The empire maintained a dedicated bureau of barbarians (the Office of Barbarians) to manage foreign relations, employing translators, intelligence agents, and protocol experts. Key tactics included strategic marriages of imperial princesses to foreign rulers, subsidies and tribute payments to buy peace, playing rival neighbors against each other, and converting foreign peoples to Orthodox Christianity to create cultural allies.",
            expectedClassification: "reference",
        },
        {
            id: "heraclius-reforms",
            content:
                "Emperor Heraclius (r. 610-641 CE) transformed the Byzantine Empire after defeating the Sasanian Persians in 628 CE. He replaced Latin with Greek as the official language of administration, adopted the Greek title Basileus instead of the Latin Augustus, and began reorganizing provinces into military themes. His reign marked the transition from a late Roman to a distinctly medieval Greek state, though his final years were overshadowed by the catastrophic Arab conquests that stripped away Syria, Egypt, and North Africa.",
            expectedClassification: "fact",
        },
    ];
}

function getVerificationQuestions(): VerificationQuestion[] {
    return [
        {
            id: "q-manzikert-forces",
            question:
                "How many troops did Emperor Romanos IV have at the Battle of Manzikert, and what was the main cause of defeat?",
            expectedAnswer:
                "Modern scholarship estimates Byzantine forces at 20,000-30,000 (not 40,000). The defeat was primarily caused by the desertion of Andronikos Doukas, not battlefield losses.",
            requiredEntryIds: ["supersession-manzikert-correct"],
            excludedEntryIds: ["supersession-manzikert-wrong"],
            difficulty: "hard",
        },
        {
            id: "q-hagia-status",
            question: "What is the current status of Hagia Sophia? When did it last change?",
            expectedAnswer:
                "Hagia Sophia is currently an active mosque, reconverted from a museum in July 2020 by Turkish presidential decree. It is open to tourists outside prayer times.",
            requiredEntryIds: ["supersession-hagia-correct"],
            excludedEntryIds: ["supersession-hagia-wrong"],
            difficulty: "medium",
        },
        {
            id: "q-silk-smuggle",
            question:
                "How did the Byzantine Empire acquire silkworm production capability, and who managed the industry?",
            expectedAnswer:
                "Justinian I sent two Nestorian monks to smuggle silkworm eggs from China in hollow bamboo canes around 552 CE. Production was managed by imperial guilds regulated under the Book of the Eparch: metaxopratai (raw silk), katartarioi (dyeing), and serikarioi (weaving).",
            requiredEntryIds: ["related-silk-monopoly", "related-silk-guilds"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-bezant-debasement",
            question:
                "When did the Byzantine gold solidus start being debased, and how far did it fall?",
            expectedAnswer:
                "The solidus maintained 4.48g at 24 karats for over 700 years until Constantine IX began debasement in 1034 CE. It fell to 8 karats under Nikephoros III Botaneiates (1078-1081).",
            requiredEntryIds: ["hard-bezant"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-varangian-origin",
            question: "When was the Varangian Guard established and what was the arrangement?",
            expectedAnswer:
                "Established around 988 CE when Prince Vladimir I of Kyiv sent 6,000 warriors to Emperor Basil II, as part of a military alliance sealed by Vladimir's marriage to Basil's sister Anna. After 1066, Anglo-Saxon nobles became the dominant contingent.",
            requiredEntryIds: ["hard-varangian-guard"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-theme-system",
            question:
                "What were the original four Byzantine themes and how did the strategos role differ from Roman governance?",
            expectedAnswer:
                "The four original themes were Anatolikon, Armeniakon, Opsikion, and the naval Karabisianoi. Each strategos held both military and civil authority, unlike the Roman separation of powers.",
            requiredEntryIds: ["hard-themes"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-iconoclasm-phases",
            question: "What were the exact dates of the two phases of Byzantine Iconoclasm?",
            expectedAnswer:
                "First Iconoclasm: 726-787 CE (Leo III to Second Council of Nicaea under Irene). Second Iconoclasm: 814-842 CE (Leo V to the Feast of Orthodoxy on the first Sunday of Lent 843 CE).",
            requiredEntryIds: ["hard-iconoclasm-dates"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-greek-fire-inventor",
            question:
                "Who invented Greek fire, where were they from, and when was it used decisively?",
            expectedAnswer:
                "Attributed to Kallinikos, a refugee from Heliopolis (modern Baalbek, Lebanon), around 672 CE. It was decisive in repelling Arab sieges of Constantinople in 674-678 and 717-718 CE.",
            requiredEntryIds: ["hard-greek-fire"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-fourth-crusade-payment",
            question:
                "How much did Alexios IV promise the crusaders, and when did the Latin Empire end?",
            expectedAnswer:
                "Alexios IV promised 200,000 marks of silver. The Latin Empire lasted from 1204 until 1261 when Michael VIII Palaiologos recaptured Constantinople from Baldwin II.",
            requiredEntryIds: ["hard-fourth-crusade"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-filioque-origin",
            question:
                "When was the Filioque clause first added to the Creed, and what role did it play in the Great Schism?",
            expectedAnswer:
                "First added at the Third Council of Toledo in 589 CE to the original 381 CE Niceno-Constantinopolitan Creed. In 1054, Cardinal Humbert excommunicated Patriarch Michael Cerularius, making it a key factor in the Great Schism.",
            requiredEntryIds: ["hard-filioque"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-coin-dating",
            question: "How can you determine the era of a Byzantine coin from its imagery?",
            expectedAnswer:
                "Simple cross = pre-7th century, cross on steps = 7th-8th century, Christ's portrait = late 7th century onward. Facing portraits (not profile) generally date after Justinian II's second reign (705-711 CE).",
            requiredEntryIds: ["howto-identify-coins"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-empire-longevity",
            question:
                "What was more important to the Byzantine Empire's longevity — military or bureaucracy?",
            expectedAnswer:
                "The bureaucratic system was more important: merit-based civil service with examinations, rotating officials, and an adaptable tax system. After 1071, it was the collapse of the tax base from losing Anatolia, not the military defeat itself, that proved fatal.",
            requiredEntryIds: ["insight-bureaucracy"],
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-silk-diplomacy",
            question: "How was silk used in Byzantine diplomacy?",
            expectedAnswer:
                "Silk garments were given as gifts to foreign rulers as luxury items and symbols of cultural superiority. Purple-dyed silk had strict export controls, as documented in Liudprand of Cremona's embassy accounts (968 CE).",
            requiredEntryIds: ["related-silk-diplomacy"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-justinian-legal",
            question: "What was the full name of Justinian's legal code and what did it contain?",
            expectedAnswer:
                "The Corpus Juris Civilis, which codified Roman law into a systematic collection including the Codex Justinianus, the Digest (Pandects), the Institutes, and the Novellae.",
            requiredEntryIds: [],
            excludedEntryIds: [],
            difficulty: "easy",
        },
        {
            id: "q-nika-riots",
            question: "What triggered the Nika riots and how many people were killed?",
            expectedAnswer:
                "The Nika riots of 532 CE were triggered by public anger over taxes and the arrest of chariot racing faction members. Justinian nearly fled but Theodora convinced him to stay. General Belisarius trapped the rioters in the Hippodrome and killed an estimated 30,000 people.",
            requiredEntryIds: [],
            excludedEntryIds: [],
            difficulty: "medium",
        },

        // New questions targeting expanded content
        {
            id: "q-theodora-role",
            question:
                "What role did Empress Theodora play during the Nika riots, and what were her social reforms?",
            expectedAnswer:
                "During the Nika riots of 532 CE, Empress Theodora delivered a famous speech convincing Justinian I not to flee Constantinople, which proved decisive in saving his reign. As co-ruler, she championed women's rights by closing forced prostitution houses and expanding divorce and property rights for women. She rose from humble origins as a former actress to become one of the most powerful women in Byzantine history.",
            requiredEntryIds: ["theodora-political-influence"],
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-theodosian-walls",
            question: "When were the Theodosian Walls built and how were they eventually breached?",
            expectedAnswer:
                "The Theodosian Walls were built between 408-413 CE under Emperor Theodosius II. The triple-wall system stretched 6.5 km with an inner wall 5 meters thick and 12 meters high, an outer wall, and a 20-meter-wide moat. They defended Constantinople for over a thousand years until 1453, when Ottoman Sultan Mehmed II breached them using massive cannons, particularly the great bombard built by Hungarian engineer Orban.",
            requiredEntryIds: ["theodosian-walls"],
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-pantokrator-hospital",
            question:
                "Describe the Pantokrator monastery hospital and its significance in medical history.",
            expectedAnswer:
                "The Pantokrator monastery hospital in Constantinople was founded in 1136 by Emperor John II Komnenos. It had 50 beds in five specialized wards (surgical, ophthalmological, gynecological, and two general). It employed chief physicians, surgeons, female doctors for women's wards, pharmacists, and orderlies. It was one of the most advanced medieval medical facilities and established a model for institutional healthcare.",
            requiredEntryIds: ["byzantine-hospitals"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-eternal-peace",
            question: "What was the Eternal Peace of 532, and how long did it last?",
            expectedAnswer:
                "The Eternal Peace of 532 CE was a treaty between Emperor Justinian I and Sassanid Persian King Khosrau I. Justinian paid 11,000 pounds of gold to secure the eastern frontier, freeing resources for his western reconquest campaigns. Despite its name, it lasted only eight years — Khosrau broke it in 540 CE by sacking Antioch, one of the empire's wealthiest cities.",
            requiredEntryIds: ["byzantine-sasanian-treaty"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-717-siege",
            question: "How was the Arab siege of Constantinople in 717-718 defeated?",
            expectedAnswer:
                "The Arab siege of 717-718 CE involved over 1,800 ships and 120,000 troops. Emperor Leo III used Greek fire to destroy much of the Arab fleet. A harsh winter decimated the besieging forces, and Bulgarian attacks on the Arab land army compounded their losses. The failed siege was one of the most decisive battles in world history, halting Arab expansion into Europe for centuries.",
            requiredEntryIds: ["byzantine-717-siege"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-basil-ii",
            question: "What military achievements made Basil II known as 'the Bulgar Slayer'?",
            expectedAnswer:
                "Basil II earned the epithet 'Bulgar Slayer' (Boulgaroktonos) for his decisive campaigns against the Bulgarian Empire. After the Battle of Kleidion in 1014, he allegedly blinded 99 out of every 100 captured Bulgarian soldiers, sending them back led by the hundredth who was left with one eye. This led to the complete conquest of Bulgaria by 1018, expanding the Byzantine Empire to its greatest territorial extent since Justinian I.",
            requiredEntryIds: [],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-byzantine-navy",
            question:
                "What was the role of the Byzantine navy and what technology gave it an advantage?",
            expectedAnswer:
                "The Byzantine navy was crucial for defending Constantinople and controlling Mediterranean trade routes. Its primary technological advantage was Greek fire, a napalm-like incendiary weapon deployed through pressurized siphons mounted on warships called dromons. The navy played decisive roles in the Arab sieges of Constantinople (674-678 and 717-718) and maintained Byzantine control of the Aegean Sea for centuries.",
            requiredEntryIds: [],
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-latin-empire",
            question: "What was the Latin Empire and how did it affect Byzantine civilization?",
            expectedAnswer:
                "The Latin Empire (1204-1261) was a Crusader state established after the Fourth Crusade's sack of Constantinople. It replaced Byzantine governance with Western feudal structures and Catholic ecclesiastical authority. The Latin occupation weakened Constantinople's defenses, depleted its wealth and art treasures, and permanently damaged the empire's ability to recover. Michael VIII Palaiologos recaptured the city in 1261, but the restored Byzantine Empire never regained its former strength.",
            requiredEntryIds: [],
            excludedEntryIds: [],
            difficulty: "medium",
        },
    ];
}

export async function collectData(): Promise<Dataset> {
    console.log("[Phase 0] Collecting Byzantine Empire dataset from Wikipedia...\n");

    const entries: DatasetEntry[] = [];

    for (const source of WIKIPEDIA_SOURCES) {
        console.log(`  Fetching: ${source.title}`);
        const extract = await fetchWikipediaExtract(source.title);
        if (!extract) continue;

        const chunks = chunkExtract(extract);
        for (let i = 0; i < chunks.length; i++) {
            const classification =
                source.expectedClassifications[i % source.expectedClassifications.length];
            entries.push({
                id: `wiki-${source.title.toLowerCase()}-${i}`,
                content: chunks[i],
                expectedClassification: classification,
            });
        }
    }

    const manualEntries = getManualEntries();
    entries.push(...manualEntries);

    const questions = getVerificationQuestions();

    console.log(
        `\n[Phase 0] Collected ${entries.length} entries (${entries.length - manualEntries.length} from Wikipedia, ${manualEntries.length} manual)`,
    );
    console.log(`[Phase 0] Created ${questions.length} verification questions`);

    const dataset: Dataset = { entries, questions };
    writeDataset(dataset);

    return dataset;
}

// Run directly
if (import.meta.main) {
    collectData().catch(console.error);
}
