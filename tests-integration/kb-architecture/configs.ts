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
        pipeline: {
            classify: false,
            tagAssign: false,
            topicLink: false,
            supersede: false,
            relateKnowledge: false,
        },
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
        pipeline: {
            classify: true,
            tagAssign: true,
            topicLink: false,
            supersede: false,
            relateKnowledge: false,
        },
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
