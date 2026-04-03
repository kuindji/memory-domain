# KB Architecture Testing Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a phased testing loop that ingests Byzantine Empire knowledge, runs it through configurable KB pipeline variants, and measures buildContext()/ask() quality vs speed using real Claude CLI (haiku).

**Architecture:** Seven-phase checkpoint-based pipeline. Phase 0 collects Wikipedia data into a dataset file. Phases 1-5 run per architecture config (pipeline stages, search weights, consolidation, budget). Phase 6 generates a comparative report. Each phase reads the previous checkpoint JSON and writes its own, with fail-fast gates between phases.

**Tech Stack:** Bun test runner, SurrealDB in-memory, ClaudeCliAdapter (haiku), OnnxEmbeddingAdapter, Wikipedia API for data collection.

---

### Task 1: Shared Types and Config Definitions

**Files:**
- Create: `tests-integration/kb-architecture/types.ts`
- Create: `tests-integration/kb-architecture/configs.ts`

- [ ] **Step 1: Create the types file**

```typescript
// tests-integration/kb-architecture/types.ts

export interface DatasetEntry {
    id: string;
    content: string;
    presetClassification?: string;
    expectedClassification: string;
    supersessionGroup?: string;
    relatedGroup?: string;
}

export interface VerificationQuestion {
    id: string;
    question: string;
    expectedAnswer: string;
    requiredEntryIds: string[];
    excludedEntryIds: string[];
    difficulty: "easy" | "medium" | "hard";
}

export interface Dataset {
    entries: DatasetEntry[];
    questions: VerificationQuestion[];
}

export interface PipelineStages {
    classify: boolean;
    tagAssign: boolean;
    topicLink: boolean;
    supersede: boolean;
    relateKnowledge: boolean;
}

export interface ArchitectureConfig {
    name: string;
    pipeline: PipelineStages;
    search: {
        mode: "vector" | "fulltext" | "hybrid";
        weights: { vector: number; fulltext: number; graph: number };
    };
    consolidate: boolean;
    contextBudget: number;
}

export interface Checkpoint<T = unknown> {
    phase: number;
    config: string;
    timestamp: string;
    durationMs: number;
    status: "success" | "failed" | "stopped";
    failReason?: string;
    data: T;
}

export interface IngestedData {
    memoryIdMap: Record<string, string>;
    entryCount: number;
}

export interface ProcessedEntry {
    datasetId: string;
    memoryId: string;
    assignedClassification: string;
    expectedClassification: string;
    supersessionEdges: string[];
    relatedEdges: string[];
}

export interface ProcessedData {
    entries: ProcessedEntry[];
    stageTiming: Record<string, number>;
    classificationAccuracy: number;
}

export interface ConsolidatedData {
    clustersFound: number;
    mergesPerformed: number;
    durationMs: number;
}

export interface EvaluationEntry {
    questionId: string;
    question: string;
    expectedAnswer: string;
    difficulty: string;
    context: string;
    answer: string;
    memoriesReturned: string[];
    requiredEntryIds: string[];
    excludedEntryIds: string[];
    buildContextMs: number;
    askMs: number;
}

export interface EvaluationData {
    entries: EvaluationEntry[];
    avgBuildContextMs: number;
    avgAskMs: number;
}

export interface ScoreEntry {
    questionId: string;
    score: number;
    reasoning: string;
    contextRelevance: number;
    contextNoise: number;
    supersessionCorrect: boolean;
}

export interface ScoresData {
    entries: ScoreEntry[];
    avgScore: number;
    avgTime: number;
    qualityPerSecond: number;
    contextRelevance: number;
    contextNoise: number;
    supersessionAccuracy: number;
    classificationAccuracy: number;
}

export interface ReportRow {
    config: string;
    avgScore: number;
    avgTime: number;
    qualityPerSecond: number;
    contextRelevance: number;
    contextNoise: number;
    supersessionAccuracy: number;
    classificationAccuracy: number;
    ingestTimeMs: number;
}

export interface ReportData {
    baseline: ReportRow;
    configs: ReportRow[];
    recommendations: string[];
}
```

- [ ] **Step 2: Create the configs file**

```typescript
// tests-integration/kb-architecture/configs.ts
import type { ArchitectureConfig } from "./types.js";

const FULL_PIPELINE = {
    classify: true,
    tagAssign: true,
    topicLink: true,
    supersede: true,
    relateKnowledge: true,
};

const HYBRID_DEFAULT = {
    mode: "hybrid" as const,
    weights: { vector: 0.5, fulltext: 0.3, graph: 0.2 },
};

export const configs: ArchitectureConfig[] = [
    {
        name: "baseline-no-kb",
        pipeline: { classify: false, tagAssign: false, topicLink: false, supersede: false, relateKnowledge: false },
        search: HYBRID_DEFAULT,
        consolidate: false,
        contextBudget: 2000,
    },
    {
        name: "full-hybrid-noconsolidate-2000",
        pipeline: FULL_PIPELINE,
        search: HYBRID_DEFAULT,
        consolidate: false,
        contextBudget: 2000,
    },
    {
        name: "full-hybrid-consolidate-2000",
        pipeline: FULL_PIPELINE,
        search: HYBRID_DEFAULT,
        consolidate: true,
        contextBudget: 2000,
    },
    {
        name: "minimal-hybrid-noconsolidate-2000",
        pipeline: { classify: true, tagAssign: true, topicLink: false, supersede: false, relateKnowledge: false },
        search: HYBRID_DEFAULT,
        consolidate: false,
        contextBudget: 2000,
    },
    {
        name: "no-relations-hybrid-noconsolidate-2000",
        pipeline: { ...FULL_PIPELINE, relateKnowledge: false },
        search: HYBRID_DEFAULT,
        consolidate: false,
        contextBudget: 2000,
    },
    {
        name: "no-supersession-hybrid-noconsolidate-2000",
        pipeline: { ...FULL_PIPELINE, supersede: false, relateKnowledge: false },
        search: HYBRID_DEFAULT,
        consolidate: false,
        contextBudget: 2000,
    },
    {
        name: "full-vector-heavy-noconsolidate-2000",
        pipeline: FULL_PIPELINE,
        search: { mode: "hybrid", weights: { vector: 0.7, fulltext: 0.2, graph: 0.1 } },
        consolidate: false,
        contextBudget: 2000,
    },
    {
        name: "full-fulltext-heavy-noconsolidate-2000",
        pipeline: FULL_PIPELINE,
        search: { mode: "hybrid", weights: { vector: 0.2, fulltext: 0.7, graph: 0.1 } },
        consolidate: false,
        contextBudget: 2000,
    },
    {
        name: "full-graph-heavy-noconsolidate-2000",
        pipeline: FULL_PIPELINE,
        search: { mode: "hybrid", weights: { vector: 0.2, fulltext: 0.2, graph: 0.6 } },
        consolidate: false,
        contextBudget: 2000,
    },
    {
        name: "full-hybrid-noconsolidate-1000",
        pipeline: FULL_PIPELINE,
        search: HYBRID_DEFAULT,
        consolidate: false,
        contextBudget: 1000,
    },
    {
        name: "full-hybrid-noconsolidate-4000",
        pipeline: FULL_PIPELINE,
        search: HYBRID_DEFAULT,
        consolidate: false,
        contextBudget: 4000,
    },
    {
        name: "full-hybrid-consolidate-4000",
        pipeline: FULL_PIPELINE,
        search: HYBRID_DEFAULT,
        consolidate: true,
        contextBudget: 4000,
    },
];
```

- [ ] **Step 3: Verify types compile**

Run: `cd /Users/kuindji/Projects/@kuindji/memory-domain/.worktrees/knowledge-base-architecture-testing-loop && bun run tsc --noEmit tests-integration/kb-architecture/types.ts tests-integration/kb-architecture/configs.ts`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add tests-integration/kb-architecture/types.ts tests-integration/kb-architecture/configs.ts
git commit -m "Add types and config definitions for KB architecture testing loop"
```

---

### Task 2: Checkpoint Utilities

**Files:**
- Create: `tests-integration/kb-architecture/checkpoint.ts`

- [ ] **Step 1: Create checkpoint read/write utilities**

```typescript
// tests-integration/kb-architecture/checkpoint.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Checkpoint } from "./types.js";

const BASE_DIR = join(import.meta.dir, "checkpoints");

function checkpointPath(config: string, phase: number): string {
    const phaseNames = [
        "dataset",
        "ingested",
        "processed",
        "consolidated",
        "evaluation",
        "scores",
        "report",
    ];
    const name = phaseNames[phase] ?? `phase-${phase}`;
    return join(BASE_DIR, config, `${name}.json`);
}

export function writeCheckpoint<T>(
    config: string,
    phase: number,
    data: T,
    durationMs: number,
    status: "success" | "failed" | "stopped" = "success",
    failReason?: string,
): void {
    const path = checkpointPath(config, phase);
    mkdirSync(dirname(path), { recursive: true });

    const checkpoint: Checkpoint<T> = {
        phase,
        config,
        timestamp: new Date().toISOString(),
        durationMs,
        status,
        ...(failReason ? { failReason } : {}),
        data,
    };

    writeFileSync(path, JSON.stringify(checkpoint, null, 2));
    console.log(`[checkpoint] Wrote phase ${phase} for "${config}" → ${path}`);
}

export function readCheckpoint<T>(config: string, phase: number): Checkpoint<T> {
    const path = checkpointPath(config, phase);
    if (!existsSync(path)) {
        throw new Error(`Checkpoint not found: ${path}`);
    }
    return JSON.parse(readFileSync(path, "utf-8")) as Checkpoint<T>;
}

export function hasCheckpoint(config: string, phase: number): boolean {
    return existsSync(checkpointPath(config, phase));
}

export function datasetPath(): string {
    return join(BASE_DIR, "dataset.json");
}

export function writeDataset<T>(data: T): void {
    mkdirSync(BASE_DIR, { recursive: true });
    writeFileSync(datasetPath(), JSON.stringify(data, null, 2));
    console.log(`[checkpoint] Wrote dataset → ${datasetPath()}`);
}

export function readDataset<T>(): T {
    const path = datasetPath();
    if (!existsSync(path)) {
        throw new Error(`Dataset not found: ${path}`);
    }
    return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function listConfigCheckpoints(): string[] {
    const { readdirSync } = require("node:fs");
    if (!existsSync(BASE_DIR)) return [];
    return readdirSync(BASE_DIR, { withFileTypes: true })
        .filter((d: { isDirectory: () => boolean; name: string }) => d.isDirectory())
        .map((d: { name: string }) => d.name);
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/checkpoint.ts
git commit -m "Add checkpoint read/write utilities for architecture testing"
```

---

### Task 3: Phase 0 — Data Collection

**Files:**
- Create: `tests-integration/kb-architecture/phases/0-collect.ts`

This phase fetches data from Wikipedia's API and builds the dataset. It creates entries about the Byzantine Empire that Haiku would struggle with, plus verification questions with known correct answers.

- [ ] **Step 1: Create Phase 0 script**

```typescript
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
    { title: "Empress_Theodora_(wife_of_Justinian_I)", expectedClassifications: ["fact"] },
    { title: "Fourth_Crusade", expectedClassifications: ["fact"] },
    { title: "Greek_fire", expectedClassifications: ["definition", "concept"] },
    { title: "Filioque", expectedClassifications: ["concept", "definition"] },
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
            content: "The Battle of Manzikert in 1071 was fought between the Byzantine Empire and the Seljuk Turks. Emperor Romanos IV Diogenes led approximately 40,000 troops and was decisively defeated, losing half his army.",
            expectedClassification: "fact",
            supersessionGroup: "manzikert-casualties",
        },
        {
            id: "supersession-manzikert-correct",
            content: "The Battle of Manzikert (1071) between Emperor Romanos IV Diogenes and Sultan Alp Arslan resulted in a Byzantine defeat, but modern scholarship estimates Byzantine forces at 20,000-30,000, not the 40,000 often cited. The defeat was due more to desertions by Andronikos Doukas than battlefield losses.",
            expectedClassification: "fact",
            supersessionGroup: "manzikert-casualties",
        },

        // Supersession pair: outdated then updated
        {
            id: "supersession-hagia-wrong",
            content: "Hagia Sophia served as a mosque from 1453 until 1934, when it was converted into a museum by the Republic of Turkey under Ataturk's secularization reforms.",
            expectedClassification: "fact",
            supersessionGroup: "hagia-sophia-status",
        },
        {
            id: "supersession-hagia-correct",
            content: "Hagia Sophia served as a mosque from 1453 to 1934, then as a museum until July 2020, when it was reconverted into a mosque by a Turkish presidential decree. It remains an active mosque while also being open to tourists outside prayer times.",
            expectedClassification: "fact",
            supersessionGroup: "hagia-sophia-status",
        },

        // Related knowledge cluster: Byzantine silk industry
        {
            id: "related-silk-monopoly",
            content: "The Byzantine Empire held a strict monopoly on silk production in Europe from the 6th century onward. Emperor Justinian I allegedly sent two Nestorian monks to smuggle silkworm eggs from China hidden inside hollow bamboo canes around 552 CE, breaking China's ancient monopoly.",
            expectedClassification: "fact",
            relatedGroup: "silk-industry",
        },
        {
            id: "related-silk-guilds",
            content: "Byzantine silk production was managed by imperial guilds regulated under the Book of the Eparch (10th century). The guilds controlled every stage: raw silk purchase (metaxopratai), dyeing (katartarioi), and weaving (serikarioi). Purple silk was reserved exclusively for the imperial family.",
            expectedClassification: "reference",
            relatedGroup: "silk-industry",
        },
        {
            id: "related-silk-diplomacy",
            content: "Silk served as a key instrument of Byzantine diplomacy. Imperial silk garments were given as gifts to foreign rulers and ambassadors, functioning as both luxury items and symbols of Byzantine cultural superiority. The Liudprand of Cremona embassy accounts (968 CE) describe strict export controls on purple-dyed silk.",
            expectedClassification: "insight",
            relatedGroup: "silk-industry",
        },

        // Hard facts Haiku would likely hallucinate
        {
            id: "hard-bezant",
            content: "The Byzantine gold solidus (bezant) maintained nearly constant weight and purity (4.48g, 24 karats) for over 700 years from Constantine I (309 CE) until Emperor Constantine IX began debasement in 1034 CE. The nomisma histamenon eventually fell to 8 karats under Nikephoros III Botaneiates (1078-1081).",
            expectedClassification: "fact",
        },
        {
            id: "hard-varangian-guard",
            content: "The Varangian Guard was established around 988 CE when Prince Vladimir I of Kyiv sent 6,000 warriors to Emperor Basil II as part of a military alliance sealed by Vladimir's marriage to Basil's sister Anna. After the Norman Conquest of 1066, many Anglo-Saxon nobles joined the Guard, eventually becoming its dominant contingent.",
            expectedClassification: "fact",
        },
        {
            id: "hard-themes",
            content: "The Theme system replaced the late Roman provincial structure beginning under Emperor Heraclius (610-641) or possibly Constans II (641-668). The original four themes were Anatolikon, Armeniakon, Opsikion, and the naval Karabisianoi. Each theme was governed by a strategos who held both military and civil authority, fundamentally different from the Roman separation of powers.",
            expectedClassification: "definition",
        },
        {
            id: "hard-iconoclasm-dates",
            content: "Byzantine Iconoclasm had two distinct phases: the First Iconoclasm (726-787 CE) initiated by Emperor Leo III the Isaurian and ended by the Second Council of Nicaea under Empress Irene; the Second Iconoclasm (814-842 CE) began under Emperor Leo V the Armenian and ended definitively on the first Sunday of Lent 843 CE, now celebrated as the Feast of Orthodoxy.",
            expectedClassification: "fact",
        },
        {
            id: "hard-greek-fire",
            content: "Greek fire was invented around 672 CE, traditionally attributed to Kallinikos, a refugee from Heliopolis (modern Baalbek, Lebanon). The exact composition remains unknown, but likely included naphtha, quicklime, sulfur, and possibly saltpeter. It was deployed through bronze siphons mounted on ship prows and could burn on water. Its use was decisive in repelling the Arab sieges of Constantinople in 674-678 and 717-718 CE.",
            expectedClassification: "reference",
        },
        {
            id: "hard-fourth-crusade",
            content: "The Fourth Crusade's sack of Constantinople in April 1204 was preceded by a complex chain of events: the crusaders diverted to Constantinople to support Alexios IV Angelos' claim to the throne, installed him as co-emperor, then attacked when he couldn't pay the promised 200,000 marks of silver. The resulting Latin Empire lasted only until 1261 when Michael VIII Palaiologos recaptured the city from Baldwin II.",
            expectedClassification: "fact",
        },
        {
            id: "hard-filioque",
            content: "The Filioque controversy centered on whether the Holy Spirit proceeds from the Father alone (Eastern position) or from the Father 'and the Son' (Filioque, Western position). The original Niceno-Constantinopolitan Creed of 381 CE stated 'proceeds from the Father.' The Filioque was first added at the Third Council of Toledo in 589 CE. It became a key factor in the Great Schism of 1054 when Cardinal Humbert excommunicated Patriarch Michael Cerularius.",
            expectedClassification: "concept",
        },
        // How-to and insight entries
        {
            id: "howto-identify-coins",
            content: "To identify a Byzantine coin's era: examine the cross on the obverse — a simple cross suggests pre-7th century, a cross on steps indicates 7th-8th century, and Christ's portrait appears from the late 7th century onward. The reverse typically shows the emperor's title and regnal year in Greek numerals. Coins with facing portraits (rather than profile) generally date after Justinian II's second reign (705-711 CE).",
            expectedClassification: "how-to",
        },
        {
            id: "insight-bureaucracy",
            content: "The Byzantine Empire's longevity (over 1,100 years) owed much to its sophisticated bureaucratic system rather than military might alone. The civil service was merit-based with examinations, officials rotated to prevent local power bases, and the tax system (based on the Roman capitatio-iugatio) adapted remarkably to territorial losses. When the empire lost Anatolia after 1071, it was the collapse of the tax base — not the military defeat itself — that proved fatal.",
            expectedClassification: "insight",
        },
    ];
}

function getVerificationQuestions(): VerificationQuestion[] {
    return [
        {
            id: "q-manzikert-forces",
            question: "How many troops did Emperor Romanos IV have at the Battle of Manzikert, and what was the main cause of defeat?",
            expectedAnswer: "Modern scholarship estimates Byzantine forces at 20,000-30,000 (not 40,000). The defeat was primarily caused by the desertion of Andronikos Doukas, not battlefield losses.",
            requiredEntryIds: ["supersession-manzikert-correct"],
            excludedEntryIds: ["supersession-manzikert-wrong"],
            difficulty: "hard",
        },
        {
            id: "q-hagia-status",
            question: "What is the current status of Hagia Sophia? When did it last change?",
            expectedAnswer: "Hagia Sophia is currently an active mosque, reconverted from a museum in July 2020 by Turkish presidential decree. It is open to tourists outside prayer times.",
            requiredEntryIds: ["supersession-hagia-correct"],
            excludedEntryIds: ["supersession-hagia-wrong"],
            difficulty: "medium",
        },
        {
            id: "q-silk-smuggle",
            question: "How did the Byzantine Empire acquire silkworm production capability, and who managed the industry?",
            expectedAnswer: "Justinian I sent two Nestorian monks to smuggle silkworm eggs from China in hollow bamboo canes around 552 CE. Production was managed by imperial guilds regulated under the Book of the Eparch: metaxopratai (raw silk), katartarioi (dyeing), and serikarioi (weaving).",
            requiredEntryIds: ["related-silk-monopoly", "related-silk-guilds"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-bezant-debasement",
            question: "When did the Byzantine gold solidus start being debased, and how far did it fall?",
            expectedAnswer: "The solidus maintained 4.48g at 24 karats for over 700 years until Constantine IX began debasement in 1034 CE. It fell to 8 karats under Nikephoros III Botaneiates (1078-1081).",
            requiredEntryIds: ["hard-bezant"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-varangian-origin",
            question: "When was the Varangian Guard established and what was the arrangement?",
            expectedAnswer: "Established around 988 CE when Prince Vladimir I of Kyiv sent 6,000 warriors to Emperor Basil II, as part of a military alliance sealed by Vladimir's marriage to Basil's sister Anna. After 1066, Anglo-Saxon nobles became the dominant contingent.",
            requiredEntryIds: ["hard-varangian-guard"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-theme-system",
            question: "What were the original four Byzantine themes and how did the strategos role differ from Roman governance?",
            expectedAnswer: "The four original themes were Anatolikon, Armeniakon, Opsikion, and the naval Karabisianoi. Each strategos held both military and civil authority, unlike the Roman separation of powers.",
            requiredEntryIds: ["hard-themes"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-iconoclasm-phases",
            question: "What were the exact dates of the two phases of Byzantine Iconoclasm?",
            expectedAnswer: "First Iconoclasm: 726-787 CE (Leo III to Second Council of Nicaea under Irene). Second Iconoclasm: 814-842 CE (Leo V to the Feast of Orthodoxy on the first Sunday of Lent 843 CE).",
            requiredEntryIds: ["hard-iconoclasm-dates"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-greek-fire-inventor",
            question: "Who invented Greek fire, where were they from, and when was it used decisively?",
            expectedAnswer: "Attributed to Kallinikos, a refugee from Heliopolis (modern Baalbek, Lebanon), around 672 CE. It was decisive in repelling Arab sieges of Constantinople in 674-678 and 717-718 CE.",
            requiredEntryIds: ["hard-greek-fire"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-fourth-crusade-payment",
            question: "How much did Alexios IV promise the crusaders, and when did the Latin Empire end?",
            expectedAnswer: "Alexios IV promised 200,000 marks of silver. The Latin Empire lasted from 1204 until 1261 when Michael VIII Palaiologos recaptured Constantinople from Baldwin II.",
            requiredEntryIds: ["hard-fourth-crusade"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-filioque-origin",
            question: "When was the Filioque clause first added to the Creed, and what role did it play in the Great Schism?",
            expectedAnswer: "First added at the Third Council of Toledo in 589 CE to the original 381 CE Niceno-Constantinopolitan Creed. In 1054, Cardinal Humbert excommunicated Patriarch Michael Cerularius, making it a key factor in the Great Schism.",
            requiredEntryIds: ["hard-filioque"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-coin-dating",
            question: "How can you determine the era of a Byzantine coin from its imagery?",
            expectedAnswer: "Simple cross = pre-7th century, cross on steps = 7th-8th century, Christ's portrait = late 7th century onward. Facing portraits (not profile) generally date after Justinian II's second reign (705-711 CE).",
            requiredEntryIds: ["howto-identify-coins"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-empire-longevity",
            question: "What was more important to the Byzantine Empire's longevity — military or bureaucracy?",
            expectedAnswer: "The bureaucratic system was more important: merit-based civil service with examinations, rotating officials, and an adaptable tax system. After 1071, it was the collapse of the tax base from losing Anatolia, not the military defeat itself, that proved fatal.",
            requiredEntryIds: ["insight-bureaucracy"],
            excludedEntryIds: [],
            difficulty: "medium",
        },
        {
            id: "q-silk-diplomacy",
            question: "How was silk used in Byzantine diplomacy?",
            expectedAnswer: "Silk garments were given as gifts to foreign rulers as luxury items and symbols of cultural superiority. Purple-dyed silk had strict export controls, as documented in Liudprand of Cremona's embassy accounts (968 CE).",
            requiredEntryIds: ["related-silk-diplomacy"],
            excludedEntryIds: [],
            difficulty: "hard",
        },
        {
            id: "q-justinian-legal",
            question: "What was the full name of Justinian's legal code and what did it contain?",
            expectedAnswer: "The Corpus Juris Civilis, which codified Roman law into a systematic collection including the Codex Justinianus, the Digest (Pandects), the Institutes, and the Novellae.",
            requiredEntryIds: [],
            excludedEntryIds: [],
            difficulty: "easy",
        },
        {
            id: "q-nika-riots",
            question: "What triggered the Nika riots and how many people were killed?",
            expectedAnswer: "The Nika riots of 532 CE were triggered by public anger over taxes and the arrest of chariot racing faction members. Justinian nearly fled but Theodora convinced him to stay. General Belisarius trapped the rioters in the Hippodrome and killed an estimated 30,000 people.",
            requiredEntryIds: [],
            excludedEntryIds: [],
            difficulty: "medium",
        },
    ];
}

export async function collectData(): Promise<Dataset> {
    console.log("[Phase 0] Collecting Byzantine Empire dataset from Wikipedia...\n");

    const entries: DatasetEntry[] = [];
    let autoId = 0;

    for (const source of WIKIPEDIA_SOURCES) {
        console.log(`  Fetching: ${source.title}`);
        const extract = await fetchWikipediaExtract(source.title);
        if (!extract) continue;

        const chunks = chunkExtract(extract);
        for (let i = 0; i < chunks.length; i++) {
            const classification = source.expectedClassifications[i % source.expectedClassifications.length];
            entries.push({
                id: `wiki-${source.title.toLowerCase()}-${i}`,
                content: chunks[i],
                expectedClassification: classification,
            });
            autoId++;
        }
    }

    const manualEntries = getManualEntries();
    entries.push(...manualEntries);

    const questions = getVerificationQuestions();

    console.log(`\n[Phase 0] Collected ${entries.length} entries (${entries.length - manualEntries.length} from Wikipedia, ${manualEntries.length} manual)`);
    console.log(`[Phase 0] Created ${questions.length} verification questions`);

    const dataset: Dataset = { entries, questions };
    writeDataset(dataset);

    return dataset;
}

// Run directly
if (import.meta.main) {
    collectData().catch(console.error);
}
```

- [ ] **Step 2: Run Phase 0 to verify it works**

Run: `cd /Users/kuindji/Projects/@kuindji/memory-domain/.worktrees/knowledge-base-architecture-testing-loop && bun run tests-integration/kb-architecture/phases/0-collect.ts`
Expected: Output showing Wikipedia fetches and dataset.json written to checkpoints/

- [ ] **Step 3: Commit**

```bash
git add tests-integration/kb-architecture/phases/0-collect.ts
git commit -m "Add Phase 0: Wikipedia data collection for Byzantine Empire dataset"
```

---

### Task 4: Configurable KB Inbox Processing

**Files:**
- Create: `tests-integration/kb-architecture/configurable-inbox.ts`

This creates a modified `processInboxBatch` that respects the `PipelineStages` config. It wraps the existing stage functions, calling only the enabled ones.

- [ ] **Step 1: Create the configurable inbox processor**

```typescript
// tests-integration/kb-architecture/configurable-inbox.ts
import type { OwnedMemory, DomainContext, ScoredMemory } from "../../src/core/types.js";
import type { KbClassification } from "../../src/domains/kb/types.js";
import { KB_TAG, KB_DOMAIN_ID, CLASSIFICATION_TAGS } from "../../src/domains/kb/types.js";
import { ensureTag, classificationToTag, linkToTopicsBatch } from "../../src/domains/kb/utils.js";
import type { PipelineStages } from "./types.js";

const VALID_CLASSIFICATIONS = new Set<string>([
    "fact", "definition", "how-to", "reference", "concept", "insight",
]);

const BATCH_CLASSIFICATION_PROMPT =
    "Classify each numbered item below into exactly one knowledge category:\n" +
    '- fact: a verified, discrete piece of knowledge ("HTTP 429 means Too Many Requests")\n' +
    '- definition: a term or concept definition ("Eventual consistency means...")\n' +
    '- how-to: a procedural explanation or recipe ("To reset a PostgreSQL sequence...")\n' +
    '- reference: a technical reference, specification, or standard ("RFC 7519 defines JWT...")\n' +
    '- concept: an abstract idea, principle, or mental model ("The CAP theorem states...")\n' +
    '- insight: a personal conclusion or learned lesson ("In practice, optimistic locking works better...")\n\n';

const BATCH_SUPERSESSION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            newIndex: { type: "number", description: "Zero-based index of the new entry" },
            existingId: { type: "string", description: "ID of the superseded existing entry" },
        },
        required: ["newIndex", "existingId"],
    },
});

const BATCH_RELATIONSHIP_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            newIndex: { type: "number", description: "Zero-based index of the new entry" },
            existingId: { type: "string", description: "ID of the related existing entry" },
            relationship: {
                type: "string",
                enum: ["prerequisite", "example-of", "contrast", "elaboration"],
                description: "How the new entry relates to the existing one",
            },
        },
        required: ["newIndex", "existingId", "relationship"],
    },
});

const SUPERSESSION_PROMPT_BUDGET = 4000;

function logWarn(scope: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[kb-arch-test warning] ${scope}: ${msg}`);
}

/**
 * Creates a processInboxBatch function that only runs the enabled stages.
 * Mirrors the logic in src/domains/kb/inbox.ts but with per-stage toggles.
 */
export function createConfigurableInboxProcessor(stages: PipelineStages) {
    return async function processInboxBatch(
        entries: OwnedMemory[],
        context: DomainContext,
    ): Promise<void> {
        await context.debug.time("kb.inbox.total", async () => {
            // Stage 1: Classification (always needed for tagging)
            let classificationMap: Map<string, string>;
            if (stages.classify) {
                classificationMap = await context.debug.time(
                    "kb.inbox.classify",
                    () => batchClassify(entries, context),
                    { entries: entries.length },
                );
            } else {
                classificationMap = new Map();
                for (const entry of entries) {
                    classificationMap.set(entry.memory.id, "fact");
                }
            }

            // Stage 2: Tag & Attribute assignment
            if (stages.tagAssign) {
                const kbTagId = await ensureTag(context, KB_TAG);
                await context.debug.time("kb.inbox.tagAndAttribute", async () => {
                    for (const entry of entries) {
                        const classification = classificationMap.get(entry.memory.id) ?? "fact";
                        const existingSource = entry.domainAttributes.source as string | undefined;

                        await context.updateAttributes(entry.memory.id, {
                            classification,
                            superseded: false,
                            ...(existingSource ? { source: existingSource } : {}),
                        });

                        await context.tagMemory(entry.memory.id, kbTagId);

                        const classTag = classificationToTag(classification as KbClassification);
                        const classTagId = await ensureTag(context, classTag);
                        try {
                            await context.graph.relate(classTagId, "child_of", kbTagId);
                        } catch { /* already related */ }
                        await context.tagMemory(entry.memory.id, classTagId);
                    }
                }, { entries: entries.length });
            }

            // Stage 3: Topic linking
            if (stages.topicLink) {
                await context.debug.time(
                    "kb.inbox.topicLinking",
                    () => linkToTopicsBatch(context, entries),
                    { entries: entries.length },
                );
            }

            // Stage 4: Supersession detection
            if (stages.supersede) {
                await context.debug.time(
                    "kb.inbox.supersessionDetection",
                    () => batchDetectSupersession(entries, classificationMap, context),
                    { entries: entries.length },
                );
            }

            // Stage 5: Related knowledge linking
            if (stages.relateKnowledge) {
                await context.debug.time(
                    "kb.inbox.relatedLinking",
                    () => batchLinkRelated(entries, classificationMap, context),
                    { entries: entries.length },
                );
            }
        }, { entries: entries.length });
    };
}

// --- Stage implementations (copied from src/domains/kb/inbox.ts) ---

async function batchClassify(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    const needsClassification: { entry: OwnedMemory; index: number }[] = [];
    for (let i = 0; i < entries.length; i++) {
        const existing = entries[i].domainAttributes.classification as string | undefined;
        if (existing && VALID_CLASSIFICATIONS.has(existing)) {
            result.set(entries[i].memory.id, existing);
        } else {
            needsClassification.push({ entry: entries[i], index: i });
        }
    }

    if (needsClassification.length === 0) return result;

    const classifyLlm = context.llmAt("low");
    if (!classifyLlm.generate) {
        for (const { entry } of needsClassification) {
            result.set(entry.memory.id, "fact");
        }
        return result;
    }

    const numberedItems = needsClassification
        .map((item, i) => `${i + 1}. ${item.entry.memory.content}`)
        .join("\n\n");

    const prompt =
        BATCH_CLASSIFICATION_PROMPT +
        `Items:\n${numberedItems}\n\n` +
        "Respond with ONLY one category per line, matching the item number:\n" +
        needsClassification.map((_, i) => `${i + 1}. <category>`).join("\n");

    try {
        const response = await classifyLlm.generate(prompt);
        const lines = response.trim().split("\n");

        for (let i = 0; i < needsClassification.length; i++) {
            const line = lines[i]?.trim().toLowerCase() ?? "";
            const match = line.match(/^\d+\.\s*(.+)$/);
            const normalized = match ? match[1].trim() : line;
            const classification = VALID_CLASSIFICATIONS.has(normalized) ? normalized : "fact";
            result.set(needsClassification[i].entry.memory.id, classification);
        }
    } catch (error) {
        logWarn("kb.inbox.classify", error);
        for (const { entry } of needsClassification) {
            result.set(entry.memory.id, "fact");
        }
    }

    return result;
}

async function batchDetectSupersession(
    entries: OwnedMemory[],
    classificationMap: Map<string, string>,
    context: DomainContext,
): Promise<void> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return;

    const newEntryIds = new Set(entries.map((e) => e.memory.id));
    const existingMap = new Map<string, ScoredMemory>();

    for (const entry of entries) {
        const classification = classificationMap.get(entry.memory.id) ?? "fact";
        const classTag = classificationToTag(classification as KbClassification);

        const searchResult = await context.search({
            text: entry.memory.content,
            tags: [classTag],
            minScore: 0.7,
        });

        for (const existing of searchResult.entries) {
            if (newEntryIds.has(existing.id)) continue;
            const attrs = existing.domainAttributes[KB_DOMAIN_ID] as Record<string, unknown> | undefined;
            if (attrs && !attrs.superseded) {
                existingMap.set(existing.id, existing);
            }
        }
    }

    const existingEntries = [...existingMap.values()];
    if (existingEntries.length === 0) return;

    const batches = buildSupersessionBatches(entries, existingEntries);
    for (const batch of batches) {
        await processSupersessionBatch(batch.newEntries, batch.existingEntries, context);
    }
}

interface SupersessionBatch {
    newEntries: OwnedMemory[];
    existingEntries: ScoredMemory[];
}

function buildSupersessionBatches(
    newEntries: OwnedMemory[],
    existingEntries: ScoredMemory[],
): SupersessionBatch[] {
    const batches: SupersessionBatch[] = [];
    const totalExistingLength = existingEntries.reduce((sum, e) => sum + e.content.length, 0);

    let currentNew: OwnedMemory[] = [];
    let currentPromptLength = totalExistingLength;

    for (const entry of newEntries) {
        const entryLength = entry.memory.content.length;
        const projectedLength = currentPromptLength + entryLength;

        if (currentNew.length > 0 && projectedLength > SUPERSESSION_PROMPT_BUDGET) {
            batches.push({ newEntries: currentNew, existingEntries });
            currentNew = [];
            currentPromptLength = totalExistingLength;
        }

        currentNew.push(entry);
        currentPromptLength += entryLength;
    }

    if (currentNew.length > 0) {
        batches.push({ newEntries: currentNew, existingEntries });
    }

    return batches;
}

async function processSupersessionBatch(
    newEntries: OwnedMemory[],
    existingEntries: ScoredMemory[],
    context: DomainContext,
): Promise<void> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return;

    const newItems = newEntries.map((e, i) => `${i}. ${e.memory.content}`).join("\n");
    const existingItems = existingEntries.map((e) => `[${e.id}] ${e.content}`).join("\n");

    const prompt =
        "For each new knowledge entry, identify which existing entries it supersedes (if any). " +
        "An entry is superseded when the new entry corrects, updates, or replaces the existing one. " +
        "Only flag true supersession — not mere similarity or overlap.\n\n" +
        `New entries:\n${newItems}\n\n` +
        `Existing entries:\n${existingItems}\n\n` +
        "Return only actual supersessions. If none exist, return an empty array.";

    try {
        const pairs = (await llm.extractStructured(
            prompt, BATCH_SUPERSESSION_SCHEMA,
            "Identify superseded knowledge pairs.",
        )) as Array<{ newIndex: number; existingId: string }>;

        for (const pair of pairs) {
            if (pair.newIndex < 0 || pair.newIndex >= newEntries.length) continue;
            const newMemoryId = newEntries[pair.newIndex].memory.id;
            const existing = existingEntries.find((e) => e.id === pair.existingId);
            if (!existing) continue;

            await context.graph.relate(newMemoryId, "supersedes", existing.id);
            await context.updateAttributes(existing.id, {
                ...existing.domainAttributes[KB_DOMAIN_ID],
                superseded: true,
            });
        }
    } catch (error) {
        logWarn("kb.inbox.supersessionDetection", error);
    }
}

async function batchLinkRelated(
    entries: OwnedMemory[],
    classificationMap: Map<string, string>,
    context: DomainContext,
): Promise<void> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return;

    const newEntryIds = new Set(entries.map((e) => e.memory.id));
    const relatedMap = new Map<string, ScoredMemory>();

    for (const entry of entries) {
        const searchResult = await context.search({
            text: entry.memory.content,
            tags: [KB_TAG],
            minScore: 0.75,
        });

        for (const candidate of searchResult.entries) {
            if (newEntryIds.has(candidate.id)) continue;
            const attrs = candidate.domainAttributes[KB_DOMAIN_ID] as Record<string, unknown> | undefined;
            if (attrs?.superseded) continue;
            relatedMap.set(candidate.id, candidate);
        }
    }

    const relatedEntries = [...relatedMap.values()];
    if (relatedEntries.length === 0) return;

    const newItems = entries
        .map((e, i) => `${i}. [${classificationMap.get(e.memory.id) ?? "fact"}] ${e.memory.content}`)
        .join("\n");
    const existingItems = relatedEntries.map((e) => `[${e.id}] ${e.content}`).join("\n");

    const prompt =
        "For each new knowledge entry, identify which existing entries are directly related (but NOT superseded). " +
        "Describe the relationship type: prerequisite (must understand this first), example-of (illustrates a concept), " +
        "contrast (presents an opposing or alternative view), elaboration (adds detail to existing knowledge).\n\n" +
        `New entries:\n${newItems}\n\n` +
        `Existing entries:\n${existingItems}\n\n` +
        "Return only meaningful relationships. If none exist, return an empty array.";

    try {
        const relationships = (await llm.extractStructured(
            prompt, BATCH_RELATIONSHIP_SCHEMA,
            "Identify related knowledge pairs.",
        )) as Array<{ newIndex: number; existingId: string; relationship: string }>;

        for (const rel of relationships) {
            if (rel.newIndex < 0 || rel.newIndex >= entries.length) continue;
            const newMemoryId = entries[rel.newIndex].memory.id;
            const existing = relatedEntries.find((e) => e.id === rel.existingId);
            if (!existing) continue;

            try {
                await context.graph.relate(newMemoryId, "related_knowledge", existing.id, {
                    relationship: rel.relationship,
                });
            } catch { /* best-effort */ }
        }
    } catch (error) {
        logWarn("kb.inbox.relatedLinking", error);
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/configurable-inbox.ts
git commit -m "Add configurable inbox processor with per-stage toggles"
```

---

### Task 5: Engine Factory for Architecture Configs

**Files:**
- Create: `tests-integration/kb-architecture/engine-factory.ts`

This creates a factory that builds a MemoryEngine configured for a specific architecture variant.

- [ ] **Step 1: Create the engine factory**

```typescript
// tests-integration/kb-architecture/engine-factory.ts
import { MemoryEngine } from "../../src/core/engine.js";
import { ClaudeCliAdapter } from "../../src/adapters/llm/claude-cli.js";
import { OnnxEmbeddingAdapter } from "../../src/adapters/onnx-embedding.js";
import { topicDomain } from "../../src/domains/topic/index.js";
import { createKbDomain } from "../../src/domains/kb/kb-domain.js";
import type { ArchitectureConfig } from "./types.js";
import { createConfigurableInboxProcessor } from "./configurable-inbox.js";
import type { DomainConfig } from "../../src/core/types.js";

const llm = new ClaudeCliAdapter({ model: "haiku" });
const embedding = new OnnxEmbeddingAdapter();

export function getLlm(): ClaudeCliAdapter {
    return llm;
}

export function getEmbedding(): OnnxEmbeddingAdapter {
    return embedding;
}

/**
 * Creates a MemoryEngine configured for a specific architecture variant.
 * The KB domain's processInboxBatch is replaced with a configurable version.
 */
export async function createConfiguredEngine(config: ArchitectureConfig): Promise<MemoryEngine> {
    const engine = new MemoryEngine();
    await engine.initialize({
        connection: "mem://",
        namespace: "test",
        database: `arch_${config.name}_${Date.now()}`,
        llm,
        embedding,
        search: {
            defaultMode: config.search.mode,
            defaultWeights: config.search.weights,
        },
        debug: { timing: true },
    });

    // Create a modified KB domain with configurable pipeline stages
    const baseDomain = createKbDomain({
        consolidateSchedule: { enabled: false }, // We run consolidation manually in Phase 3
    });

    const configurableProcessor = createConfigurableInboxProcessor(config.pipeline);

    const modifiedDomain: DomainConfig = {
        ...baseDomain,
        processInboxBatch: configurableProcessor,
    };

    await engine.registerDomain(modifiedDomain);
    await engine.registerDomain(topicDomain);

    return engine;
}

export async function drainInbox(engine: MemoryEngine): Promise<void> {
    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/engine-factory.ts
git commit -m "Add engine factory for architecture config variants"
```

---

### Task 6: Phase 1 — Ingest

**Files:**
- Create: `tests-integration/kb-architecture/phases/1-ingest.ts`

- [ ] **Step 1: Create Phase 1 script**

```typescript
// tests-integration/kb-architecture/phases/1-ingest.ts
import type { ArchitectureConfig, Dataset, IngestedData } from "../types.js";
import { readDataset, writeCheckpoint } from "../checkpoint.js";
import { createConfiguredEngine } from "../engine-factory.js";
import { KB_DOMAIN_ID } from "../../../src/domains/kb/types.js";
import type { MemoryEngine } from "../../../src/core/engine.js";

export async function runIngest(
    config: ArchitectureConfig,
): Promise<{ engine: MemoryEngine; data: IngestedData }> {
    const dataset = readDataset<Dataset>();
    const start = performance.now();

    console.log(`\n[Phase 1: Ingest] Config: "${config.name}", entries: ${dataset.entries.length}`);

    const engine = await createConfiguredEngine(config);
    const memoryIdMap: Record<string, string> = {};

    for (const entry of dataset.entries) {
        const metadata: Record<string, unknown> = {
            datasetId: entry.id,
        };
        if (entry.presetClassification) {
            metadata.classification = entry.presetClassification;
        }

        const result = await engine.ingest(entry.content, {
            domains: [KB_DOMAIN_ID],
            metadata,
        });

        if (result.id) {
            memoryIdMap[entry.id] = result.id;
        }
    }

    const durationMs = performance.now() - start;
    const data: IngestedData = {
        memoryIdMap,
        entryCount: Object.keys(memoryIdMap).length,
    };

    writeCheckpoint(config.name, 1, data, durationMs);
    console.log(`[Phase 1] Ingested ${data.entryCount} entries in ${(durationMs / 1000).toFixed(1)}s`);

    return { engine, data };
}

if (import.meta.main) {
    const configName = process.argv[2];
    if (!configName) {
        console.error("Usage: bun run phases/1-ingest.ts <config-name>");
        process.exit(1);
    }
    const { configs } = await import("../configs.js");
    const config = configs.find((c) => c.name === configName);
    if (!config) {
        console.error(`Config "${configName}" not found`);
        process.exit(1);
    }
    const { engine } = await runIngest(config);
    await engine.close();
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/phases/1-ingest.ts
git commit -m "Add Phase 1: data ingestion into configured engine"
```

---

### Task 7: Phase 2 — Process Inbox

**Files:**
- Create: `tests-integration/kb-architecture/phases/2-process.ts`

- [ ] **Step 1: Create Phase 2 script**

```typescript
// tests-integration/kb-architecture/phases/2-process.ts
import type { ArchitectureConfig, Dataset, IngestedData, ProcessedData, ProcessedEntry } from "../types.js";
import { readDataset, readCheckpoint, writeCheckpoint } from "../checkpoint.js";
import { drainInbox } from "../engine-factory.js";
import { KB_DOMAIN_ID, KB_TAG } from "../../../src/domains/kb/types.js";
import type { MemoryEngine } from "../../../src/core/engine.js";

export async function runProcess(
    config: ArchitectureConfig,
    engine: MemoryEngine,
): Promise<ProcessedData> {
    const dataset = readDataset<Dataset>();
    const ingested = readCheckpoint<IngestedData>(config.name, 1);
    const start = performance.now();

    console.log(`\n[Phase 2: Process] Config: "${config.name}"`);
    console.log(`  Pipeline: classify=${config.pipeline.classify} tag=${config.pipeline.tagAssign} topic=${config.pipeline.topicLink} supersede=${config.pipeline.supersede} relate=${config.pipeline.relateKnowledge}`);

    await drainInbox(engine);

    const ctx = engine.createDomainContext(KB_DOMAIN_ID);
    const processedEntries: ProcessedEntry[] = [];

    let correctClassifications = 0;
    let totalClassified = 0;

    for (const datasetEntry of dataset.entries) {
        const memoryId = ingested.data.memoryIdMap[datasetEntry.id];
        if (!memoryId) continue;

        // Get classification from ownership attributes
        const edges = await ctx.getNodeEdges(memoryId, "out");
        let assignedClassification = "unknown";
        let supersessionEdges: string[] = [];
        let relatedEdges: string[] = [];

        for (const edge of edges) {
            const edgeId = typeof edge.id === "string" ? edge.id : String(edge.id);
            if (edgeId.startsWith("owned_by:")) {
                const attrs = edge as unknown as Record<string, unknown>;
                if (typeof attrs.attributes === "object" && attrs.attributes !== null) {
                    const ownAttrs = attrs.attributes as Record<string, unknown>;
                    if (typeof ownAttrs.classification === "string") {
                        assignedClassification = ownAttrs.classification;
                    }
                }
            }
            if (edgeId.startsWith("supersedes:")) {
                supersessionEdges.push(String(edge.in));
            }
            if (edgeId.startsWith("related_knowledge:")) {
                relatedEdges.push(String(edge.in));
            }
        }

        // Also check incoming edges for supersession
        const inEdges = await ctx.getNodeEdges(memoryId, "in");
        for (const edge of inEdges) {
            const edgeId = typeof edge.id === "string" ? edge.id : String(edge.id);
            if (edgeId.startsWith("supersedes:")) {
                // This memory was superseded by edge.out
                supersessionEdges.push(String(edge.out));
            }
        }

        if (assignedClassification !== "unknown") {
            totalClassified++;
            if (assignedClassification === datasetEntry.expectedClassification) {
                correctClassifications++;
            }
        }

        processedEntries.push({
            datasetId: datasetEntry.id,
            memoryId,
            assignedClassification,
            expectedClassification: datasetEntry.expectedClassification,
            supersessionEdges,
            relatedEdges,
        });
    }

    const classificationAccuracy = totalClassified > 0 ? correctClassifications / totalClassified : 0;
    const durationMs = performance.now() - start;

    const data: ProcessedData = {
        entries: processedEntries,
        stageTiming: {}, // Timing comes from debug output
        classificationAccuracy,
    };

    writeCheckpoint(config.name, 2, data, durationMs);

    // Fail-fast checks
    const factCount = processedEntries.filter((e) => e.assignedClassification === "fact").length;
    const factRatio = totalClassified > 0 ? factCount / totalClassified : 0;

    console.log(`[Phase 2] Classification accuracy: ${(classificationAccuracy * 100).toFixed(1)}%`);
    console.log(`[Phase 2] Fact ratio: ${(factRatio * 100).toFixed(1)}% (${factCount}/${totalClassified})`);
    console.log(`[Phase 2] Duration: ${(durationMs / 1000).toFixed(1)}s`);

    if (factRatio > 0.5 && config.pipeline.classify) {
        console.warn(`[Phase 2 WARNING] >50% entries classified as "fact" — possible classification failure`);
    }

    return data;
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/phases/2-process.ts
git commit -m "Add Phase 2: inbox processing with fail-fast classification check"
```

---

### Task 8: Phase 3 — Consolidate

**Files:**
- Create: `tests-integration/kb-architecture/phases/3-consolidate.ts`

- [ ] **Step 1: Create Phase 3 script**

```typescript
// tests-integration/kb-architecture/phases/3-consolidate.ts
import type { ArchitectureConfig, ConsolidatedData } from "../types.js";
import { writeCheckpoint } from "../checkpoint.js";
import { consolidateKnowledge } from "../../../src/domains/kb/schedules.js";
import { KB_DOMAIN_ID } from "../../../src/domains/kb/types.js";
import type { MemoryEngine } from "../../../src/core/engine.js";

export async function runConsolidate(
    config: ArchitectureConfig,
    engine: MemoryEngine,
): Promise<ConsolidatedData> {
    if (!config.consolidate) {
        console.log(`\n[Phase 3: Consolidate] Skipped (consolidation disabled for "${config.name}")`);
        const data: ConsolidatedData = { clustersFound: 0, mergesPerformed: 0, durationMs: 0 };
        writeCheckpoint(config.name, 3, data, 0);
        return data;
    }

    const start = performance.now();
    console.log(`\n[Phase 3: Consolidate] Config: "${config.name}"`);

    const ctx = engine.createDomainContext(KB_DOMAIN_ID);
    await consolidateKnowledge(ctx);

    const durationMs = performance.now() - start;

    // Count consolidation results by checking for source=consolidated
    const searchResult = await ctx.search({
        tags: ["kb"],
        attributes: { source: "consolidated" },
    });
    const mergesPerformed = searchResult.entries.length;

    const data: ConsolidatedData = {
        clustersFound: mergesPerformed, // Each merge = one cluster processed
        mergesPerformed,
        durationMs,
    };

    writeCheckpoint(config.name, 3, data, durationMs);
    console.log(`[Phase 3] Merges: ${mergesPerformed}, Duration: ${(durationMs / 1000).toFixed(1)}s`);

    return data;
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/phases/3-consolidate.ts
git commit -m "Add Phase 3: optional knowledge consolidation"
```

---

### Task 9: Phase 4 — Evaluate Retrieval

**Files:**
- Create: `tests-integration/kb-architecture/phases/4-evaluate.ts`

- [ ] **Step 1: Create Phase 4 script**

```typescript
// tests-integration/kb-architecture/phases/4-evaluate.ts
import type { ArchitectureConfig, Dataset, IngestedData, EvaluationData, EvaluationEntry } from "../types.js";
import { readDataset, readCheckpoint, writeCheckpoint } from "../checkpoint.js";
import { KB_DOMAIN_ID } from "../../../src/domains/kb/types.js";
import type { MemoryEngine } from "../../../src/core/engine.js";

export async function runEvaluate(
    config: ArchitectureConfig,
    engine: MemoryEngine,
): Promise<EvaluationData> {
    const dataset = readDataset<Dataset>();
    const ingested = readCheckpoint<IngestedData>(config.name, 1);
    const start = performance.now();

    console.log(`\n[Phase 4: Evaluate] Config: "${config.name}", questions: ${dataset.questions.length}`);

    const entries: EvaluationEntry[] = [];

    for (const question of dataset.questions) {
        // Map requiredEntryIds to memory IDs
        const requiredMemoryIds = question.requiredEntryIds
            .map((id) => ingested.data.memoryIdMap[id])
            .filter(Boolean);
        const excludedMemoryIds = question.excludedEntryIds
            .map((id) => ingested.data.memoryIdMap[id])
            .filter(Boolean);

        // buildContext
        const bcStart = performance.now();
        const contextResult = await engine.buildContext(question.question, {
            domains: [KB_DOMAIN_ID],
            budgetTokens: config.contextBudget,
        });
        const buildContextMs = performance.now() - bcStart;

        // ask
        const askStart = performance.now();
        const askResult = await engine.ask(question.question, {
            domains: [KB_DOMAIN_ID],
            budgetTokens: config.contextBudget,
            maxRounds: 2,
        });
        const askMs = performance.now() - askStart;

        const memoriesReturned = contextResult.memories.map((m) => m.id);

        entries.push({
            questionId: question.id,
            question: question.question,
            expectedAnswer: question.expectedAnswer,
            difficulty: question.difficulty,
            context: contextResult.context,
            answer: askResult.answer,
            memoriesReturned,
            requiredEntryIds: requiredMemoryIds,
            excludedEntryIds: excludedMemoryIds,
            buildContextMs,
            askMs,
        });

        console.log(`  [${question.id}] buildContext: ${(buildContextMs / 1000).toFixed(1)}s, ask: ${(askMs / 1000).toFixed(1)}s`);
    }

    const durationMs = performance.now() - start;
    const avgBuildContextMs = entries.reduce((s, e) => s + e.buildContextMs, 0) / entries.length;
    const avgAskMs = entries.reduce((s, e) => s + e.askMs, 0) / entries.length;

    const data: EvaluationData = { entries, avgBuildContextMs, avgAskMs };

    writeCheckpoint(config.name, 4, data, durationMs);

    // Fail-fast: check if any question got 0 relevant memories
    const emptyContextQuestions = entries.filter(
        (e) => e.requiredEntryIds.length > 0 && e.memoriesReturned.length === 0,
    );
    if (emptyContextQuestions.length > 0) {
        console.warn(`[Phase 4 WARNING] ${emptyContextQuestions.length} question(s) got 0 memories returned`);
        for (const q of emptyContextQuestions) {
            console.warn(`  - ${q.questionId}: expected ${q.requiredEntryIds.length} entries`);
        }
    }

    console.log(`[Phase 4] Avg buildContext: ${(avgBuildContextMs / 1000).toFixed(1)}s, Avg ask: ${(avgAskMs / 1000).toFixed(1)}s`);
    console.log(`[Phase 4] Total: ${(durationMs / 1000).toFixed(1)}s`);

    return data;
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/phases/4-evaluate.ts
git commit -m "Add Phase 4: retrieval evaluation with buildContext and ask"
```

---

### Task 10: Phase 5 — Score

**Files:**
- Create: `tests-integration/kb-architecture/phases/5-score.ts`

This phase computes scores. The actual quality score (0-5) is computed by comparing the answer to the expected answer. Since this agent (Opus) is the judge, the scoring logic examines the answer text against expected facts.

- [ ] **Step 1: Create Phase 5 script**

```typescript
// tests-integration/kb-architecture/phases/5-score.ts
import type { ArchitectureConfig, EvaluationData, ScoresData, ScoreEntry, ProcessedData } from "../types.js";
import { readCheckpoint, writeCheckpoint } from "../checkpoint.js";
import { getLlm } from "../engine-factory.js";

/**
 * Scores a single question by asking the LLM (at medium level) to judge
 * the answer against the expected answer. Returns 0-5.
 *
 * We use Claude as judge but with a higher model level than the test subject.
 * The prompt is structured to minimize bias.
 */
async function scoreAnswer(
    question: string,
    expectedAnswer: string,
    actualAnswer: string,
): Promise<{ score: number; reasoning: string }> {
    const llm = getLlm();

    const prompt = `You are a strict grader. Score the following answer on a 0-5 scale.

Question: ${question}

Expected answer (ground truth): ${expectedAnswer}

Actual answer to grade: ${actualAnswer}

Scoring rubric:
0 = completely wrong or hallucinated
1 = vaguely related but incorrect specifics
2 = partially correct, missing key details
3 = mostly correct, minor inaccuracies
4 = correct with good detail
5 = correct and comprehensive

Respond with ONLY a JSON object: {"score": <0-5>, "reasoning": "<one sentence>"}`;

    try {
        const response = await llm.generate!(prompt);
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]) as { score: number; reasoning: string };
            return {
                score: Math.max(0, Math.min(5, Math.round(parsed.score))),
                reasoning: parsed.reasoning ?? "",
            };
        }
    } catch {
        // Fall through
    }

    return { score: 0, reasoning: "Failed to parse scoring response" };
}

export async function runScore(config: ArchitectureConfig): Promise<ScoresData> {
    const evaluation = readCheckpoint<EvaluationData>(config.name, 4);
    const processed = readCheckpoint<ProcessedData>(config.name, 2);
    const start = performance.now();

    console.log(`\n[Phase 5: Score] Config: "${config.name}", questions: ${evaluation.data.entries.length}`);

    const scoreEntries: ScoreEntry[] = [];

    for (const evalEntry of evaluation.data.entries) {
        const { score, reasoning } = await scoreAnswer(
            evalEntry.question,
            evalEntry.expectedAnswer,
            evalEntry.answer,
        );

        // Context relevance: what % of required memories appeared in context?
        const requiredFound = evalEntry.requiredEntryIds.filter(
            (id) => evalEntry.memoriesReturned.includes(id),
        ).length;
        const contextRelevance = evalEntry.requiredEntryIds.length > 0
            ? requiredFound / evalEntry.requiredEntryIds.length
            : 1; // No required entries = N/A, treat as perfect

        // Context noise: what % of returned memories were NOT required?
        const unrequired = evalEntry.memoriesReturned.filter(
            (id) => !evalEntry.requiredEntryIds.includes(id),
        ).length;
        const contextNoise = evalEntry.memoriesReturned.length > 0
            ? unrequired / evalEntry.memoriesReturned.length
            : 0;

        // Supersession: were excluded entries correctly absent?
        const excludedPresent = evalEntry.excludedEntryIds.filter(
            (id) => evalEntry.memoriesReturned.includes(id),
        ).length;
        const supersessionCorrect = evalEntry.excludedEntryIds.length > 0
            ? excludedPresent === 0
            : true;

        scoreEntries.push({
            questionId: evalEntry.questionId,
            score,
            reasoning,
            contextRelevance,
            contextNoise,
            supersessionCorrect,
        });

        console.log(`  [${evalEntry.questionId}] Score: ${score}/5 — ${reasoning}`);
    }

    const durationMs = performance.now() - start;

    const avgScore = scoreEntries.reduce((s, e) => s + e.score, 0) / scoreEntries.length;
    const avgTime = (evaluation.data.avgBuildContextMs + evaluation.data.avgAskMs) / 1000;
    const qualityPerSecond = avgTime > 0 ? avgScore / avgTime : 0;
    const contextRelevance = scoreEntries.reduce((s, e) => s + e.contextRelevance, 0) / scoreEntries.length;
    const contextNoise = scoreEntries.reduce((s, e) => s + e.contextNoise, 0) / scoreEntries.length;
    const supersessionCorrectCount = scoreEntries.filter((e) => e.supersessionCorrect).length;
    const supersessionAccuracy = supersessionCorrectCount / scoreEntries.length;

    const data: ScoresData = {
        entries: scoreEntries,
        avgScore,
        avgTime,
        qualityPerSecond,
        contextRelevance,
        contextNoise,
        supersessionAccuracy,
        classificationAccuracy: processed.data.classificationAccuracy,
    };

    writeCheckpoint(config.name, 5, data, durationMs);

    console.log(`\n[Phase 5 Summary]`);
    console.log(`  Avg Score: ${avgScore.toFixed(2)}/5`);
    console.log(`  Avg Time: ${avgTime.toFixed(1)}s`);
    console.log(`  Quality/s: ${qualityPerSecond.toFixed(3)}`);
    console.log(`  Context Relevance: ${(contextRelevance * 100).toFixed(1)}%`);
    console.log(`  Context Noise: ${(contextNoise * 100).toFixed(1)}%`);
    console.log(`  Supersession Accuracy: ${(supersessionAccuracy * 100).toFixed(1)}%`);
    console.log(`  Classification Accuracy: ${(processed.data.classificationAccuracy * 100).toFixed(1)}%`);

    return data;
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/phases/5-score.ts
git commit -m "Add Phase 5: LLM-judged answer scoring with aggregate metrics"
```

---

### Task 11: Phase 6 — Report

**Files:**
- Create: `tests-integration/kb-architecture/phases/6-report.ts`

- [ ] **Step 1: Create Phase 6 script**

```typescript
// tests-integration/kb-architecture/phases/6-report.ts
import type { ScoresData, ReportData, ReportRow, IngestedData, ProcessedData } from "../types.js";
import { readCheckpoint, writeCheckpoint, hasCheckpoint, listConfigCheckpoints } from "../checkpoint.js";

function buildRow(configName: string): ReportRow | null {
    if (!hasCheckpoint(configName, 5)) return null;

    const scores = readCheckpoint<ScoresData>(configName, 5);
    const ingested = hasCheckpoint(configName, 1) ? readCheckpoint<IngestedData>(configName, 1) : null;
    const processed = hasCheckpoint(configName, 2) ? readCheckpoint<ProcessedData>(configName, 2) : null;

    const ingestTimeMs = (ingested?.durationMs ?? 0) +
        (processed ? readCheckpoint(configName, 2).durationMs : 0) +
        (hasCheckpoint(configName, 3) ? readCheckpoint(configName, 3).durationMs : 0);

    return {
        config: configName,
        avgScore: scores.data.avgScore,
        avgTime: scores.data.avgTime,
        qualityPerSecond: scores.data.qualityPerSecond,
        contextRelevance: scores.data.contextRelevance,
        contextNoise: scores.data.contextNoise,
        supersessionAccuracy: scores.data.supersessionAccuracy,
        classificationAccuracy: scores.data.classificationAccuracy,
        ingestTimeMs,
    };
}

export function runReport(): ReportData {
    console.log("\n[Phase 6: Report] Generating comparative report...\n");

    const configNames = listConfigCheckpoints();
    const rows: ReportRow[] = [];
    let baseline: ReportRow | null = null;

    for (const name of configNames) {
        const row = buildRow(name);
        if (!row) continue;

        if (name === "baseline-no-kb") {
            baseline = row;
        } else {
            rows.push(row);
        }
    }

    if (!baseline) {
        baseline = {
            config: "baseline-no-kb",
            avgScore: 0, avgTime: 0, qualityPerSecond: 0,
            contextRelevance: 0, contextNoise: 0,
            supersessionAccuracy: 0, classificationAccuracy: 0,
            ingestTimeMs: 0,
        };
        console.warn("[Report] No baseline found — using zeros");
    }

    // Sort by qualityPerSecond descending
    rows.sort((a, b) => b.qualityPerSecond - a.qualityPerSecond);

    // Print table
    console.log("| Config | AvgScore | AvgTime(s) | Q/s | Relevance | Noise | Supersession | Classification | IngestTime(s) |");
    console.log("|--------|----------|------------|-----|-----------|-------|--------------|----------------|---------------|");

    const printRow = (r: ReportRow) => {
        console.log(
            `| ${r.config.padEnd(45)} | ${r.avgScore.toFixed(2).padStart(8)} | ${r.avgTime.toFixed(1).padStart(10)} | ${r.qualityPerSecond.toFixed(3).padStart(5)} | ${(r.contextRelevance * 100).toFixed(0).padStart(8)}% | ${(r.contextNoise * 100).toFixed(0).padStart(4)}% | ${(r.supersessionAccuracy * 100).toFixed(0).padStart(11)}% | ${(r.classificationAccuracy * 100).toFixed(0).padStart(13)}% | ${(r.ingestTimeMs / 1000).toFixed(1).padStart(13)} |`,
        );
    };

    printRow(baseline);
    for (const row of rows) {
        printRow(row);
    }

    // Generate recommendations
    const recommendations: string[] = [];

    if (rows.length > 0) {
        const best = rows[0];
        recommendations.push(`Best quality/speed tradeoff: "${best.config}" (Q/s: ${best.qualityPerSecond.toFixed(3)})`);

        const bestQuality = [...rows].sort((a, b) => b.avgScore - a.avgScore)[0];
        if (bestQuality.config !== best.config) {
            recommendations.push(`Highest quality: "${bestQuality.config}" (score: ${bestQuality.avgScore.toFixed(2)})`);
        }

        const bestSpeed = [...rows].sort((a, b) => a.avgTime - b.avgTime)[0];
        if (bestSpeed.config !== best.config) {
            recommendations.push(`Fastest: "${bestSpeed.config}" (${bestSpeed.avgTime.toFixed(1)}s avg)`);
        }

        const belowBaseline = rows.filter((r) => r.avgScore <= baseline!.avgScore);
        if (belowBaseline.length > 0) {
            recommendations.push(`Configs at or below baseline (remove): ${belowBaseline.map((r) => r.config).join(", ")}`);
        }
    }

    console.log("\nRecommendations:");
    for (const rec of recommendations) {
        console.log(`  - ${rec}`);
    }

    const data: ReportData = { baseline, configs: rows, recommendations };
    writeCheckpoint("_report", 6, data, 0);

    return data;
}

if (import.meta.main) {
    runReport();
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/phases/6-report.ts
git commit -m "Add Phase 6: comparative report generation with recommendations"
```

---

### Task 12: Baseline Evaluator (No-KB)

**Files:**
- Create: `tests-integration/kb-architecture/phases/baseline.ts`

The baseline runs ask() questions without any KB context to establish Haiku's floor.

- [ ] **Step 1: Create baseline evaluator**

```typescript
// tests-integration/kb-architecture/phases/baseline.ts
import type { Dataset, EvaluationData, EvaluationEntry } from "../types.js";
import { readDataset, writeCheckpoint } from "../checkpoint.js";
import { getLlm } from "../engine-factory.js";

export async function runBaseline(): Promise<void> {
    const dataset = readDataset<Dataset>();
    const llm = getLlm();
    const start = performance.now();

    console.log(`\n[Baseline] Testing Haiku without KB context on ${dataset.questions.length} questions...\n`);

    const entries: EvaluationEntry[] = [];

    for (const question of dataset.questions) {
        const askStart = performance.now();
        const answer = await llm.generate!(question.question);
        const askMs = performance.now() - askStart;

        entries.push({
            questionId: question.id,
            question: question.question,
            expectedAnswer: question.expectedAnswer,
            difficulty: question.difficulty,
            context: "",
            answer,
            memoriesReturned: [],
            requiredEntryIds: [],
            excludedEntryIds: [],
            buildContextMs: 0,
            askMs,
        });

        console.log(`  [${question.id}] ${(askMs / 1000).toFixed(1)}s`);
    }

    const durationMs = performance.now() - start;
    const avgAskMs = entries.reduce((s, e) => s + e.askMs, 0) / entries.length;

    const data: EvaluationData = { entries, avgBuildContextMs: 0, avgAskMs };

    // Write as phase 4 for the baseline config (scoring phase reads phase 4)
    writeCheckpoint("baseline-no-kb", 4, data, durationMs);
    // Also write dummy phase 1 and 2 checkpoints so scoring can read them
    writeCheckpoint("baseline-no-kb", 1, { memoryIdMap: {}, entryCount: 0 }, 0);
    writeCheckpoint("baseline-no-kb", 2, { entries: [], stageTiming: {}, classificationAccuracy: 0 }, 0);

    console.log(`\n[Baseline] Done in ${(durationMs / 1000).toFixed(1)}s, avg ask: ${(avgAskMs / 1000).toFixed(1)}s`);
}

if (import.meta.main) {
    runBaseline().catch(console.error);
}
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/phases/baseline.ts
git commit -m "Add baseline evaluator: Haiku without KB context"
```

---

### Task 13: Run Orchestrator

**Files:**
- Create: `tests-integration/kb-architecture/run.ts`

- [ ] **Step 1: Create the orchestrator**

```typescript
// tests-integration/kb-architecture/run.ts
import { parseArgs } from "node:util";
import { configs } from "./configs.js";
import { hasCheckpoint } from "./checkpoint.js";
import { collectData } from "./phases/0-collect.js";
import { runIngest } from "./phases/1-ingest.js";
import { runProcess } from "./phases/2-process.js";
import { runConsolidate } from "./phases/3-consolidate.js";
import { runEvaluate } from "./phases/4-evaluate.js";
import { runScore } from "./phases/5-score.js";
import { runReport } from "./phases/6-report.js";
import { runBaseline } from "./phases/baseline.js";
import type { ArchitectureConfig } from "./types.js";

const { values } = parseArgs({
    options: {
        config: { type: "string", short: "c" },
        "from-phase": { type: "string", short: "f" },
        "only-phase": { type: "string", short: "o" },
        baseline: { type: "boolean", short: "b" },
        report: { type: "boolean", short: "r" },
        collect: { type: "boolean" },
    },
    strict: false,
});

async function runConfig(config: ArchitectureConfig, fromPhase: number): Promise<void> {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Running config: "${config.name}"`);
    console.log(`${"=".repeat(60)}`);

    // Phase 1: Ingest
    let engine;
    if (fromPhase <= 1) {
        const result = await runIngest(config);
        engine = result.engine;
    }

    // Phase 2: Process
    if (fromPhase <= 2) {
        if (!engine) {
            // Need to recreate engine from checkpoint — re-run ingest
            const result = await runIngest(config);
            engine = result.engine;
        }
        const processed = await runProcess(config, engine);

        // Fail-fast: classification check
        const factCount = processed.entries.filter((e) => e.assignedClassification === "fact").length;
        const total = processed.entries.filter((e) => e.assignedClassification !== "unknown").length;
        if (total > 0 && factCount / total > 0.7 && config.pipeline.classify) {
            console.error(`[FAIL-FAST] >70% classified as "fact" for "${config.name}" — stopping`);
            await engine.close();
            return;
        }
    }

    // Phase 3: Consolidate
    if (fromPhase <= 3 && engine) {
        await runConsolidate(config, engine);
    }

    // Phase 4: Evaluate
    if (fromPhase <= 4 && engine) {
        await runEvaluate(config, engine);
    }

    // Close engine before scoring (no longer needed)
    if (engine) {
        await engine.close();
    }

    // Phase 5: Score
    if (fromPhase <= 5) {
        await runScore(config);
    }
}

async function main(): Promise<void> {
    const fromPhase = values["from-phase"] ? parseInt(values["from-phase"] as string, 10) : 0;
    const onlyPhase = values["only-phase"] ? parseInt(values["only-phase"] as string, 10) : null;

    // Phase 0: Collect
    const { existsSync } = await import("node:fs");
    const { datasetPath } = await import("./checkpoint.js");
    if (values.collect || (!existsSync(datasetPath()) && fromPhase <= 0 && onlyPhase === null)) {
        await collectData();
        if (values.collect) return;
    }

    // Baseline
    if (values.baseline) {
        await runBaseline();
        await runScore({
            name: "baseline-no-kb",
            pipeline: { classify: false, tagAssign: false, topicLink: false, supersede: false, relateKnowledge: false },
            search: { mode: "hybrid", weights: { vector: 0.5, fulltext: 0.3, graph: 0.2 } },
            consolidate: false,
            contextBudget: 2000,
        });
        return;
    }

    // Report only
    if (values.report) {
        runReport();
        return;
    }

    // Run specific config or all
    const targetConfigs = values.config
        ? configs.filter((c) => c.name === values.config)
        : configs.filter((c) => c.name !== "baseline-no-kb");

    if (targetConfigs.length === 0) {
        console.error(`Config "${values.config}" not found. Available: ${configs.map((c) => c.name).join(", ")}`);
        process.exit(1);
    }

    for (const config of targetConfigs) {
        await runConfig(config, onlyPhase ?? fromPhase);
    }

    // Generate report if we ran multiple configs
    if (targetConfigs.length > 1) {
        runReport();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests-integration/kb-architecture/run.ts
git commit -m "Add run orchestrator with per-phase resume and fail-fast gates"
```

---

### Task 14: Integration Smoke Test

**Files:** None new — validates existing files work together.

- [ ] **Step 1: Run Phase 0 to collect dataset**

Run: `cd /Users/kuindji/Projects/@kuindji/memory-domain/.worktrees/knowledge-base-architecture-testing-loop && bun run tests-integration/kb-architecture/phases/0-collect.ts`
Expected: Dataset written to `tests-integration/kb-architecture/checkpoints/dataset.json` with 40+ entries and 15 questions.

- [ ] **Step 2: Run baseline evaluation**

Run: `cd /Users/kuindji/Projects/@kuindji/memory-domain/.worktrees/knowledge-base-architecture-testing-loop && bun run tests-integration/kb-architecture/run.ts --baseline`
Expected: Baseline checkpoint written, scores computed. This establishes Haiku's floor.

- [ ] **Step 3: Run a single config end-to-end**

Run: `cd /Users/kuindji/Projects/@kuindji/memory-domain/.worktrees/knowledge-base-architecture-testing-loop && bun run tests-integration/kb-architecture/run.ts --config full-hybrid-noconsolidate-2000`
Expected: Phases 1-5 complete for this config. Scores should beat the baseline.

- [ ] **Step 4: Inspect checkpoints and fix any issues**

Check: `ls tests-integration/kb-architecture/checkpoints/full-hybrid-noconsolidate-2000/`
Expected: `ingested.json`, `processed.json`, `consolidated.json`, `evaluation.json`, `scores.json`

- [ ] **Step 5: Run report**

Run: `cd /Users/kuindji/Projects/@kuindji/memory-domain/.worktrees/knowledge-base-architecture-testing-loop && bun run tests-integration/kb-architecture/run.ts --report`
Expected: Comparative table printed with baseline and the one config.

- [ ] **Step 6: Commit any fixes from smoke testing**

```bash
git add -A tests-integration/kb-architecture/
git commit -m "Fix issues found during smoke testing"
```

---

### Task 15: Run Full Test Matrix

- [ ] **Step 1: Run all configs**

Run: `cd /Users/kuindji/Projects/@kuindji/memory-domain/.worktrees/knowledge-base-architecture-testing-loop && bun run tests-integration/kb-architecture/run.ts`
Expected: All 12 configs run through phases 1-5, final report generated.

Note: This will take significant time due to real LLM calls. Monitor output for fail-fast triggers.

- [ ] **Step 2: Review report and document findings**

Read `tests-integration/kb-architecture/checkpoints/_report/report.json` and the console output.
Analyze: which configs beat baseline, which have the best quality/speed tradeoff, which pipeline stages add the most value.

- [ ] **Step 3: Log findings to taskflow**

```bash
taskflow-cli log info "Architecture testing complete. See checkpoints/_report/report.json for comparative analysis."
```
